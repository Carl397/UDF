import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { ApiError } from '../../http/errors.js';
import { Permission, type Principal } from '../../auth/permissions.js';
import { principalSeesPlace } from '../../auth/scope.js';
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

const listQuery = z.object({
  upcoming: z.coerce.boolean().default(true),
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
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, title, kind, summary, body, region_code, ward, venue,
       lat::text AS lat, lng::text AS lng, starts_at, ends_at, capacity,
       rsvp_count, status, created_at, updated_at
  FROM events`;

const toView = (r: Row) => ({
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
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

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

// READ (single) — public.
eventsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const r = await query<Row>(`${SELECT} WHERE id = $1`, [req.params.id]);
    if (!r.rows[0]) throw ApiError.notFound('Event not found');
    res.json(toView(r.rows[0]!));
  }),
);

// RSVP — public, counter only (no personal data collected). Rate-limited: see D42.
eventsRouter.post(
  '/:id/rsvp',
  rsvpLimiter,
  asyncHandler(async (req, res) => {
    const r = await query<Row>(
      `UPDATE events
          SET rsvp_count = rsvp_count + 1
        WHERE id = $1
          AND (capacity IS NULL OR rsvp_count < capacity)
        RETURNING id, title, kind, summary, body, region_code, ward, venue,
                  lat::text AS lat, lng::text AS lng, starts_at, ends_at,
                  capacity, rsvp_count, status, created_at, updated_at`,
      [req.params.id],
    );
    if (!r.rows[0]) throw ApiError.conflict('Event is full or does not exist');
    res.json(toView(r.rows[0]!));
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
                 capacity, rsvp_count, status, created_at, updated_at`,
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
                 capacity, rsvp_count, status, created_at, updated_at`,
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
