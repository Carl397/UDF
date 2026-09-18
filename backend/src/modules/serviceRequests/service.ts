import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { validateMediaBatch } from '../transparency/mediaPolicy.js';
import { recordAudit } from '../../security/audit.js';
import { ApiError } from '../../http/errors.js';
import type { Principal } from '../../auth/permissions.js';
import { canSeePrivate, principalSeesWard, privateTierClause, wardCodeScope } from '../../auth/scope.js';
import { uploadMedia } from '../transparency/service.js';
import type { z } from 'zod';
import type { createServiceRequestSchema, updateServiceRequestSchema, listServiceRequestsQuery } from './schemas.js';

/**
 * Service requests: the core of service delivery.
 * Lifecycle: reported → triaged → logged → submitted → in_progress → resolved → verified → closed
 * Also: escalated, duplicate, reopened
 */

interface ServiceRequest {
  id: string;
  ref_no: string;
  category: string;
  severity: string;
  title: string;
  description: string | null;
  status: string;
  /** FR-E visibility tier: `public` | `members` | `private`. */
  visibility: string;
  /** Independent follow-up sub-state (migration 017 `sr_follow_up`). */
  follow_up_state: string;
  /** Set when this case was merged into another as a duplicate. */
  merged_into: string | null;
  ward_code: string | null;
  street_address: string | null;
  /** House / stand number read off the erf (migration 017). */
  street_number: string | null;
  reporter_member_id: string | null;
  councillor_member_id: string | null;
  municipality_ref: string | null;
  report_count: number;
  created_at: string;
  updated_at: string;
}

/** Generate a reference number: UDF-W09-000123 */
async function generateRefNo(wardCode: string): Promise<string> {
  // Get the next sequence number for this ward
  const res = await query<{ next_val: string }>(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(ref_no FROM '([0-9]+)$') AS INTEGER)), 0) + 1 AS next_val
     FROM service_requests WHERE ref_no LIKE $1`,
    [`UDF-${wardCode}-%`],
  );
  const nextVal = res.rows[0]?.next_val ?? 1;
  const padded = String(nextVal).padStart(6, '0');
  return `UDF-${wardCode}-${padded}`;
}

export async function createServiceRequest(
  input: z.infer<typeof createServiceRequestSchema>,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<ServiceRequest> {
  const id = randomUUID();
  const wardCode = input.wardCode ?? principal.wardCode ?? null;

  if (!wardCode) {
    throw ApiError.badRequest('Ward code is required (provide in request or user must be ward-scoped)');
  }

  if (!(await principalSeesWard(principal, wardCode))) throw ApiError.forbidden('Ward outside your authorized scope');
  const refNo = await generateRefNo(wardCode);
  const mediaItems = input.media ?? [];
  await validateMediaBatch(mediaItems);

  // Calculate SLA due date based on severity (urgent=24h, report=7d, info=30d)
  const slaHours = input.severity === 'urgent' ? 24 : input.severity === 'report' ? 168 : 720;
  const slaDue = new Date();
  slaDue.setHours(slaDue.getHours() + slaHours);

  // Always reference $7/$8 (explicitly typed) so Postgres can infer their types
  // even when no GPS fix is attached. A parameter that is supplied but never
  // referenced is a hard parse error ("could not determine data type of
  // parameter $7"), which made logging a case WITHOUT a location fail — and the
  // mobile case form treats location as optional. The geometry expression is
  // byte-for-byte the same as before when a fix IS present (null-safe on 0 too).
  const locationSql =
    `CASE WHEN $7::double precision IS NULL OR $8::double precision IS NULL
          THEN NULL
          ELSE ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography END`;

  const sr = await withTransaction(async (client) => {
  const run = client.query.bind(client) as typeof query;
  const res = await run<ServiceRequest>(
    `INSERT INTO service_requests
       (id, ref_no, category, severity, title, description, status, ward_code, location, street_address,
        street_number, reporter_member_id, councillor_member_id, sla_due_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'reported', $9, ${locationSql}, $10,
             $15,
             (SELECT id FROM members WHERE created_by = $11 LIMIT 1),
             (SELECT id FROM members WHERE created_by = $12 LIMIT 1),
             $13, $14)
     RETURNING *`,
    [
      id, refNo, input.category, input.severity, input.title, input.description,
      input.lng ?? null, input.lat ?? null, wardCode, input.streetAddress ?? null,
      principal.sub, principal.sub, slaDue, principal.sub, input.streetNumber ?? null,
    ],
  );

  const sr = res.rows[0]!;

  // Store captured attachments (photo / video / voice note) first through the
  // shared media pipeline, then link them ordered by seq — mirrors resident
  // reports. loadMediaForPrincipal() serves them back under the case's
  // ward-scoped privacy tier.
  for (let i = 0; i < mediaItems.length; i++) {
    const m = mediaItems[i]!;
    const stored = await uploadMedia(
      { dataUrl: m.dataUrl, captureMode: m.captureMode, lat: input.lat, lng: input.lng },
      principal, client,
    );
    await run(
      `INSERT INTO service_request_media (service_request_id, media_asset_id, seq)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [sr.id, stored.id, i],
    );
  }

  // Create initial timeline event
  await run(
    `INSERT INTO service_request_events (id, service_request_id, from_status, to_status, actor_member_id, note)
     VALUES ($1, $2, NULL, 'reported', (SELECT id FROM members WHERE created_by = $3 LIMIT 1), $4)`,
    [randomUUID(), sr.id, principal.sub, 'Service request created'],
  );
  return sr;
  });

  await recordAudit({
    action: 'service_request.create',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'service_request',
    targetId: sr.id,
    regionCode: wardCode,
    metadata: { refNo: sr.ref_no, category: sr.category, severity: sr.severity, mediaCount: mediaItems.length },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return sr;
}

/** Human-readable timeline note for a follow-up sub-state transition. */
const FOLLOW_UP_LABEL: Record<string, string> = {
  none: 'Follow-up cleared',
  awaiting: 'Follow-up scheduled',
  done: 'Follow-up completed',
  engaged: 'Engaged on this case',
};

export async function updateServiceRequest(
  id: string,
  input: z.infer<typeof updateServiceRequestSchema>,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<ServiceRequest> {
  const existing = await query<ServiceRequest>(
    'SELECT * FROM service_requests WHERE id = $1',
    [id],
  );
  // A malformed/absent id used to escape as a bare Error and surface as a 500.
  if (!existing.rows[0]) throw ApiError.notFound('Service request not found');

  const sr = existing.rows[0];
  // A ward_councillor could previously change the status of, or close, a case
  // in ANY ward: `case:update` / `case:close` were checked, territory was not.
  await assertCaseVisible(sr, principal);
  const fromStatus = sr.status;
  const toStatus = input.status ?? fromStatus;

  const updates: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (input.status) {
    updates.push(`status = $${paramIdx++}`);
    params.push(input.status);
    if (input.status === 'resolved') updates.push(`resolved_at = now()`);
    if (input.status === 'verified') updates.push(`verified_at = now()`);
    if (input.status === 'closed') updates.push(`closed_at = now()`);
  }
  if (input.municipalityRef) {
    updates.push(`municipality_ref = $${paramIdx++}`);
    params.push(input.municipalityRef);
  }
  const fromFollowUp = sr.follow_up_state;
  if (input.followUpState && input.followUpState !== fromFollowUp) {
    updates.push(`follow_up_state = $${paramIdx++}`);
    params.push(input.followUpState);
  }

  if (updates.length === 0 && !input.note?.trim()) return sr;

  updates.push(`updated_at = now()`);
  params.push(id);

  const res = await query<ServiceRequest>(
    `UPDATE service_requests SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    params,
  );

  const updated = res.rows[0]!;

  // Create timeline event
  if (input.status || (input.note?.trim() && (!input.followUpState || input.followUpState === fromFollowUp))) {
    await query(
      `INSERT INTO service_request_events (id, service_request_id, from_status, to_status, actor_member_id, note)
       VALUES ($1, $2, $3, $4, (SELECT id FROM members WHERE created_by = $5 LIMIT 1), $6)`,
      [randomUUID(), id, fromStatus, toStatus, principal.sub, input.note ?? `Status changed to ${toStatus}`],
    );
  }

  // Follow-up sub-state is an independent signal, so it writes its own timeline
  // row (from_status = to_status = the resulting status) describing the
  // transition — same shape as a status change but never colliding with it.
  if (input.followUpState && input.followUpState !== fromFollowUp) {
    const label = FOLLOW_UP_LABEL[input.followUpState] ?? `Follow-up set to ${input.followUpState}`;
    // When a status change accompanies the follow-up, any user note already rides
    // the status event; otherwise attach it here so it isn't lost.
    const followNote = !input.status && input.note?.trim() ? `${label} — ${input.note.trim()}` : label;
    await query(
      `INSERT INTO service_request_events (id, service_request_id, from_status, to_status, actor_member_id, note)
       VALUES ($1, $2, $3, $4, (SELECT id FROM members WHERE created_by = $5 LIMIT 1), $6)`,
      [randomUUID(), id, toStatus, toStatus, principal.sub, followNote],
    );
  }

  await recordAudit({
    action: 'service_request.update',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'service_request',
    targetId: id,
    regionCode: sr.ward_code,
    metadata: { fromStatus, toStatus, referenceChanged: !!input.municipalityRef, fromFollowUp, followUpState: input.followUpState },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return updated;
}

export async function listServiceRequests(
  query_: z.infer<typeof listServiceRequestsQuery>,
  principal: Principal,
): Promise<{ rows: ServiceRequest[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (query_.ward) {
    conditions.push(`ward_code = $${paramIdx++}`);
    params.push(query_.ward);
  }
  if (query_.category) {
    conditions.push(`category = $${paramIdx++}`);
    params.push(query_.category);
  }
  if (query_.status) {
    conditions.push(`status = $${paramIdx++}`);
    params.push(query_.status);
  }

  // Territory is applied LAST and AND-ed with any `?ward=` the caller supplied,
  // so a ward-scoped principal asking for another ward gets the intersection —
  // nothing — rather than that ward's cases. Previously `?ward=` REPLACED the
  // principal's own ward, and a regional_organizer (who has no `wardCode`) got
  // no filter at all and therefore every case in the country.
  const scope = await wardCodeScope(principal, 'ward_code', paramIdx);
  params.push(...scope.params);
  paramIdx = scope.nextIndex;
  if (scope.sql) conditions.push(scope.sql.replace(/^\s*AND\s*/, ''));

  // FR-E visibility tier: `private` cases are for party staff only. A member or
  // an analyst must not receive the record; the public ward overview exposes
  // the private count as an aggregate instead.
  const tier = privateTierClause(principal);
  if (tier) conditions.push(tier.replace(/^\s*AND\s*/, ''));

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM service_requests ${where}`,
    params,
  );
  const total = Number(countRes.rows[0]?.total ?? 0);

  params.push(query_.limit, query_.offset);
  const res = await query<ServiceRequest>(
    `SELECT * FROM service_requests ${where}
     ORDER BY created_at DESC
     LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
    params,
  );

  return { rows: res.rows, total };
}

/**
 * One case, subject to the caller's territory and the FR-E visibility tier.
 * Throws 403 when the case exists but is outside the caller's ward/region or is
 * a private case and the caller is not staff — previously any `case:read`
 * holder could open any case in the country by id.
 */
export async function getServiceRequest(
  id: string,
  principal: Principal,
): Promise<ServiceRequest | null> {
  const res = await query<ServiceRequest>(
    'SELECT * FROM service_requests WHERE id = $1',
    [id],
  );
  const sr = res.rows[0];
  if (!sr) return null;
  await assertCaseVisible(sr, principal);
  return sr;
}

/** Shared territory + visibility-tier gate for a single case row. */
async function assertCaseVisible(sr: ServiceRequest, principal: Principal): Promise<void> {
  if (sr.visibility === 'private' && !canSeePrivate(principal)) {
    throw ApiError.forbidden('This case is private to party staff');
  }
  if (sr.ward_code && !(await principalSeesWard(principal, sr.ward_code))) {
    throw ApiError.forbidden('This case belongs to another ward');
  }
}

export async function getServiceRequestTimeline(id: string): Promise<Array<{
  id: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
  created_at: string;
}>> {
  const res = await query(
    `SELECT id, from_status, to_status, note, created_at
     FROM service_request_events
     WHERE service_request_id = $1
     ORDER BY created_at ASC`,
    [id],
  );
  return res.rows;
}
