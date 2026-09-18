import { query, withTransaction } from '../../db/pool.js';
import { validateMediaBatch } from '../transparency/mediaPolicy.js';
import { recordAudit } from '../../security/audit.js';
import { ApiError } from '../../http/errors.js';
import type { Principal } from '../../auth/permissions.js';
import { canSeePrivate, principalSeesWard, privateTierClause, wardCodeScope } from '../../auth/scope.js';
import { uploadMedia } from '../transparency/service.js';
import type { z } from 'zod';
import type { createPatrolSchema, addTrackPointSchema, addPatrolStopSchema, endPatrolSchema, updatePatrolStopSchema, updatePatrolSchema } from './schemas.js';

export interface Patrol {
  id: string;
  /**
   * Optional link to the member record the patrol is reported against. NULL for
   * patrols created through the API: the schema has no user→member link, so the
   * actor is recorded in `created_by` instead (migration 014).
   */
  councillorMemberId: string | null;
  wardCode: string | null;
  mode: string;
  purpose: string | null;
  status: string;
  /** FR-E visibility tier: `public` | `members` | `private`. */
  visibility: string;
  startedAt: Date | null;
  endedAt: Date | null;
  distanceM: number | null;
  distanceSource?: 'gps' | 'manual' | null;
  nextTrackSeq?: number;
  trackPointCount?: number;
  summary: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Attachments on the overview report (photo/video/voice note). Read-only
   *  projection field — set by the list/get SELECTs, never by RETURNING. */
  mediaCount?: number;
  /** The overview report's attachments, hydrated by `getPatrol` only. */
  media?: PatrolMedia[];
}

/** An attachment on the patrol overview report. */
export interface PatrolMedia {
  mediaId: string;
  contentType: string;
  captureMode: string;
}

export interface PatrolStop {
  id: string;
  patrolId: string;
  title: string | null;
  note: string | null;
  callStatus: string;
  contactMethod: string | null;
  followUpAt: Date | null;
  completedAt: Date | null;
  streetAddress: string | null;
  photoId: string | null;
  arrivedAt: Date;
}

export async function createPatrol(
  input: z.infer<typeof createPatrolSchema>,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<Patrol> {
  // A patrol is walked somewhere. Without a ward it cannot appear on any ward
  // dashboard and cannot be scoped, so it is refused rather than stored as an
  // orphan; a ward-scoped caller who omits it gets their own ward.
  const wardCode = input.wardCode ?? principal.wardCode ?? null;
  if (!wardCode) throw ApiError.badRequest('wardCode is required');
  // Writing a patrol into another ward would plant a GPS track and street
  // addresses in a record that ward's councillor never walked.
  if (!(await principalSeesWard(principal, wardCode))) {
    throw ApiError.forbidden('Ward outside your authorized scope');
  }

  // `created_by` is the accountable actor. `councillor_member_id` stays NULL:
  // there is no user→member link in the schema, and the previous
  // `SELECT id FROM members WHERE created_by = <user>` guess both failed the
  // NOT NULL constraint for most roles (500 on every patrol start) and, when it
  // did match, attributed the patrol to an unrelated member. See migration 014.
  const res = await query<Patrol>(
    `INSERT INTO patrols (ward_code, mode, purpose, planned_date, status, started_at, created_by)
     VALUES ($1, $2, $3, $4::date, CASE WHEN $4::date IS NULL THEN 'active'::patrol_status ELSE 'planned'::patrol_status END,
             CASE WHEN $4::date IS NULL THEN now() ELSE NULL END, $5)
     RETURNING ${PATROL_FIELDS}`,
    [wardCode, input.mode, input.purpose ?? null, input.plannedDate ?? null, principal.sub],
  );

  if (res.rowCount === 0) throw ApiError.internal('Failed to create patrol');
  const patrol = res.rows[0]!;

  await recordAudit({
    action: 'patrol.create',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'patrols',
    targetId: patrol.id,
    metadata: { wardCode: patrol.wardCode, mode: patrol.mode },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return patrol;
}

/**
 * Load a patrol's territory and assert the caller may write to it.
 *
 * Track points, stops and the end-of-patrol update all previously ran straight
 * against the id with no scope check at all: any holder of `patrol:write` could
 * append a GPS track to, or close, a patrol belonging to any other ward in the
 * country. Reads were already gated by `getPatrol`; writes must be too.
 */
async function assertPatrolWritable(patrolId: string, principal: Principal, activeOnly = false, run = query): Promise<void> {
  const res = await run<{ wardCode: string | null; visibility: string; status: string }>(
    `SELECT ward_code AS "wardCode", visibility, status FROM patrols WHERE id = $1${run === query ? '' : ' FOR UPDATE'}`,
    [patrolId],
  );
  const patrol = res.rows[0];
  if (!patrol) throw ApiError.notFound('Patrol not found');
  if (activeOnly && patrol.status !== 'active') throw ApiError.conflict('Patrol is not active');
  if (patrol.visibility === 'private' && !canSeePrivate(principal)) {
    throw ApiError.forbidden('This patrol is internal to party staff');
  }
  if (patrol.wardCode && !(await principalSeesWard(principal, patrol.wardCode))) {
    throw ApiError.forbidden('This patrol belongs to another ward');
  }
}

export async function addTrackPoint(
  patrolId: string,
  input: z.infer<typeof addTrackPointSchema>,
  principal: Principal,
): Promise<{ id: string }> {
  return withTransaction(async (client) => {
  const run = client.query.bind(client) as typeof query;
  await assertPatrolWritable(patrolId, principal, true, run);
  const previous = await run<{ id: string; same: boolean }>(
    `SELECT id, (recorded_at = $3 AND ST_Equals(location::geometry, ST_SetSRID(ST_MakePoint($4, $5), 4326))) AS same
     FROM patrol_track_points WHERE patrol_id = $1 AND seq = $2`,
    [patrolId, input.seq, input.recordedAt, input.longitude, input.latitude]);
  if (previous.rows[0]) {
    if (!previous.rows[0].same) throw ApiError.conflict('Track sequence already used; reload the patrol');
    return { id: previous.rows[0].id };
  }

  const res = await run<{ id: string }>(
    `INSERT INTO patrol_track_points (patrol_id, seq, location, accuracy_m, speed, recorded_at, street_address)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6, $7, $8)
     RETURNING id`,
    [patrolId, input.seq, input.longitude, input.latitude,
     input.accuracyM ?? null, input.speed ?? null, input.recordedAt, input.streetAddress ?? null],
  );

  if (res.rowCount === 0) throw ApiError.internal('Failed to add track point');
  return res.rows[0]!;
  });
}

export async function addStop(
  patrolId: string,
  input: z.infer<typeof addPatrolStopSchema>,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<{ id: string }> {
  const res = await withTransaction(async (client) => {
    const run = client.query.bind(client) as typeof query;
    await assertPatrolWritable(patrolId, principal, true, run);
    if (input.followUpAt && Date.parse(input.followUpAt) <= Date.now()) throw ApiError.badRequest('Follow-up date must be in the future');
    if (input.requestId) {
      const previous = await run<{ id: string }>('SELECT id FROM patrol_stops WHERE patrol_id = $1 AND request_id = $2', [patrolId, input.requestId]);
      if (previous.rows.length) return previous;
    }
    return run<{ id: string }>(
      `INSERT INTO patrol_stops (patrol_id, location, street_address, service_request_id, title, note, photo_id, call_status, arrived_at,
                                contact_method, follow_up_at, completed_at, request_id)
       VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, CASE WHEN $9 = 'completed' THEN now() ELSE NULL END, $13)
       RETURNING id`,
      [patrolId, input.longitude, input.latitude, input.streetAddress ?? null,
       input.serviceRequestId ?? null, input.title ?? null, input.note ?? null,
       input.photoId ?? null, input.callStatus, input.arrivedAt,
       input.contactMethod ?? null, input.callStatus === 'completed' ? null : input.followUpAt ?? null, input.requestId ?? null]);
  });
  if (res.rowCount === 0) throw ApiError.internal('Failed to add patrol stop');

  await recordAudit({
    action: 'patrol.stop',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'patrol_stops',
    targetId: res.rows[0]!.id,
    metadata: { patrolId },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return res.rows[0]!;
}

/** List all stops (call log entries) for a patrol, newest first. */
export async function listPatrolStops(
  patrolId: string,
  principal: Principal,
): Promise<PatrolStop[]> {
  // Ensure the caller can read this patrol (territory + visibility gating).
  const patrol = await getPatrol(patrolId, principal);
  if (!patrol) throw ApiError.notFound('Patrol not found');
  const res = await query<PatrolStop>(
    `SELECT id, patrol_id AS "patrolId", title, note,
            call_status AS "callStatus", street_address AS "streetAddress",
            photo_id AS "photoId", arrived_at AS "arrivedAt",
            contact_method AS "contactMethod", follow_up_at AS "followUpAt", completed_at AS "completedAt"
     FROM patrol_stops WHERE patrol_id = $1
     ORDER BY arrived_at DESC`,
    [patrolId],
  );
  return res.rows;
}

/** Update a patrol stop's title, note or call status. */
export async function updatePatrolStop(
  patrolId: string,
  stopId: string,
  input: z.infer<typeof updatePatrolStopSchema>,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<PatrolStop> {
  await assertPatrolWritable(patrolId, principal);

  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [];
  let idx = 1;
  if (input.title !== undefined) { sets.push(`title = $${idx++}`); values.push(input.title); }
  if (input.note !== undefined) { sets.push(`note = $${idx++}`); values.push(input.note); }
  if (input.callStatus !== undefined) {
    if (input.callStatus === 'completed' && !input.note?.trim()) throw ApiError.badRequest('Completion outcome is required');
    sets.push(`call_status = $${idx++}`); values.push(input.callStatus);
    sets.push(input.callStatus === 'completed' ? 'completed_at = now(), follow_up_at = NULL' : 'completed_at = NULL');
  }
  if (input.contactMethod !== undefined) { sets.push(`contact_method = $${idx++}`); values.push(input.contactMethod); }
  if (input.followUpAt !== undefined && input.callStatus !== 'completed') {
    if (input.followUpAt && Date.parse(input.followUpAt) <= Date.now()) throw ApiError.badRequest('Follow-up date must be in the future');
    const value = `$${idx++}::timestamptz`;
    sets.push(`follow_up_at = ${input.callStatus ? value : `CASE WHEN call_status = 'completed' THEN NULL ELSE ${value} END`}`);
    values.push(input.followUpAt);
  }
  if (sets.length === 1) throw ApiError.badRequest('Nothing to update');

  values.push(stopId, patrolId);
  const res = await query<PatrolStop>(
    `UPDATE patrol_stops SET ${sets.join(', ')}
     WHERE id = $${idx++} AND patrol_id = $${idx}
     RETURNING id, patrol_id AS "patrolId", title, note,
              call_status AS "callStatus", street_address AS "streetAddress",
              photo_id AS "photoId", arrived_at AS "arrivedAt",
              contact_method AS "contactMethod", follow_up_at AS "followUpAt", completed_at AS "completedAt"`,
    values,
  );
  if (res.rowCount === 0) throw ApiError.notFound('Patrol stop not found');

  await recordAudit({
    action: 'patrol.stop.update',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'patrol_stops',
    targetId: stopId,
    metadata: { patrolId, callStatus: input.callStatus },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return res.rows[0]!;
}

async function measuredPatrolDistance(patrolId: string, run = query): Promise<number | null> {
  const measured = await run<{ distance: number | null }>(
    `WITH segments AS (
       SELECT location, recorded_at, lag(location) OVER w AS previous,
              lag(recorded_at) OVER w AS previous_at
       FROM patrol_track_points WHERE patrol_id = $1 AND accuracy_m <= 100
       WINDOW w AS (ORDER BY recorded_at, seq)
     ) SELECT sum(ST_Distance(previous, location))::float8 AS distance FROM segments
       WHERE recorded_at - previous_at BETWEEN interval '0 seconds' AND interval '30 seconds'`, [patrolId]);
  return measured.rows[0]?.distance ?? null;
}

export async function endPatrol(
  patrolId: string,
  input: z.infer<typeof endPatrolSchema>,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<Patrol> {
  await assertPatrolWritable(patrolId, principal);

  const mediaItems = input.media ?? [];
  const result = await withTransaction(async (client) => {
    const run = client.query.bind(client) as typeof query;
    await assertPatrolWritable(patrolId, principal, false, run);
    const current = await run('SELECT status, completion_request_id FROM patrols WHERE id = $1 FOR UPDATE', [patrolId]);
    if (current.rows[0]?.status === 'completed' && input.requestId && current.rows[0].completion_request_id === input.requestId) {
      return (await run<Patrol>(`SELECT ${PATROL_FIELDS} FROM patrols WHERE id = $1`, [patrolId])).rows[0]!;
    }
    if (current.rows[0]?.status !== 'active') throw ApiError.conflict('Patrol is not active');
    await validateMediaBatch(mediaItems);
    const distance = input.distanceM ?? await measuredPatrolDistance(patrolId, run);
    const source = distance === null ? null : input.distanceM === undefined ? 'gps' : 'manual';
    const res = await run<Patrol>(
      `UPDATE patrols SET status = 'completed', ended_at = now(), distance_m = $2,
         summary = COALESCE($3, summary), completion_request_id = $4, distance_source = $5, updated_at = now()
       WHERE id = $1 AND status = 'active' RETURNING ${PATROL_FIELDS}`,
      [patrolId, distance, input.summary ?? null, input.requestId ?? null, source]);

  // The patrol exists (asserted above) but is not open, so this is a state
  // conflict, not a missing resource — telling the client 404 sent the app
  // looking for a record that was there all along.
  if (res.rowCount === 0) throw ApiError.conflict('Patrol is not active');

  // Store the overview report's attachments through the shared media pipeline,
  // then link them ordered by seq — mirrors service_request_media. The patrol's
  // GPS track already carries the location, so the assets need no own geo fix;
  // loadMediaForPrincipal() serves them under the patrol's ward-scoped tier.
  for (let i = 0; i < mediaItems.length; i++) {
    const m = mediaItems[i]!;
    const stored = await uploadMedia({ dataUrl: m.dataUrl, captureMode: m.captureMode }, principal, client);
    await run(
      `INSERT INTO patrol_media (patrol_id, media_asset_id, seq)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [patrolId, stored.id, i],
    );
  }
  return res.rows[0]!;
  });

  await recordAudit({
    action: 'patrol.end',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'patrols',
    targetId: patrolId,
    metadata: { status: 'completed', mediaCount: mediaItems.length },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return result;
}

/** Columns shared by the single-patrol and list projections. `distance_m` is
 *  NUMERIC, which node-postgres returns as a string; cast to float8 so the wire
 *  value is the `number` the frontend `Patrol` type declares (the CRM total-km
 *  reduce and the mobile distance maths both need a real number). */
const PATROL_FIELDS = `id, councillor_member_id AS "councillorMemberId", ward_code AS "wardCode",
            mode, purpose, status, visibility, started_at AS "startedAt", ended_at AS "endedAt",
            distance_m::float8 AS "distanceM", distance_source AS "distanceSource", summary,
            created_at AS "createdAt", updated_at AS "updatedAt"`;

/** Attachment count on the overview report, appended to the read projections
 *  only (not RETURNING). Lets the mobile list show "N photos" without a
 *  second round-trip per patrol. */
const PATROL_MEDIA_COUNT = `(SELECT count(*)::int FROM patrol_media pm WHERE pm.patrol_id = patrols.id) AS "mediaCount"`;

/**
 * One patrol, gated on the caller's territory and the FR-E visibility tier.
 * `visibility = 'private'` patrols are internal party operations: staff only.
 */
export async function getPatrol(id: string, principal: Principal): Promise<Patrol | null> {
  const res = await query<Patrol>(
    `SELECT ${PATROL_FIELDS}, ${PATROL_MEDIA_COUNT} FROM patrols WHERE id = $1`,
    [id],
  );
  const patrol = res.rows[0];
  if (!patrol) return null;
  if (patrol.visibility === 'private' && !canSeePrivate(principal)) {
    throw ApiError.forbidden('This patrol is internal to party staff');
  }
  if (patrol.wardCode && !(await principalSeesWard(principal, patrol.wardCode))) {
    throw ApiError.forbidden('This patrol belongs to another ward');
  }
  // Hydrate the overview report's attachments so the CRM can render them
  // (served, tier-checked, through GET /transparency/media/:id).
  const media = await query<PatrolMedia>(
    `SELECT pm.media_asset_id AS "mediaId", ma.content_type AS "contentType", ma.capture_mode AS "captureMode"
       FROM patrol_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id
      WHERE pm.patrol_id = $1
      ORDER BY pm.seq`,
    [id],
  );
  patrol.media = media.rows;
  const tracking = await query<{ nextTrackSeq: number; trackPointCount: number }>(
    `SELECT COALESCE(max(seq) + 1, 0)::int AS "nextTrackSeq", count(*)::int AS "trackPointCount"
     FROM patrol_track_points WHERE patrol_id = $1`, [id]);
  Object.assign(patrol, tracking.rows[0]);
  return patrol;
}

/**
 * CRM edit of the patrol record. Territory-gated like every other write. When
 * the status moves to a terminal state and `ended_at` is not yet set, it is
 * stamped so the record is internally consistent.
 */
export async function updatePatrol(
  patrolId: string,
  input: z.infer<typeof updatePatrolSchema>,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<Patrol> {
  await assertPatrolWritable(patrolId, principal);
  // Moving a patrol into another ward needs that ward in the caller's scope too.
  if (input.wardCode !== undefined && !(await principalSeesWard(principal, input.wardCode))) {
    throw ApiError.forbidden('Ward outside your authorized scope');
  }

  const res = await withTransaction(async (client) => {
  const run = client.query.bind(client) as typeof query;
  await assertPatrolWritable(patrolId, principal, false, run);
  const current = (await run<{ status: string; distance_m: string | null }>('SELECT status, distance_m FROM patrols WHERE id = $1', [patrolId])).rows[0]!;
  const transitions: Record<string, string[]> = { planned: ['active', 'cancelled'], active: ['completed', 'cancelled'], completed: [], cancelled: [] };
  if (input.status && input.status !== current.status && !transitions[current.status]?.includes(input.status)) {
    throw ApiError.conflict(`Cannot change ${current.status} patrol to ${input.status}`);
  }
  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [];
  let idx = 1;
  if (input.wardCode !== undefined) { sets.push(`ward_code = $${idx++}`); values.push(input.wardCode); }
  if (input.mode !== undefined) { sets.push(`mode = $${idx++}`); values.push(input.mode); }
  if (input.purpose !== undefined) { sets.push(`purpose = $${idx++}`); values.push(input.purpose); }
  if (input.summary !== undefined) { sets.push(`summary = $${idx++}`); values.push(input.summary); }
  if (input.distanceM !== undefined) { sets.push(`distance_m = $${idx++}`, input.distanceM === null ? 'distance_source = NULL' : "distance_source = 'manual'"); values.push(input.distanceM); }
  if (input.status === 'completed' && current.status === 'active' && input.distanceM === undefined && current.distance_m === null) {
    const distance = await measuredPatrolDistance(patrolId, run);
    sets.push(`distance_m = $${idx++}`, distance === null ? 'distance_source = NULL' : "distance_source = 'gps'");
    values.push(distance);
  }
  if (input.status !== undefined) {
    sets.push(`status = $${idx++}`);
    values.push(input.status);
    if (input.status === 'active') sets.push('started_at = COALESCE(started_at, now())');
    // A closed patrol without an end time reads as still open in the app.
    if (input.status === 'completed' || input.status === 'cancelled') {
      sets.push('ended_at = COALESCE(ended_at, now())');
    }
  }
  if (sets.length === 1) throw ApiError.badRequest('Nothing to update');

  values.push(patrolId);
  const updated = await run<Patrol>(
    `UPDATE patrols SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${PATROL_FIELDS}`,
    values,
  );
  if (updated.rowCount === 0) throw ApiError.notFound('Patrol not found');
  return updated;
  });

  await recordAudit({
    action: 'patrol.update',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'patrols',
    targetId: patrolId,
    metadata: { status: input.status, mode: input.mode, wardCode: input.wardCode },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return res.rows[0]!;
}

/**
 * Delete a patrol. Track points, stops and media links cascade (ON DELETE
 * CASCADE). Territory-gated: a caller can only delete a patrol in their scope.
 */
export async function deletePatrol(
  patrolId: string,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<void> {
  await assertPatrolWritable(patrolId, principal);
  const res = await query(`DELETE FROM patrols WHERE id = $1`, [patrolId]);
  if (res.rowCount === 0) throw ApiError.notFound('Patrol not found');

  await recordAudit({
    action: 'patrol.delete',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'patrols',
    targetId: patrolId,
    metadata: {},
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

export async function listPatrols(
  principal: Principal,
  filters: {
    wardCode?: string;
    status?: string;
    limit: number;
    offset: number;
  },
): Promise<{ items: Patrol[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filters.wardCode) { conditions.push(`ward_code = $${idx++}`); values.push(filters.wardCode); }
  if (filters.status) { conditions.push(`status = $${idx++}`); values.push(filters.status); }

  // Territory AND-ed with any caller-supplied wardCode, so `?wardCode=` can
  // narrow but never widen. Before this, every `patrol:read` holder — including
  // a ward member — received every patrol in the country.
  const scope = await wardCodeScope(principal, 'ward_code', idx);
  values.push(...scope.params);
  idx = scope.nextIndex;
  if (scope.sql) conditions.push(scope.sql.replace(/^\s*AND\s*/, ''));

  // FR-E tier: internal (private) patrols are staff-only.
  const tier = privateTierClause(principal);
  if (tier) conditions.push(tier.replace(/^\s*AND\s*/, ''));

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [itemsRes, countRes] = await Promise.all([
    query<Patrol>(
      `SELECT ${PATROL_FIELDS}, ${PATROL_MEDIA_COUNT}
       FROM patrols ${where}
       ORDER BY created_at DESC, id DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...values, filters.limit, filters.offset],
    ),
    query<{ total: string }>(`SELECT COUNT(*) AS total FROM patrols ${where}`, values),
  ]);

  return { items: itemsRes.rows, total: parseInt(countRes.rows[0]?.total ?? '0', 10) };
}

export async function getHeatmapData(
  principal: Principal,
  wardCode?: string,
): Promise<Array<{ latitude: number; longitude: number; category: string; count: number }>> {
  const params: unknown[] = wardCode ? [wardCode] : [];
  const wardFilter = wardCode ? 'AND sr.ward_code = $1' : '';
  // A ward-scoped caller asking for another ward's heatmap gets the
  // intersection (nothing) rather than that ward's case locations.
  const scope = await wardCodeScope(principal, 'sr.ward_code', params.length + 1);
  params.push(...scope.params);
  const scopeFilter = scope.sql;
  // Case locations are sensitive at scale; private cases never appear on a map.
  const tier = " AND sr.visibility <> 'private'";

  const res = await query<{ lat: number; lng: number; category: string; count: string }>(
    `SELECT round(ST_Y(sr.location::geometry)::numeric, 3)::float8 AS lat,
            round(ST_X(sr.location::geometry)::numeric, 3)::float8 AS lng,
            sr.category::text AS category,
            COUNT(*)::text AS count
     FROM service_requests sr
     WHERE sr.location IS NOT NULL AND sr.status <> 'duplicate' AND sr.merged_into IS NULL ${wardFilter}${scopeFilter}${tier}
     GROUP BY 1, 2, sr.category`, 
    params,
  );

  return res.rows.map((r: { lat: number; lng: number; category: string; count: string }) => ({
    latitude: r.lat,
    longitude: r.lng,
    category: r.category,
    count: parseInt(r.count, 10),
  }));
}
