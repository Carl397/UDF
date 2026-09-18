import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { query, withTransaction } from '../../db/pool.js';
import type { PoolClient } from 'pg';
import { applyReportAction, reportWorkflowView } from './reportWorkflow.js';
import { getMediaPolicy, parseCapturedMedia, validateMediaBatch } from './mediaPolicy.js';
import { ApiError } from '../../http/errors.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { recordAudit } from '../../security/audit.js';
import { openRecord } from '../../security/encryption.js';
import { notify } from '../notifications/service.js';
import { Permission, type Principal } from '../../auth/permissions.js';
import { principalSeesWard, wardCodeScope } from '../../auth/scope.js';
import type { CreateResidentReport, CreateTransparencyRating, UpdateResidentReport, UploadMedia, WardLookupQuery } from './schemas.js';

/**
 * Ward transparency & accountability (PRD Phase 4.5).
 *
 * Tiers:
 *  - overview (FR-C): PII-free aggregates, open to anyone, for ANY ward.
 *  - detail  (FR-D): per-item records, members of that ward only.
 *  - private (FR-E): category+overview only, authorised staff only.
 *
 * All queries return NON-PII data. Councillor display identity comes from the
 * public `leaders` directory, never from sealed member PII.
 */

export interface WardRef {
  code: string;
  name: string;
}

export interface CouncillorRef {
  memberId: string | null;
  fullName: string;
  bio: string | null;
  contactPublic: Record<string, unknown>;
  /** media_assets id of the published leader photo, if any. */
  photoId: string | null;
}

export interface WardOverview {
  ward: WardRef;
  councillor: CouncillorRef | null;
  vacant: boolean;
  patrols30d: number;
  patrols90d: number;
  casesActive: number;
  casesResolved: number;
  privateLogs: number;
  projectsActive: number;
  projectsDelivered: number;
  bulletins: number;
  ratingMean: number | null;
  ratingCount: number;
}

/** FR-B: resolve the ward containing a point. Raw coords are NOT persisted. */
export async function resolveWardByPoint(q: WardLookupQuery): Promise<WardRef | null> {
  const res = await query<{ code: string; name: string }>(
    `SELECT code, name
       FROM regions
      WHERE level = 'ward'
        AND geom IS NOT NULL
        AND ST_Intersects(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
      LIMIT 1`,
    [q.lng, q.lat],
  );
  return res.rows[0] ?? null;
}

/**
 * Reverse-geocode a point to a human street + area label.
 *
 * The mobile app is deliberately tile-free and never talks to a map provider,
 * so the street lookup is done here on the server (best-effort): the resident's
 * device only ever calls the UDF API. The "area" is authoritative — it is the
 * UDF ward the point falls in (from our own boundary geometry) — while the
 * "street"/"suburb" come from the configured geocoder and degrade to null if it
 * is disabled, slow or unreachable. A failure here never breaks the caller.
 */
export interface ReverseGeocodeResult {
  ward: WardRef | null;
  street: string | null;
  suburb: string | null;
  /** Best area label: the geocoder's suburb/town, else the UDF ward name. */
  area: string | null;
  /** One-line "street, area" for display; null when nothing resolved. */
  label: string | null;
  city: string | null;
  postcode: string | null;
  /**
   * The full street details — house number, road, suburb, city and postcode as
   * one line. Used where the complete address matters (a patrol stop is a
   * physical place a councillor must be able to return to), while `label` stays
   * the short two-part form for compact rows.
   */
  fullAddress: string | null;
}

async function fetchStreetAddress(
  lat: number,
  lng: number,
): Promise<{ street: string | null; suburb: string | null; city: string | null; postcode: string | null }> {
  const empty = { street: null, suburb: null, city: null, postcode: null };
  const template = env.GEOCODER_URL.trim();
  if (!template) return empty;
  const url = template.replace('{lat}', String(lat)).replace('{lon}', String(lng));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': env.GEOCODER_USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) return empty;
    const body: any = await res.json();
    const a = body?.address ?? {};
    const houseNo = a.house_number ? `${a.house_number} ` : '';
    const road = a.road ?? a.pedestrian ?? a.footway ?? a.residential ?? null;
    const street = road ? `${houseNo}${road}`.trim() : null;
    const suburb = a.suburb ?? a.neighbourhood ?? a.residential ?? a.village ?? a.city_district ?? null;
    const city = a.city ?? a.town ?? a.municipality ?? a.county ?? null;
    return { street, suburb, city, postcode: a.postcode ?? null };
  } catch {
    // Timeout / offline / provider error — the ward name still carries the area.
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

export async function reverseGeocode(q: WardLookupQuery): Promise<ReverseGeocodeResult> {
  const [ward, addr] = await Promise.all([
    resolveWardByPoint(q),
    fetchStreetAddress(q.lat, q.lng),
  ]);
  const area = addr.suburb ?? addr.city ?? ward?.name ?? null;
  const label = [addr.street, area].filter(Boolean).join(', ') || null;
  // Deduplicate: suburb and city can be the same string, and the ward name is
  // only worth appending when the geocoder gave us no locality at all.
  const parts = [addr.street, addr.suburb, addr.city, addr.postcode].filter(Boolean) as string[];
  const unique = parts.filter((p, i) => parts.findIndex((q2) => q2.toLowerCase() === p.toLowerCase()) === i);
  if (unique.length === 0 && ward?.name) unique.push(ward.name);
  const fullAddress = unique.join(', ') || null;
  return {
    ward,
    street: addr.street,
    suburb: addr.suburb,
    area,
    label,
    city: addr.city,
    postcode: addr.postcode,
    fullAddress,
  };
}

/** Current ward councillor from the public leadership directory. */
export async function councillorForWard(wardCode: string): Promise<CouncillorRef | null> {
  const res = await query<{
    member_id: string | null;
    full_name: string;
    bio: string | null;
    contact_public: Record<string, unknown>;
    photo_id: string | null;
  }>(
    `SELECT l.member_id, l.full_name, l.bio, l.contact_public, l.photo_id
       FROM leaders l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.ward_code = $1 AND l.is_public
        AND (l.user_id IS NULL OR (u.is_active AND u.role = 'ward_councillor' AND u.ward_code = l.ward_code))
      ORDER BY (l.user_id IS NOT NULL) DESC,
        EXISTS (SELECT 1 FROM ward_profiles wp WHERE wp.ward_code = $1 AND wp.councillor_member_id = l.member_id) DESC,
        l.updated_at DESC, l.id
      LIMIT 1`,
    [wardCode],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    memberId: row.member_id,
    fullName: row.full_name,
    bio: row.bio,
    contactPublic: row.contact_public ?? {},
    photoId: row.photo_id,
  };
}

/** FR-C: aggregate, PII-free overview for any ward. */
export async function getOverview(wardCode: string): Promise<WardOverview | null> {
  const ward = await query<{ code: string; name: string }>(
    `SELECT code, name FROM regions WHERE code = $1 AND level = 'ward'`,
    [wardCode],
  );
  if (!ward.rows[0]) return null;

  const councillor = await councillorForWard(wardCode);

  const counts = await query<{
    patrols30: string; patrols90: string;
    cases_active: string; cases_resolved: string; private_logs: string;
    proj_active: string; proj_done: string; bulletins: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM patrols
         WHERE ward_code = $1 AND visibility <> 'private'
           AND COALESCE(started_at, planned_date::timestamptz) >= now() - interval '30 days') AS patrols30,
       (SELECT count(*)::text FROM patrols
         WHERE ward_code = $1 AND visibility <> 'private'
           AND COALESCE(started_at, planned_date::timestamptz) >= now() - interval '90 days') AS patrols90,
       (SELECT count(*)::text FROM service_requests
         WHERE ward_code = $1 AND visibility <> 'private' AND merged_into IS NULL
           AND status IN ('reported','triaged','logged','submitted','in_progress','escalated','reopened')) AS cases_active,
       (SELECT count(*)::text FROM service_requests
         WHERE ward_code = $1 AND visibility <> 'private' AND merged_into IS NULL
           AND status IN ('resolved','verified','closed')) AS cases_resolved,
       (SELECT count(*)::text FROM service_requests
         WHERE ward_code = $1 AND visibility = 'private') AS private_logs,
       (SELECT count(*)::text FROM projects
         WHERE ward_code = $1 AND is_published AND stage <> 'delivered') AS proj_active,
       (SELECT count(*)::text FROM projects
         WHERE ward_code = $1 AND is_published AND stage = 'delivered') AS proj_done,
       (SELECT count(*)::text FROM ward_bulletins
         WHERE ward_code = $1 AND status = 'published') AS bulletins`,
    [wardCode],
  );
  const c = counts.rows[0];

  let ratingMean: number | null = null;
  let ratingCount = 0;
  if (councillor?.memberId) {
    const r = await query<{ mean: string | null; n: string }>(
      `SELECT AVG(rating)::text AS mean, count(*)::text AS n
         FROM ratings WHERE target_type = 'councillor' AND target_id = $1`,
      [councillor.memberId],
    );
    ratingMean = r.rows[0]?.mean ? Number(Number(r.rows[0].mean).toFixed(2)) : null;
    ratingCount = Number(r.rows[0]?.n ?? 0);
  }

  return {
    ward: ward.rows[0],
    councillor,
    vacant: !councillor,
    patrols30d: Number(c?.patrols30 ?? 0),
    patrols90d: Number(c?.patrols90 ?? 0),
    casesActive: Number(c?.cases_active ?? 0),
    casesResolved: Number(c?.cases_resolved ?? 0),
    privateLogs: Number(c?.private_logs ?? 0),
    projectsActive: Number(c?.proj_active ?? 0),
    projectsDelivered: Number(c?.proj_done ?? 0),
    bulletins: Number(c?.bulletins ?? 0),
    ratingMean,
    ratingCount,
  };
}

export interface WardDetail {
  ward: WardRef;
  patrols: Array<{
    id: string; date: string | null; mode: string; purpose: string | null;
    status: string; distanceM: number | null; remarks: string | null;
    ratingMean: number | null; ratingCount: number;
  }>;
  projects: Array<{
    id: string; title: string; stage: string; progressPct: number | null;
    media: Array<{ stage: string; mediaId: string; contentType: string; caption: string | null }>;
    ratingMean: number | null; ratingCount: number;
  }>;
  logs: Array<{
    id: string; refNo: string; category: string; severity: string; title: string;
    status: string; createdAt: string; resolvedAt: string | null;
    media: Array<{ mediaId: string; contentType: string }>;
    ratingMean: number | null; ratingCount: number;
  }>;
}

/** FR-D: member-gated detail. Caller must verify ward membership. */
export async function getDetail(wardCode: string): Promise<WardDetail | null> {
  const ward = await query<{ code: string; name: string }>(
    `SELECT code, name FROM regions WHERE code = $1 AND level = 'ward'`,
    [wardCode],
  );
  if (!ward.rows[0]) return null;

  const patrols = await query<{
    id: string; date: string | null; mode: string; purpose: string | null;
    status: string; distance_m: string | null; summary: string | null;
  }>(
    `SELECT id, COALESCE(started_at, planned_date::timestamptz)::text AS date,
            mode, purpose, status, distance_m::text, summary
       FROM patrols
      WHERE ward_code = $1 AND visibility <> 'private'
      ORDER BY COALESCE(started_at, planned_date::timestamptz) DESC NULLS LAST
      LIMIT 50`,
    [wardCode],
  );

  const projects = await query<{ id: string; title: string; stage: string; progress_pct: number | null }>(
    `SELECT id, title, stage, progress_pct
       FROM projects
      WHERE ward_code = $1 AND is_published
      ORDER BY created_at DESC LIMIT 50`,
    [wardCode],
  );
  const projectIds = projects.rows.map((p) => p.id);
  const stageMedia = projectIds.length
    ? await query<{ project_id: string; stage: string; media_id: string; content_type: string; caption: string | null }>(
        `SELECT pm.project_id, pm.stage, pm.media_id, ma.content_type, pm.caption
           FROM project_media pm JOIN media_assets ma ON ma.id = pm.media_id
          WHERE pm.project_id = ANY($1) ORDER BY pm.captured_at`,
        [projectIds],
      )
    : { rows: [] as Array<{ project_id: string; stage: string; media_id: string; content_type: string; caption: string | null }> };

  const logs = await query<{
    id: string; ref_no: string; category: string; severity: string; title: string;
    status: string; created_at: string; resolved_at: string | null;
  }>(
    `SELECT id, ref_no, category, severity, title, status, created_at::text, resolved_at::text
       FROM service_requests
      WHERE ward_code = $1 AND visibility <> 'private' AND merged_into IS NULL
      ORDER BY created_at DESC LIMIT 50`,
    [wardCode],
  );
  const logIds = logs.rows.map((l) => l.id);
  const logMedia = logIds.length
    ? await query<{ service_request_id: string; media_id: string; content_type: string }>(
        `SELECT srm.service_request_id, srm.media_asset_id AS media_id, ma.content_type
           FROM service_request_media srm JOIN media_assets ma ON ma.id = srm.media_asset_id
          WHERE srm.service_request_id = ANY($1)`,
        [logIds],
      )
    : { rows: [] as Array<{ service_request_id: string; media_id: string; content_type: string }> };

  // Per-item rating aggregates for everything returned + privacy-filtered.
  const allIds = [
    ...patrols.rows.map((p) => p.id),
    ...projectIds,
    ...logIds,
  ];
  const ratingRows = allIds.length
    ? await query<{ target_type: string; target_id: string; mean: string; n: string }>(
        `SELECT target_type, target_id, AVG(rating)::text AS mean, count(*)::text AS n
           FROM ratings WHERE target_id = ANY($1) GROUP BY target_type, target_id`,
        [allIds],
      )
    : { rows: [] as Array<{ target_type: string; target_id: string; mean: string; n: string }> };
  const ratingMap = new Map(ratingRows.rows.map((r) => [r.target_id, r]));
  const ratingOf = (id: string) => {
    const r = ratingMap.get(id);
    return r
      ? { ratingMean: Number(Number(r.mean).toFixed(2)), ratingCount: Number(r.n) }
      : { ratingMean: null, ratingCount: 0 };
  };

  return {
    ward: ward.rows[0],
    patrols: patrols.rows.map((p) => ({
      id: p.id, date: p.date, mode: p.mode, purpose: p.purpose, status: p.status,
      distanceM: p.distance_m ? Number(p.distance_m) : null,
      remarks: p.summary, // `summary` is the councillor's patrol remarks
      ...ratingOf(p.id),
    })),
    projects: projects.rows.map((p) => ({
      id: p.id, title: p.title, stage: p.stage, progressPct: p.progress_pct,
      media: stageMedia.rows
        .filter((m) => m.project_id === p.id)
        .map((m) => ({ stage: m.stage, mediaId: m.media_id, contentType: m.content_type, caption: m.caption })),
      ...ratingOf(p.id),
    })),
    logs: logs.rows.map((l) => ({
      id: l.id, refNo: l.ref_no, category: l.category, severity: l.severity,
      title: l.title, status: l.status, createdAt: l.created_at, resolvedAt: l.resolved_at,
      media: logMedia.rows
        .filter((m) => m.service_request_id === l.id)
        .map((m) => ({ mediaId: m.media_id, contentType: m.content_type })),
      ...ratingOf(l.id),
    })),
  };
}

/** FR-D5: ward-member rating with one-per-target + mandatory reason when <=2. */
export async function createRating(
  input: CreateTransparencyRating,
  principal: Principal,
  ctx: { ip: string | null; userAgent: string | null },
) {
  if (input.rating <= 2 && !input.reason?.trim()) {
    throw ApiError.badRequest('A reason is required for ratings of 2 or below');
  }
  const member = await query<{ id: string; ward: string | null }>(
    `SELECT id, ward FROM members WHERE created_by = $1 AND deleted_at IS NULL LIMIT 1`,
    [principal.sub],
  );
  const memberRow = member.rows[0];
  if (!memberRow) {
    throw ApiError.forbidden('No member profile linked to this account');
  }
  const memberId = memberRow.id;
  // Ward gate: the target must belong to the member's own ward.
  const ward = memberRow.ward;
  const targetWard = await targetWardOf(input.targetType, input.targetId);
  if (!ward || !targetWard || targetWard !== ward) {
    throw ApiError.forbidden('You can only rate work logged in your own ward');
  }
  // A councillor may not rate their own work.
  if (input.targetType === 'councillor' && input.targetId === memberId) {
    throw ApiError.conflict('You cannot rate your own work');
  }

  const res = await query<{ id: string }>(
    `INSERT INTO ratings (target_type, target_id, member_id, rating, reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (member_id, target_type, target_id) DO UPDATE
       SET rating = EXCLUDED.rating, reason = EXCLUDED.reason
     RETURNING id`,
    [input.targetType, input.targetId, memberId, input.rating, input.reason ?? null],
  );
  await recordAudit({
    action: 'transparency.rating.create',
    actorId: principal.sub, actorRole: principal.role,
    targetType: input.targetType, targetId: input.targetId,
    regionCode: ward, metadata: { rating: input.rating },
    ip: ctx.ip, userAgent: ctx.userAgent,
  });
  const ratingRow = res.rows[0];
  if (!ratingRow) throw new Error('Rating insert failed');
  return { id: ratingRow.id };
}

async function targetWardOf(targetType: string, targetId: string): Promise<string | null> {
  const sql =
    targetType === 'service_request'
      ? `SELECT ward_code FROM service_requests WHERE id = $1`
      : targetType === 'project'
        ? `SELECT ward_code FROM projects WHERE id = $1`
        : targetType === 'patrol'
          ? `SELECT ward_code FROM patrols WHERE id = $1`
          : `SELECT ward_code FROM leaders WHERE member_id = $1`;
  const res = await query<{ ward_code: string | null }>(sql, [targetId]);
  return res.rows[0]?.ward_code ?? null;
}

// ── Minimal media pipeline (stage imagery + reported pictures) ─────────────
const UPLOAD_DIR = resolve(process.cwd(), 'uploads');

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/m4a': '.m4a', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/webm': '.webm',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/aac': '.aac',
};

/** Councillor/staff capture upload: base64 data-url -> disk + media_assets row. */
export async function uploadMedia(input: UploadMedia, principal: Principal, client?: PoolClient, purpose: 'attachment' | 'profile' = 'attachment') {
  const run = client ? client.query.bind(client) as typeof query : query;
  const { contentType, buffer: buf, kind } = parseCapturedMedia(input.dataUrl, input.captureMode);
  if (purpose === 'attachment') {
    const policy = await getMediaPolicy();
    if (!policy[kind]) throw ApiError.forbidden(`${kind} attachments are disabled by the administrator`);
  }
  if (input.projectId) {
    const project = await run('SELECT ward_code FROM projects WHERE id = $1', [input.projectId]);
    if (!project.rows[0]?.ward_code || !(await principalSeesWard(principal, project.rows[0].ward_code))) {
      throw ApiError.forbidden('Project outside your territory');
    }
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  const id = randomUUID();
  const rel = `uploads/${id}${EXT_BY_TYPE[contentType] ?? '.bin'}`;
  await writeFile(join(process.cwd(), rel), buf);

  const hash = createHash('sha256').update(buf).digest('hex');
  const hasGeo = input.lat != null && input.lng != null;
  const res = hasGeo
    ? await run<{ id: string }>(
        `INSERT INTO media_assets
           (storage_key, content_type, capture_mode, exif_geo, accuracy_m, hash, created_by)
         VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $7, $8)
         RETURNING id`,
        [rel, contentType, input.captureMode, input.lng, input.lat, input.accuracyM ?? null, hash, principal.sub],
      )
    : await run<{ id: string }>(
        `INSERT INTO media_assets
           (storage_key, content_type, capture_mode, accuracy_m, hash, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [rel, contentType, input.captureMode, input.accuracyM ?? null, hash, principal.sub],
      );
  const mediaRow = res.rows[0];
  if (!mediaRow) throw new Error('Media insert failed');
  const mediaId = mediaRow.id;
  if (input.projectId && input.stage) {
    await run(
      `INSERT INTO project_media (project_id, stage, media_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [input.projectId, input.stage, mediaId],
    );
  }
  return { id: mediaId, url: `/api/transparency/media/${mediaId}` };
}

/** Resolve a media file for serving, enforcing the privacy tier. */
export async function loadMediaForPrincipal(mediaId: string, principal: Principal) {
  const asset = await query<{ storage_key: string; content_type: string; created_by: string | null }>(
    `SELECT storage_key, content_type, created_by FROM media_assets WHERE id = $1`,
    [mediaId],
  );
  if (!asset.rows[0]) return null;

  // Determine the most restrictive linked visibility + ward.
  const link = await query<{ ward_code: string | null; visibility: string; owner_user_id: string | null; permission: Permission | null }>(
    `SELECT sr.ward_code, sr.visibility, NULL::uuid AS owner_user_id, 'case:read'::text AS permission
       FROM service_request_media srm JOIN service_requests sr ON sr.id = srm.service_request_id
      WHERE srm.media_asset_id = $1
      UNION ALL
     SELECT p.ward_code, 'members', NULL::uuid, NULL::text FROM project_media pm JOIN projects p ON p.id = pm.project_id
      WHERE pm.media_id = $1
      UNION ALL
     SELECT rr.ward_code, 'private', rr.user_id, 'report:read'::text
       FROM resident_report_media rrm JOIN resident_reports rr ON rr.id = rrm.report_id
      WHERE rrm.media_asset_id = $1
      UNION ALL
     SELECT pt.ward_code, pt.visibility, NULL::uuid, 'patrol:read'::text
       FROM patrol_media pam JOIN patrols pt ON pt.id = pam.patrol_id
      WHERE pam.media_asset_id = $1
      UNION ALL
     SELECT pt.ward_code, pt.visibility, NULL::uuid, 'patrol:read'::text
       FROM patrol_stops ps JOIN patrols pt ON pt.id = ps.patrol_id WHERE ps.photo_id = $1`,
    [mediaId],
  );
  const staff = ['national_admin', 'regional_organizer', 'local_coordinator', 'ward_councillor'].includes(principal.role);
  for (const row of link.rows) {
    const owner = row.owner_user_id === principal.sub;
    const ownerCanRead = owner && row.permission === Permission.REPORT_READ && principal.permissions?.includes(Permission.REPORT_WRITE);
    if (row.permission && !principal.permissions?.includes(row.permission) && !ownerCanRead) {
      throw ApiError.forbidden('Media module is not available');
    }
    if (owner) continue;
    if (row.visibility === 'private' && !staff) throw ApiError.forbidden('Media is private');
    if (row.visibility !== 'public' && !(principal.role === 'national_admin' || (row.ward_code && await principalSeesWard(principal, row.ward_code)))) {
      throw ApiError.forbidden('Media belongs to another ward');
    }
  }
  if (!link.rows.length && asset.rows[0].created_by !== principal.sub && principal.role !== 'national_admin') {
    const published = await query('SELECT id FROM leaders WHERE photo_id = $1 AND is_public', [mediaId]);
    if (!published.rows.length) throw ApiError.forbidden('Unpublished media is private to its uploader');
  }

  const file = await readFile(join(process.cwd(), asset.rows[0].storage_key));
  return { buffer: file, contentType: asset.rows[0].content_type };
}

// ── Resident → ward councillor reports ────────────────────────────────────
const STAFF_ROLES = ['national_admin', 'regional_organizer', 'local_coordinator', 'ward_councillor'];

export interface ResidentReportMedia {
  mediaId: string;
  contentType: string;
  captureMode: string;
}

export interface ResidentReportView {
  id: string;
  refNo: string;
  category: string;
  message: string;
  wardCode: string | null;
  status: string;
  /** Follow-up note written back to the resident (null until staff respond). */
  feedback: string | null;
  respondedAt: string | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  media: ResidentReportMedia[];
  createdAt: string;
}

function reportRef(): string {
  return `RR-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
}

/**
 * A resident/member sends information to their ward councillor. Media reuse the
 * existing capture pipeline; the ward is resolved from the supplied point, else
 * the caller's ward claim, else their member profile. The ward's active
 * councillor(s) get an in-app notification. Privately scoped (author + staff).
 */
export async function createResidentReport(
  input: CreateResidentReport,
  principal: Principal,
  ctx: { ip: string | null; userAgent: string | null },
) {
  const result = await withTransaction(async (client) => {
    const run = client.query.bind(client) as typeof query;
    if (input.requestId) {
      await run('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [principal.sub, input.requestId]);
      const previous = await run(`SELECT id, ref_no AS "refNo", status, ward_code AS "wardCode",
        (councillor_user_id IS NOT NULL) AS routed,
        (SELECT count(*)::int FROM resident_report_media WHERE report_id = r.id) AS "mediaCount"
        FROM resident_reports r WHERE user_id = $1 AND request_id = $2`, [principal.sub, input.requestId]);
      if (previous.rows[0]) return { report: previous.rows[0], created: false };
    }
    const member = (await run<{ id: string; ward: string | null }>(
      `SELECT m.id, m.ward FROM members m JOIN users u ON u.member_id = m.id
       WHERE u.id = $1 AND m.deleted_at IS NULL`, [principal.sub])).rows[0];
    let wardCode = input.wardCode ?? principal.wardCode ?? member?.ward ?? null;
    if (input.lat != null && input.lng != null) {
      const ward = await resolveWardByPoint({ lat: input.lat, lng: input.lng, accuracyM: input.accuracyM });
      if (!ward) throw ApiError.badRequest('No supported ward at this location. Remove the location to use your registered ward.');
      if (input.wardCode && input.wardCode !== ward.code) throw ApiError.badRequest('Ward does not match the incident location');
      wardCode = ward.code;
    }
    if (wardCode && !(await run("SELECT 1 FROM regions WHERE code = $1 AND level = 'ward'", [wardCode])).rowCount) {
      throw ApiError.badRequest('Unknown ward');
    }
    await validateMediaBatch(input.media);
    const councillor = wardCode ? (await run<{ id: string }>(
      `SELECT id FROM users WHERE role = 'ward_councillor' AND ward_code = $1 AND is_active
       ORDER BY created_at, id LIMIT 1 FOR SHARE`, [wardCode])).rows[0] : null;
    const ref = reportRef();
    const reportId = (await run<{ id: string }>(
      `INSERT INTO resident_reports (ref_no, user_id, member_id, ward_code, category, message, location, accuracy_m, request_id, councillor_user_id)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($7,$8),4326)::geography END,$9,$10,$11)
       RETURNING id`, [ref, principal.sub, member?.id ?? null, wardCode, input.category, input.message,
         input.lng ?? null, input.lat ?? null, input.accuracyM ?? null, input.requestId ?? null, councillor?.id ?? null])).rows[0]!.id;
    for (const m of input.media) {
      const stored = await uploadMedia({ dataUrl: m.dataUrl, captureMode: m.captureMode, lat: input.lat, lng: input.lng, accuracyM: input.accuracyM }, principal, client);
      await run('INSERT INTO resident_report_media(report_id, media_asset_id) VALUES ($1,$2)', [reportId, stored.id]);
    }
    if (councillor) {
      await notify({ userId: councillor.id, kind: 'report', title: 'New resident report',
        body: 'Open the ward inbox to view this private report.', link: `tab:engage#report:${reportId}`, regionCode: wardCode }, client);
      await run(`INSERT INTO resident_report_outbox(report_id, user_id, channel, status)
        VALUES ($1,$2,'inapp','sent'), ($1,$2,'email','queued')`, [reportId, councillor.id]);
    }
    return { created: true, report: { id: reportId, refNo: ref, status: 'submitted', wardCode,
      mediaCount: input.media.length, routed: !!councillor } };
  });
  if (result.created) await recordAudit({ action: 'transparency.report.create', actorId: principal.sub, actorRole: principal.role,
    targetType: 'resident_report', targetId: result.report.id, regionCode: result.report.wardCode,
    metadata: { media: result.report.mediaCount, routed: result.report.routed }, ...ctx
  }).catch(() => logger.error({ reportId: result.report.id }, 'Report committed; audit write failed'));
  return result.report;
}

/**
 * List reports. Members see only their own; staff see their territory's inbox —
 * a ward councillor exactly one ward, a coordinator/regional organizer the
 * wards under their regions, national scope everything.
 */
export async function listResidentReports(
  principal: Principal,
  opts: { scope?: 'mine' | 'inbox'; limit?: number; offset?: number } = {},
): Promise<{ items: ResidentReportView[]; total: number }> {
  if ((opts.limit != null && (!Number.isInteger(opts.limit) || opts.limit < 1)) ||
      (opts.offset != null && (!Number.isInteger(opts.offset) || opts.offset < 0))) throw ApiError.badRequest('Invalid pagination');
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const staff = STAFF_ROLES.includes(principal.role);
  const inbox = opts.scope === 'inbox' && staff;

  const params: unknown[] = [];
  let where: string;
  if (!inbox) {
    params.push(principal.sub);
    where = `WHERE r.user_id = $${params.length}`;
  } else {
    // Previously this compared `r.ward_code` against `principal.regionCodes`,
    // which hold SUBCOUNCIL codes — the equality never matched, so a
    // local_coordinator or regional_organizer saw an empty inbox while a
    // ward_councillor was special-cased. Scope resolution is now centralised.
    const scope = await wardCodeScope(principal, 'r.ward_code', params.length + 1);
    params.push(...scope.params);
    where = scope.sql ? `WHERE TRUE${scope.sql}` : `WHERE TRUE`;
  }
  params.push(limit, offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const res = await query<{
    id: string; ref_no: string; category: string; message: string; ward_code: string | null;
    status: string; created_at: string; lat: number | null; lng: number | null;
    accuracy_m: number | null; media: ResidentReportMedia[]; total: string;
    feedback: string | null; responded_at: string | null;
  }>(
    `SELECT r.id, r.ref_no, r.category, r.message, r.ward_code, r.status, r.created_at::text,
            r.feedback, r.responded_at::text AS responded_at,
            ST_Y(r.location::geometry) AS lat, ST_X(r.location::geometry) AS lng, r.accuracy_m,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'mediaId', m.media_asset_id,
                       'contentType', ma.content_type,
                       'captureMode', ma.capture_mode) ORDER BY ma.created_at)
                FROM resident_report_media m JOIN media_assets ma ON ma.id = m.media_asset_id
               WHERE m.report_id = r.id
            ), '[]'::json) AS media,
            count(*) OVER ()::text AS total
       FROM resident_reports r
       ${where}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );

  const total = res.rows[0]?.total ?? (await query<{ total: string }>(`SELECT count(*)::text AS total FROM resident_reports r ${where}`, params.slice(0, -2))).rows[0]?.total ?? 0;
  return {
    total: Number(total),
    items: res.rows.map((r) => ({
      id: r.id, refNo: r.ref_no, category: r.category, message: r.message,
      wardCode: r.ward_code, status: r.status,
      feedback: r.feedback ?? null, respondedAt: r.responded_at ?? null,
      lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng),
      accuracyM: r.accuracy_m == null ? null : Number(r.accuracy_m),
      media: r.media ?? [], createdAt: r.created_at,
    })),
  };
}

/** One report with full message + media. Owner or ward staff only. */
export async function getResidentReport(
  id: string,
  principal: Principal,
): Promise<ResidentReportView | null> {
  const res = await query<{
    id: string; ref_no: string; category: string; message: string; ward_code: string | null;
    status: string; created_at: string; user_id: string; lat: number | null; lng: number | null;
    accuracy_m: number | null; media: ResidentReportMedia[];
    feedback: string | null; responded_at: string | null;
  }>(
    `SELECT r.id, r.ref_no, r.category, r.message, r.ward_code, r.status, r.created_at::text, r.user_id,
            r.feedback, r.responded_at::text AS responded_at,
            ST_Y(r.location::geometry) AS lat, ST_X(r.location::geometry) AS lng, r.accuracy_m,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'mediaId', m.media_asset_id,
                       'contentType', ma.content_type,
                       'captureMode', ma.capture_mode) ORDER BY ma.created_at)
                FROM resident_report_media m JOIN media_assets ma ON ma.id = m.media_asset_id
               WHERE m.report_id = r.id
            ), '[]'::json) AS media
       FROM resident_reports r WHERE r.id = $1`,
    [id],
  );
  const r = res.rows[0];
  if (!r) return null;

  const isOwner = r.user_id === principal.sub;
  const staff = STAFF_ROLES.includes(principal.role);
  // Being staff does not confer territory. The previous condition granted any
  // staff role that was not `ward_councillor` unconditional access, so a
  // local_coordinator scoped to one branch ward could open every resident
  // report in the country — including reports from residents who sent
  // information to a different councillor in confidence.
  const inTerritory = principal.role === 'national_admin' || (!!r.ward_code && (await principalSeesWard(principal, r.ward_code)));
  if (!isOwner && !(staff && inTerritory)) {
    throw ApiError.forbidden('You do not have access to this report');
  }

  return {
    ...(await reportWorkflowView(id, principal)),
    id: r.id, refNo: r.ref_no, category: r.category, message: r.message,
    wardCode: r.ward_code, status: r.status,
    feedback: r.feedback ?? null, respondedAt: r.responded_at ?? null,
    lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng),
    accuracyM: r.accuracy_m == null ? null : Number(r.accuracy_m),
    media: r.media ?? [], createdAt: r.created_at,
  };
}

/**
 * Staff move a resident report through its lifecycle and/or write follow-up
 * feedback to the resident. Territory-gated exactly like reading it: owner
 * access is not enough — only staff whose scope covers the report's ward may
 * update it. When feedback is written (or status changes), the resident who
 * filed the report gets an in-app notification so they see the follow-up.
 */
export async function updateResidentReport(
  id: string,
  input: UpdateResidentReport,
  principal: Principal,
  ctx: { ip: string | null; userAgent: string | null },
): Promise<ResidentReportView> {
  await applyReportAction(id, input, principal, ctx);

  const updated = await getResidentReport(id, principal);
  if (!updated) throw ApiError.internal('Report vanished after update');
  return updated;
}
