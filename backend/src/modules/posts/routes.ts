import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { authenticate, optionalAuthenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { ApiError } from '../../http/errors.js';
import {
  Permission,
  roleHasPermission,
  type Principal,
} from '../../auth/permissions.js';
import { principalSeesPlace, placeScope } from '../../auth/scope.js';
import { recordAudit } from '../../security/audit.js';
import { notify } from '../notifications/service.js';

/**
 * /api/posts — party communications.
 *
 * One table, several desks:
 *   • news / press_release / statement  — what the party says
 *   • highlight                         — wins worth amplifying
 *   • community_note / service_delivery — reports FROM the community
 *     (water, power, roads…). These are moderation targets: an officer with
 *     post:moderate can take one down, which records a reason, an audit entry
 *     and a notification instead of silently deleting it.
 *
 * Published posts are public; drafts and taken-down posts are only visible to
 * moderators, which is why listing uses optional authentication.
 */
export const postsRouter = Router();

const PostKind = z.enum([
  'news',
  'press_release',
  'highlight',
  'statement',
  'community_note',
  'service_delivery',
]);
const PostStatus = z.enum(['draft', 'published', 'taken_down']);

const canModerate = (p?: Principal) =>
  !!p && roleHasPermission(p.role, Permission.POST_MODERATE);

const listQuery = z.object({
  kind: PostKind.optional(),
  regionCode: z.string().max(32).optional(),
  ward: z.string().max(64).optional(),
  serviceArea: z.string().max(32).optional(),
  status: PostStatus.or(z.literal('all')).default('published'),
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

const writeSchema = z.object({
  kind: PostKind.default('news'),
  title: z.string().min(1).max(200),
  excerpt: z.string().max(400).optional(),
  body: z.string().max(20000).default(''),
  regionCode: z.string().max(32).optional(),
  ward: z.string().max(64).optional(),
  author: z.string().max(120).optional(),
  serviceArea: z
    .enum(['water', 'power', 'roads', 'health', 'education', 'sanitation', 'housing', 'other'])
    .optional(),
  severity: z.enum(['info', 'report', 'urgent']).optional(),
  status: PostStatus.default('published'),
});
const updateSchema = writeSchema.partial();
const takeDownSchema = z.object({ reason: z.string().min(3).max(500) });

interface Row {
  id: string;
  kind: string;
  title: string;
  excerpt: string | null;
  body: string;
  region_code: string | null;
  ward: string | null;
  author: string | null;
  service_area: string | null;
  severity: string | null;
  status: string;
  take_down_reason: string | null;
  taken_down_at: string | null;
  published_at: string;
  created_at: string;
  updated_at: string;
}

const COLS = `id, kind, title, excerpt, body, region_code, ward, author,
       service_area, severity, status, take_down_reason, taken_down_at,
       published_at, created_at, updated_at`;
const SELECT = `SELECT ${COLS} FROM posts`;

const toView = (r: Row) => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  excerpt: r.excerpt,
  body: r.body,
  regionCode: r.region_code,
  ward: r.ward,
  author: r.author,
  serviceArea: r.service_area,
  severity: r.severity,
  status: r.status,
  takeDownReason: r.take_down_reason,
  takenDownAt: r.taken_down_at,
  publishedAt: r.published_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

async function load(id: string): Promise<Row> {
  const r = await query<Row>(`${SELECT} WHERE id = $1`, [id]);
  if (!r.rows[0]) throw ApiError.notFound('Post not found');
  return r.rows[0]!;
}

async function assertScope(
  p: Principal,
  place: { regionCode?: string | null; region_code?: string | null; ward?: string | null },
): Promise<void> {
  const regionCode = place.regionCode ?? place.region_code ?? null;
  if (!(await principalSeesPlace(p, { regionCode, ward: place.ward ?? null }))) {
    throw ApiError.forbidden('Post outside your authorized scope');
  }
}

// LIST — public for published posts; moderators can page through the drafts and
// take-downs of their OWN territory.
postsRouter.get(
  '/',
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    /**
     * Territory predicate for this place-bearing table, with its parameters
     * appended in order. Empty string ⇒ national scope, i.e. no restriction.
     */
    const placePredicate = async (p: Principal): Promise<string> => {
      const scope = await placeScope(
        p,
        { regionColumn: 'region_code', wardColumn: 'ward' },
        params.length + 1,
      );
      for (const v of scope.params) params.push(v);
      return scope.sql ? scope.sql.replace(/^\s*AND\s+/i, '').trim() : '';
    };

    const moderator = canModerate(req.principal);
    // D41 — `q.status` used to be honoured verbatim for every caller. `?status=draft`
    // therefore returned every unpublished post in the country to an ANONYMOUS
    // visitor, and `?status=taken_down` returned the moderation reasons with them,
    // even though the branch was commented "Non-moderators only ever see published
    // material". A query string is not an authorization decision: the status filter
    // is clamped to what this principal may actually see.
    //
    // A moderator's extra reach is TERRITORIAL, not global — a regional organizer
    // holds `post:moderate` for their own subcouncils, not for another province's
    // internal communications. But territory must not be applied to the published
    // rows: publication is what makes civic content public, so `status=all` is
    // "everything published, anywhere" plus "unpublished, in my territory".
    // Constraining the whole query to territory instead — the first attempt at this
    // fix — silently hid other regions' PUBLISHED posts from the organizer's own
    // newsroom, which probe D9 caught.
    if (q.status === 'published') {
      add('status = ?', 'published');
    } else if (!moderator) {
      // Asked for draft/taken_down/all without the permission. An empty published
      // set is the answer for `all`; for an explicit non-public status there is
      // nothing this caller may see at all. 200-with-no-rows rather than 403 keeps
      // the public endpoint from becoming an oracle about what exists.
      if (q.status === 'all') add('status = ?', 'published');
      else where.push('FALSE');
    } else if (q.status === 'all') {
      const inTerritory = await placePredicate(req.principal!);
      where.push(inTerritory ? `(status = 'published' OR ${inTerritory})` : 'TRUE');
    } else {
      add('status = ?', q.status);
      const inTerritory = await placePredicate(req.principal!);
      if (inTerritory) where.push(inTerritory);
    }
    if (q.kind) add('kind = ?', q.kind);
    if (q.regionCode) add('region_code = ?', q.regionCode);
    if (q.ward) add('ward = ?', q.ward);
    if (q.serviceArea) add('service_area = ?', q.serviceArea);
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(title ILIKE $${params.length} OR body ILIKE $${params.length})`);
    }

    const filterCount = params.length;
    params.push(q.limit, q.offset);

    // A national-scope moderator paging `status=all` with no other filter adds no
    // predicate at all, and `WHERE` with nothing after it is a syntax error.
    const whereSql = where.length ? where.join(' AND ') : 'TRUE';

    const rows = await query<Row>(
      `${SELECT}
       WHERE ${whereSql}
       ORDER BY published_at DESC, created_at DESC
       LIMIT $${filterCount + 1} OFFSET $${filterCount + 2}`,
      params,
    );
    const countRes = await query<{ c: string }>(
      `SELECT count(*)::text AS c FROM posts WHERE ${whereSql}`,
      params.slice(0, filterCount),
    );

    res.json({
      items: rows.rows.map(toView),
      total: Number(countRes.rows[0]?.c ?? 0),
      limit: q.limit,
      offset: q.offset,
    });
  }),
);

// READ (single).
postsRouter.get(
  '/:id',
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const row = await load(req.params.id!);
    if (row.status !== 'published') {
      // D41 — a draft or taken-down post is visible to a moderator ONLY inside
      // their own territory. This previously tested `canModerate()` alone, so any
      // `post:moderate` holder could read every unpublished post in the country by
      // id, together with its take-down reason. `load()` already 404s on a missing
      // row, and the same 404 is returned here, so this is not an existence oracle.
      const p = req.principal;
      const allowed =
        !!p &&
        canModerate(p) &&
        (await principalSeesPlace(p, { regionCode: row.region_code, ward: row.ward }));
      if (!allowed) throw ApiError.notFound('Post not found');
    }
    res.json(toView(row));
  }),
);

// ── Authenticated writes ─────────────────────────────────────────
postsRouter.use(authenticate);

postsRouter.post(
  '/',
  requirePermission(Permission.POST_WRITE),
  asyncHandler(async (req, res) => {
    const input = writeSchema.parse(req.body);
    const p = req.principal!;
    // A ward-scoped official always posts into their own ward unless they name
    // one explicitly; an explicit ward is then checked against their territory.
    // This replaces `requireRegionInScope`, which only ever looked at the region
    // and so let a `local_coordinator` tag a post with a neighbouring ward.
    const ward = input.ward ?? p.wardCode ?? null;
    await assertScope(p, { regionCode: input.regionCode ?? null, ward });

    const r = await query<Row>(
      `INSERT INTO posts (kind, title, excerpt, body, region_code, ward, author,
                          service_area, severity, status, published_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), $11)
       RETURNING ${COLS}`,
      [
        input.kind,
        input.title,
        input.excerpt ?? null,
        input.body,
        input.regionCode ?? null,
        ward,
        input.author ?? 'UDF Communications',
        input.serviceArea ?? null,
        input.severity ?? null,
        input.status,
        p.sub,
      ],
    );
    const post = toView(r.rows[0]!);

    await recordAudit({
      action: 'post.create',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'post',
      targetId: post.id,
      regionCode: post.regionCode,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { kind: post.kind, status: post.status },
    });

    if (post.status === 'published') {
      await notify({
        kind: 'post',
        title: post.title,
        body: post.excerpt ?? post.body.slice(0, 160),
        link: `tab:more#posts:${post.id}`,
        regionCode: post.regionCode,
      });
    }

    res.status(201).json(post);
  }),
);

postsRouter.patch(
  '/:id',
  requirePermission(Permission.POST_WRITE),
  asyncHandler(async (req, res) => {
    const input = updateSchema.parse(req.body);
    const p = req.principal!;
    const before = await load(req.params.id!);
    await assertScope(p, before);
    // Re-targeting a post is a write into the NEW place, so the destination is
    // checked as well — otherwise a ward official could move their own post into
    // a neighbouring ward and have it published there.
    if (input.regionCode !== undefined || input.ward !== undefined) {
      await assertScope(p, {
        regionCode: input.regionCode !== undefined ? input.regionCode : before.region_code,
        ward: input.ward !== undefined ? input.ward : before.ward,
      });
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (input.kind !== undefined) add('kind', input.kind);
    if (input.title !== undefined) add('title', input.title);
    if (input.excerpt !== undefined) add('excerpt', input.excerpt ?? null);
    if (input.body !== undefined) add('body', input.body);
    if (input.regionCode !== undefined) add('region_code', input.regionCode ?? null);
    if (input.ward !== undefined) add('ward', input.ward ?? null);
    if (input.author !== undefined) add('author', input.author ?? null);
    if (input.serviceArea !== undefined) add('service_area', input.serviceArea ?? null);
    if (input.severity !== undefined) add('severity', input.severity ?? null);
    if (input.status !== undefined) {
      add('status', input.status);
      if (input.status === 'published') sets.push('published_at = now()');
    }
    if (!sets.length) throw ApiError.badRequest('No fields to update');

    params.push(req.params.id);
    const r = await query<Row>(
      `UPDATE posts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${COLS}`,
      params,
    );
    const post = toView(r.rows[0]!);

    await recordAudit({
      action: 'post.update',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'post',
      targetId: post.id,
      regionCode: post.regionCode,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { fields: Object.keys(input) },
    });
    res.json(post);
  }),
);

// TAKE DOWN — moderation of a community note / service-delivery report.
postsRouter.post(
  '/:id/take-down',
  requirePermission(Permission.POST_MODERATE),
  asyncHandler(async (req, res) => {
    const { reason } = takeDownSchema.parse(req.body);
    const p = req.principal!;
    const before = await load(req.params.id!);
    await assertScope(p, before);

    const r = await query<Row>(
      `UPDATE posts
          SET status = 'taken_down', take_down_reason = $1,
              taken_down_at = now(), taken_down_by = $2
        WHERE id = $3
        RETURNING ${COLS}`,
      [reason, p.sub, req.params.id],
    );
    const post = toView(r.rows[0]!);

    await recordAudit({
      action: 'post.take_down',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'post',
      targetId: post.id,
      regionCode: post.regionCode,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { kind: post.kind, reason },
    });

    await notify({
      kind: 'alert',
      title: `Community note taken down`,
      body: `${post.title} — ${reason}`,
      link: `tab:more#posts`,
      regionCode: post.regionCode,
      audience: 'staff',
    });

    res.json(post);
  }),
);

postsRouter.post(
  '/:id/restore',
  requirePermission(Permission.POST_MODERATE),
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const before = await load(req.params.id!);
    await assertScope(p, before);

    const r = await query<Row>(
      `UPDATE posts
          SET status = 'published', take_down_reason = NULL,
              taken_down_at = NULL, taken_down_by = NULL, published_at = now()
        WHERE id = $1
        RETURNING ${COLS}`,
      [req.params.id],
    );
    const post = toView(r.rows[0]!);

    await recordAudit({
      action: 'post.restore',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'post',
      targetId: post.id,
      regionCode: post.regionCode,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json(post);
  }),
);

postsRouter.delete(
  '/:id',
  requirePermission(Permission.POST_MODERATE),
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const before = await load(req.params.id!);
    await assertScope(p, before);

    await query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    await recordAudit({
      action: 'post.delete',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'post',
      targetId: req.params.id,
      regionCode: before.region_code,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { kind: before.kind },
    });
    res.status(204).end();
  }),
);
