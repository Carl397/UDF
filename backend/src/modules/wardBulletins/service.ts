import { query } from '../../db/pool.js';
import { recordAudit } from '../../security/audit.js';
import { ApiError } from '../../http/errors.js';
import type { Principal } from '../../auth/permissions.js';
import { canSeeUnpublished, principalSeesWard, publishedOrInTerritory } from '../../auth/scope.js';
import type { z } from 'zod';
import type { createBulletinSchema, updateBulletinSchema } from './schemas.js';

export interface WardBulletin {
  id: string;
  wardCode: string;
  /**
   * Optional link to the member record the bulletin is issued against. NULL for
   * bulletins created through the API: the schema has no user→member link, so
   * the author is recorded in `created_by` (migration 014).
   */
  councillorMemberId: string | null;
  kind: string;
  title: string;
  body: string | null;
  status: string;
  publishedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  /** True when a dedicated cover image is set (its bytes are served separately). */
  hasCover: boolean;
}

const BULLETIN_FIELDS = `id, ward_code AS "wardCode", councillor_member_id AS "councillorMemberId",
            kind, title, body, status, published_at AS "publishedAt",
            (cover_media_id IS NOT NULL) AS "hasCover",
            created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function createBulletin(
  input: z.infer<typeof createBulletinSchema>,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<WardBulletin> {
  const wardCode = input.wardCode ?? principal.wardCode;
  if (!wardCode) throw ApiError.badRequest('wardCode is required to create a bulletin');
  // A bulletin is published communication to a ward's residents. Without this
  // check any `bulletin:write` holder could publish into ANY ward in the country
  // simply by naming it in the body — `input.wardCode` was accepted unchecked.
  if (!(await principalSeesWard(principal, wardCode))) {
    throw ApiError.forbidden('Ward outside your authorized scope');
  }

  // `created_by` is the accountable author. `councillor_member_id` stays NULL:
  // there is no user→member link in the schema, and the previous
  // `SELECT id FROM members WHERE created_by = <user>` guess failed the NOT NULL
  // constraint for every role that had not enrolled a member (500 on publish)
  // and, when it did match, credited the bulletin to an unrelated member.
  const res = await query<WardBulletin>(
    `INSERT INTO ward_bulletins (ward_code, kind, title, body,
            service_request_id, public_participation_id, project_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${BULLETIN_FIELDS}`,
    [wardCode, input.kind, input.title, input.body ?? null,
     input.serviceRequestId ?? null, input.publicParticipationId ?? null,
     input.projectId ?? null, principal.sub],
  );

  if (res.rowCount === 0) throw ApiError.internal('Failed to create bulletin');
  const bulletin = res.rows[0]!;

  await recordAudit({
    action: 'bulletin.create',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'ward_bulletins',
    targetId: bulletin.id,
    metadata: { title: bulletin.title, wardCode, kind: bulletin.kind },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return bulletin;
}

export async function updateBulletin(
  id: string,
  input: z.infer<typeof updateBulletinSchema>,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<WardBulletin> {
  // Territory check BEFORE the write. This route previously ran the UPDATE
  // against the bare id, so any `bulletin:write` holder could edit or re-publish
  // any bulletin in any ward — and a miss on the id surfaced as a 500 rather
  // than a 404.
  const existing = await getBulletin(id);
  if (!existing) throw ApiError.notFound('Bulletin not found');
  if (!(await principalSeesWard(principal, existing.wardCode))) {
    throw ApiError.forbidden('Bulletin belongs to another ward');
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.title !== undefined) { setClauses.push(`title = $${idx++}`); values.push(input.title); }
  if (input.body !== undefined) { setClauses.push(`body = $${idx++}`); values.push(input.body); }
  if (input.status !== undefined) { setClauses.push(`status = $${idx++}`); values.push(input.status); }

  if (setClauses.length === 0) return existing;

  setClauses.push(`updated_at = now()`);
  values.push(id);

  const res = await query<WardBulletin>(
    `UPDATE ward_bulletins SET ${setClauses.join(', ')}
     WHERE id = $${idx}
     RETURNING ${BULLETIN_FIELDS}`,
    values,
  );

  if (res.rowCount === 0) throw ApiError.notFound('Bulletin not found');
  const bulletin = res.rows[0]!;

  await recordAudit({
    action: 'bulletin.update',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'ward_bulletins',
    targetId: id,
    metadata: input as Record<string, unknown>,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return bulletin;
}

export async function getBulletin(id: string): Promise<WardBulletin | null> {
  const res = await query<WardBulletin>(
    `SELECT ${BULLETIN_FIELDS} FROM ward_bulletins WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

/**
 * One bulletin, gated exactly as the list is.
 *
 * `GET /:id` previously called `getBulletin` with no principal at all, so any
 * holder of `bulletin:read` — including an ordinary member — could read any
 * bulletin in the country by id, drafts included, while the list endpoint
 * correctly withheld them. Publication is what makes a bulletin public; until it
 * is published only staff inside the ward may see it.
 */
export async function getVisibleBulletin(id: string, principal: Principal): Promise<WardBulletin> {
  const bulletin = await getBulletin(id);
  if (!bulletin) throw ApiError.notFound('Bulletin not found');
  if (bulletin.status === 'published') return bulletin;
  if (!canSeeUnpublished(principal) || !(await principalSeesWard(principal, bulletin.wardCode))) {
    throw ApiError.notFound('Bulletin not found');
  }
  return bulletin;
}

export async function listBulletins(
  principal: Principal,
  filters: {
    wardCode?: string;
    kind?: string;
    status?: string;
    limit: number;
    offset: number;
  },
): Promise<{ items: WardBulletin[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filters.wardCode) { conditions.push(`ward_code = $${idx++}`); values.push(filters.wardCode); }
  if (filters.kind) { conditions.push(`kind = $${idx++}`); values.push(filters.kind); }
  if (filters.status) { conditions.push(`status = $${idx++}`); values.push(filters.status); }

  // A bulletin is published communication from a councillor to their ward. Only
  // `status = 'published'` is public; drafts are visible to staff inside their
  // own territory. Previously every `bulletin:read` holder — including a member
  // — received every bulletin in every ward, drafts included.
  const gate = await publishedOrInTerritory(principal, `status = 'published'`, 'ward_code', idx);
  values.push(...gate.params);
  idx = gate.nextIndex;
  if (gate.sql) conditions.push(gate.sql.replace(/^\s*AND\s*/, ''));

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [itemsRes, countRes] = await Promise.all([
    query<WardBulletin>(
      `SELECT ${BULLETIN_FIELDS}
       FROM ward_bulletins ${where}
       ORDER BY published_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...values, filters.limit, filters.offset],
    ),
    query<{ total: string }>(`SELECT COUNT(*) AS total FROM ward_bulletins ${where}`, values),
  ]);

  return { items: itemsRes.rows, total: parseInt(countRes.rows[0]?.total ?? '0', 10) };
}
