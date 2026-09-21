import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { authenticate, optionalAuthenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { boolQuery } from '../../http/query.js';
import { ApiError } from '../../http/errors.js';
import { Permission, type Principal } from '../../auth/permissions.js';
import { principalSeesPlace } from '../../auth/scope.js';
import { openRecord } from '../../security/encryption.js';
import { uploadMedia } from '../transparency/service.js';
import { recordAudit } from '../../security/audit.js';
import { notify } from '../notifications/service.js';

/**
 * /api/events — rallies, meetings, trainings, canvassing and service actions.
 *
 * Reading the calendar is public (it is campaigning material); writing is
 * restricted to organisers and is region-scoped.
 */
export const eventsRouter = Router();

/**
 * D42 — RSVP is the one anonymous WRITE on this router: it increments
 * `rsvp_count` and the counter is what enforces capacity, so an unthrottled
 * caller could fill any event by id and lock out real attendees. It collects no
 * personal data, so the fix is a budget rather than authentication — the same
 * shape as `signLimiter` on the public petition-signing endpoint.
 */
const rsvpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'too_many_requests', message: 'Too many RSVP attempts — try later' } },
});

const EventKind = z.enum([
  'rally',
  'meeting',
  'training',
  'canvass',
  'debate',
  'fundraiser',
  'service',
  'webinar',
]);
const EventStatus = z.enum(['scheduled', 'live', 'done', 'cancelled']);

/**
 * Query-string boolean lives in http/query.ts — `z.coerce.boolean()` maps the
 * string "false" to TRUE, which would trap the CRM in an upcoming-only list.
 */
const listQuery = z.object({
  upcoming: boolQuery(true),
  regionCode: z.string().max(32).optional(),
  ward: z.string().max(64).optional(),
  kind: EventKind.optional(),
  status: EventStatus.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const writeSchema = z.object({
  title: z.string().min(1).max(160),
  kind: EventKind.default('rally'),
  summary: z.string().max(500).optional(),
  body: z.string().max(8000).optional(),
  regionCode: z.string().max(32).optional(),
  ward: z.string().max(64).optional(),
  venue: z.string().max(200).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().optional(),
  capacity: z.number().int().min(0).max(1_000_000).optional(),
  status: EventStatus.default('scheduled'),
});
const updateSchema = writeSchema.partial();

interface Row {
  id: string;
  title: string;
  kind: string;
  summary: string | null;
  body: string | null;
  region_code: string | null;
  ward: string | null;
  venue: string | null;
  lat: string | null;
  lng: string | null;
  starts_at: string;
  ends_at: string | null;
  capacity: number | null;
  rsvp_count: number;
  status: string;
  cover_media_id: string | null;
  created_at: string;
  updated_at: string;
}

// The `going` flag is layered on by the read route (it needs the caller), so it
// is intentionally not part of the shared `toView` shape.
interface ViewRow extends Row {
  going?: boolean;
}

const SELECT = `SELECT id, title, kind, summary, body, region_code, ward, venue,
       lat::text AS lat, lng::text AS lng, starts_at, ends_at, capacity,
       rsvp_count, status, cover_media_id, created_at, updated_at
  FROM events`;

const toView = (r: ViewRow) => ({
  id: r.id,
  title: r.title,
  kind: r.kind,
  summary: r.summary,
  body: r.body,
  regionCode: r.region_code,
  ward: r.ward,
  venue: r.venue,
  lat: r.lat === null ? null : Number(r.lat),
  lng: r.lng === null ? null : Number(r.lng),
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  capacity: r.capacity,
  rsvpCount: Number(r.rsvp_count ?? 0),
  status: r.status,
  hasCover: Boolean(r.cover_media_id),
  going: r.going ?? false,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Serve an event's cover bytes; the public calendar makes covers public. */
async function loadCoverFile(mediaId: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const asset = await query<{ storage_key: string; content_type: string }>(
    'SELECT storage_key, content_type FROM media_assets WHERE id = $1',
    [mediaId],
  );
  const row = asset.rows[0];
  if (!row) return null;
  const buffer = await readFile(join(process.cwd(), row.storage_key));
  return { buffer, contentType: row.content_type };
}

// LIST — public calendar.
eventsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };

    if (q.upcoming) where.push('starts_at >= now()');
    if (q.regionCode) add('region_code = ?', q.regionCode);
    if (q.ward) add('ward = ?', q.ward);
    if (q.kind) add('kind = ?', q.kind);
    if (q.status) add('status = ?', q.status);

    params.push(q.limit, q.offset);
    const res2 = await query<Row & { total: string }>(
      `${SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY starts_at ${q.upcoming ? 'ASC' : 'DESC'}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const countRes = await query<{ c: string }>(
      `SELECT count(*)::text AS c FROM events
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
      params.slice(0, params.length - 2),
    );

    res.json({
      items: res2.rows.map(toView),
      total: Number(countRes.rows[0]?.c ?? 0),
      limit: q.limit,
      offset: q.offset,
    });
  }),
);

// READ (single) — public. When a signed-in member is also an attendee, the
// view carries `going` so the app button reflects their saved state on reopen.
eventsRouter.get(
  '/:id',
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const r = await query<Row>(`${SELECT} WHERE id = $1`, [req.params.id]);
    if (!r.rows[0]) throw ApiError.notFound('Event not found');
    const view: ViewRow = { ...r.rows[0]! };
    if (req.principal) {
      const mine = await query<{ one: string }>(
        `SELECT '1' AS one FROM event_rsvps
          WHERE event_id = $1 AND user_id = $2 AND response = 'going' LIMIT 1`,
        [req.params.id, req.principal.sub],
      );
      view.going = Boolean(mine.rows[0]);
    }
    res.json(toView(view));
  }),
);

// COVER — public hero image bytes for the event (the calendar itself is public).
eventsRouter.get(
  '/:id/cover',
  asyncHandler(async (req, res) => {
    const r = await query<{ cover_media_id: string | null }>(
      'SELECT cover_media_id FROM events WHERE id = $1',
      [req.params.id],
    );
    if (!r.rows[0]) throw ApiError.notFound('Event not found');
    if (!r.rows[0].cover_media_id) throw ApiError.notFound('Event has no cover image');
    const file = await loadCoverFile(r.rows[0].cover_media_id);
    if (!file) throw ApiError.notFound('Cover image not found');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    // Public, no-auth image meant to be embedded anywhere. Helmet applies a global
    // CORP of `same-site`, which blocks the mobile WebView (origin http://localhost)
    // from rendering this cross-site inside an <img>; widen it for this response only.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(file.buffer);
  }),
);

/**
 * RSVP — now login-required and NAMED. Historically this only incremented an
 * anonymous `rsvp_count`, so the backoffice saw a total but never who was
 * coming. It records one row per account (`event_rsvps`, UNIQUE event+user), so
 * "one per member" is a database guarantee and a repeat call is idempotent.
 * `response` is 'going' (counts toward capacity) or 'interested' (a softer
 * signal). The rate limiter stays as defence-in-depth against capacity spam.
 */
const rsvpWriteSchema = z.object({
  response: z.enum(['going', 'interested']).default('going'),
});
eventsRouter.post(
  '/:id/rsvp',
  authenticate,
  rsvpLimiter,
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const { response } = rsvpWriteSchema.parse(req.body ?? {});
    const eventId = req.params.id!;

    const outcome = await withTransaction(async (client) => {
      const ev = await client.query<{ capacity: number | null; rsvp_count: string }>(
        'SELECT capacity, rsvp_count FROM events WHERE id = $1 FOR UPDATE',
        [eventId],
      );
      if (!ev.rows[0]) return { notFound: true } as const;
      const capacity = ev.rows[0].capacity;
      const count = Number(ev.rows[0].rsvp_count);

      const priorRes = await client.query<{ response: string }>(
        'SELECT response FROM event_rsvps WHERE event_id = $1 AND user_id = $2',
        [eventId, p.sub],
      );
      const prior = priorRes.rows[0]?.response ?? null;
      if (prior === response) return { ok: true } as const; // idempotent

      const becomingGoing = response === 'going';
      const wasGoing = prior === 'going';
      if (becomingGoing && !wasGoing && capacity != null && count >= capacity) {
        return { full: true } as const;
      }

      if (prior) {
        await client.query(
          `UPDATE event_rsvps SET response = $3, updated_at = now()
            WHERE event_id = $1 AND user_id = $2`,
          [eventId, p.sub, response],
        );
      } else {
        const memberRes = await client.query<{ member_id: string | null }>(
          'SELECT member_id FROM users WHERE id = $1',
          [p.sub],
        );
        await client.query(
          `INSERT INTO event_rsvps (event_id, user_id, member_id, response)
           VALUES ($1, $2, $3, $4)`,
          [eventId, p.sub, memberRes.rows[0]?.member_id ?? null, response],
        );
      }
      // Keep the cached capacity counter in step with the rows.
      if (becomingGoing && !wasGoing) {
        await client.query('UPDATE events SET rsvp_count = rsvp_count + 1 WHERE id = $1', [eventId]);
      } else if (wasGoing && !becomingGoing) {
        await client.query(
          'UPDATE events SET rsvp_count = GREATEST(rsvp_count - 1, 0) WHERE id = $1',
          [eventId],
        );
      }
      return { ok: true } as const;
    });

    if (outcome.notFound) throw ApiError.notFound('Event not found');
    if (outcome.full) throw ApiError.conflict('Event is full');

    const r = await query<Row>(`${SELECT} WHERE id = $1`, [eventId]);
    res.json(toView({ ...r.rows[0]!, going: response === 'going' }));
  }),
);

// Cancel my RSVP — removes the row and releases the capacity slot. Idempotent.
eventsRouter.delete(
  '/:id/rsvp',
  authenticate,
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const eventId = req.params.id!;
    await withTransaction(async (client) => {
      const del = await client.query<{ response: string }>(
        'DELETE FROM event_rsvps WHERE event_id = $1 AND user_id = $2 RETURNING response',
        [eventId, p.sub],
      );
      if (del.rows[0]?.response === 'going') {
        await client.query(
          'UPDATE events SET rsvp_count = GREATEST(rsvp_count - 1, 0) WHERE id = $1',
          [eventId],
        );
      }
    });
    const r = await query<Row>(`${SELECT} WHERE id = $1`, [eventId]);
    if (!r.rows[0]) throw ApiError.notFound('Event not found');
    res.json(toView({ ...r.rows[0]!, going: false }));
  }),
);

/**
 * ATTENDEES — the backoffice guest list. Gated on `event:write` + the same
 * territory check as editing the event, so only an organiser who owns the
 * event's region/ward can pull the names. Resolving a member's name decrypts
 * their sealed PII, so the whole read is audited (`event.attendees.read`).
 */
eventsRouter.get(
  '/:id/attendees',
  authenticate,
  requirePermission(Permission.EVENT_WRITE),
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const ev = await query<{ region_code: string | null; ward: string | null }>(
      'SELECT region_code, ward FROM events WHERE id = $1',
      [req.params.id],
    );
    if (!ev.rows[0]) throw ApiError.notFound('Event not found');
    await assertScope(p, ev.rows[0]);

    const rows = await query<{
      member_id: string | null;
      membership_no: string | null;
      ward: string | null;
      member_sealed: any;
      user_id: string;
      user_sealed: any;
      response: string;
      created_at: string;
    }>(
      `SELECT er.member_id, m.membership_no, m.ward, m.sealed_pii AS member_sealed,
              u.id AS user_id, u.sealed_pii AS user_sealed, er.response, er.created_at
         FROM event_rsvps er
         JOIN users u ON u.id = er.user_id
         LEFT JOIN members m ON m.id = er.member_id
        WHERE er.event_id = $1
        ORDER BY er.created_at ASC`,
      [req.params.id],
    );

    const items: Array<{
      name: string | null;
      membershipNo: string | null;
      ward: string | null;
      response: string;
      at: string;
    }> = [];
    let decrypted = false;
    for (const row of rows.rows) {
      let name: string | null = null;
      const sealed = row.member_id ? row.member_sealed : row.user_sealed;
      const ctxId = row.member_id ?? row.user_id;
      if (sealed?.fields) {
        try {
          name = (await openRecord(ctxId!, sealed)).fullName ?? null;
          decrypted = true;
        } catch {
          name = null;
        }
      }
      items.push({
        name,
        membershipNo: row.membership_no ?? null,
        ward: row.ward ?? null,
        response: row.response,
        at: row.created_at,
      });
    }

    await recordAudit({
      action: 'event.attendees.read',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'event',
      targetId: req.params.id,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { count: items.length, decrypted },
    });

    res.json({ items, total: items.length });
  }),
);

// ── Authenticated writes ─────────────────────────────────────────
/**
 * Territory gate for event writes.
 *
 * Replaces the region-only test that was inline in PATCH/DELETE and the
 * `requireRegionInScope` middleware on POST. All three only ever compared
 * `region_code`, which for a ward-scoped `local_coordinator` is their whole
 * subcouncil — so they could create, move, edit or cancel events in wards they
 * do not represent. `principalSeesPlace` matches on the ward first.
 */
async function assertScope(
  p: Principal,
  place: { region_code?: string | null; regionCode?: string | null; ward?: string | null },
): Promise<void> {
  const regionCode = place.regionCode ?? place.region_code ?? null;
  if (!(await principalSeesPlace(p, { regionCode, ward: place.ward ?? null }))) {
    throw ApiError.forbidden('Event outside your authorized scope');
  }
}

eventsRouter.use(authenticate, requirePermission(Permission.EVENT_WRITE));

eventsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = writeSchema.parse(req.body);
    const p = req.principal!;
    // A ward-scoped organiser always schedules into their own ward unless they
    // name one explicitly; an explicit ward is then checked.
    const ward = input.ward ?? p.wardCode ?? null;
    await assertScope(p, { regionCode: input.regionCode ?? null, ward });

    const r = await query<Row>(
      `INSERT INTO events (title, kind, summary, body, region_code, ward, venue,
                           lat, lng, starts_at, ends_at, capacity, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, title, kind, summary, body, region_code, ward, venue,
                 lat::text AS lat, lng::text AS lng, starts_at, ends_at,
                 capacity, rsvp_count, status, cover_media_id, created_at, updated_at`,
      [
        input.title,
        input.kind,
        input.summary ?? null,
        input.body ?? null,
        input.regionCode ?? null,
        ward,
        input.venue ?? null,
        input.lat ?? null,
        input.lng ?? null,
        input.startsAt.toISOString(),
        input.endsAt ? input.endsAt.toISOString() : null,
        input.capacity ?? null,
        input.status,
        p.sub,
      ],
    );
    const event = toView(r.rows[0]!);

    await recordAudit({
      action: 'event.create',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'event',
      targetId: event.id,
      regionCode: event.regionCode,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { kind: event.kind, startsAt: event.startsAt },
    });

    await notify({
      kind: 'event',
      title: event.title,
      body: `${new Date(event.startsAt).toUTCString()}${event.venue ? ` · ${event.venue}` : ''}`,
      link: `tab:engage#events:${event.id}`,
      regionCode: event.regionCode,
    });

    res.status(201).json(event);
  }),
);

eventsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const input = updateSchema.parse(req.body);
    const p = req.principal!;

    const existing = await query<Row>(`${SELECT} WHERE id = $1`, [req.params.id]);
    const before = existing.rows[0];
    if (!before) throw ApiError.notFound('Event not found');
    await assertScope(p, before);
    // Moving an event is a write into the destination ward too.
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
    if (input.title !== undefined) add('title', input.title);
    if (input.kind !== undefined) add('kind', input.kind);
    if (input.summary !== undefined) add('summary', input.summary ?? null);
    if (input.body !== undefined) add('body', input.body ?? null);
    if (input.regionCode !== undefined) add('region_code', input.regionCode ?? null);
    if (input.ward !== undefined) add('ward', input.ward ?? null);
    if (input.venue !== undefined) add('venue', input.venue ?? null);
    if (input.lat !== undefined) add('lat', input.lat ?? null);
    if (input.lng !== undefined) add('lng', input.lng ?? null);
    if (input.startsAt !== undefined) add('starts_at', input.startsAt.toISOString());
    if (input.endsAt !== undefined) add('ends_at', input.endsAt ? input.endsAt.toISOString() : null);
    if (input.capacity !== undefined) add('capacity', input.capacity ?? null);
    if (input.status !== undefined) add('status', input.status);
    if (!sets.length) throw ApiError.badRequest('No fields to update');

    params.push(req.params.id);
    const r = await query<Row>(
      `UPDATE events SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, title, kind, summary, body, region_code, ward, venue,
                 lat::text AS lat, lng::text AS lng, starts_at, ends_at,
                 capacity, rsvp_count, status, cover_media_id, created_at, updated_at`,
      params,
    );
    const event = toView(r.rows[0]!);

    await recordAudit({
      action: 'event.update',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'event',
      targetId: event.id,
      regionCode: event.regionCode,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { fields: Object.keys(input) },
    });

    if (input.status && input.status !== before.status) {
      await notify({
        kind: 'event',
        title: `Event ${input.status}: ${event.title}`,
        body: event.summary ?? null,
        link: `tab:engage#events:${event.id}`,
        regionCode: event.regionCode,
      });
    }

    res.json(event);
  }),
);

eventsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    // Authorize against the stored territory BEFORE mutating anything.
    const existing = await query<{ region_code: string | null; ward: string | null }>(
      'SELECT region_code, ward FROM events WHERE id = $1',
      [req.params.id],
    );
    if (!existing.rows[0]) throw ApiError.notFound('Event not found');
    await assertScope(p, existing.rows[0]);

    await query('DELETE FROM events WHERE id = $1', [req.params.id]);

    await recordAudit({
      action: 'event.delete',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'event',
      targetId: req.params.id,
      regionCode: existing.rows[0].region_code,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.status(204).end();
  }),
);

// ── Cover image (organiser-only; inherits the EVENT_WRITE gate above) ───────
/**
 * Set/replace an event's dedicated cover image. The bytes go through the same
 * media pipeline as attachments; only the resulting asset id is stored on the
 * event. Re-uploading swaps the cover (the old asset row is left for GC, exactly
 * as attachment replacement behaves).
 */
const coverSchema = z.object({ dataUrl: z.string().min(16).max(8 * 1024 * 1024) });
eventsRouter.post(
  '/:id/cover',
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const ev = await query<{ region_code: string | null; ward: string | null }>(
      'SELECT region_code, ward FROM events WHERE id = $1',
      [req.params.id],
    );
    if (!ev.rows[0]) throw ApiError.notFound('Event not found');
    await assertScope(p, ev.rows[0]);

    const { dataUrl } = coverSchema.parse(req.body);
    const stored = await uploadMedia({ dataUrl, captureMode: 'photo' }, p);
    await query('UPDATE events SET cover_media_id = $2, updated_at = now() WHERE id = $1', [
      req.params.id,
      stored.id,
    ]);

    await recordAudit({
      action: 'event.cover.update',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'event',
      targetId: req.params.id,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { mediaId: stored.id },
    });
    res.json({ ok: true, hasCover: true });
  }),
);

// Remove the cover.
eventsRouter.delete(
  '/:id/cover',
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const ev = await query<{ region_code: string | null; ward: string | null }>(
      'SELECT region_code, ward FROM events WHERE id = $1',
      [req.params.id],
    );
    if (!ev.rows[0]) throw ApiError.notFound('Event not found');
    await assertScope(p, ev.rows[0]);
    await query('UPDATE events SET cover_media_id = NULL, updated_at = now() WHERE id = $1', [
      req.params.id,
    ]);
    res.json({ ok: true, hasCover: false });
  }),
);
