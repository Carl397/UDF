import { query } from '../../db/pool.js';
import { recordAudit } from '../../security/audit.js';
import { ApiError } from '../../http/errors.js';
import { isNationalScope, Role, type Principal } from '../../auth/permissions.js';
import { notify } from '../notifications/service.js';
import type { AdminConfig, CreateOpportunity, PatchOpportunity, UpsertInterest, WorkTypeUpsert } from './schemas.js';

/**
 * Ward Job Interest Register & Opportunity Relay (PRD-jobs).
 *
 * PRIVACY INVARIANT: the only personal data is a member's OWN job_interests row
 * (name + email + work types + experience). Every councillor/staff/analyst
 * surface reads AGGREGATE counts only — no query in this file returns another
 * person's name or email to a staff principal. The relay outbox (recipients) is
 * internal and is never returned by any route.
 */

/** Fallbacks when the DB-backed config (FR-N4) has no row yet. */
const STALE_DAYS_DEFAULT = 90;
const DUPLICATE_GUARD_DAYS_DEFAULT = 14;
const RELAY_SUBJECT_DEFAULT = 'Work opportunity in your ward — {ref}';
const RELAY_BODY_DEFAULT =
  'Hi {firstName},\n\nA work opportunity matching your skills is now open in your ward:\n\n' +
  '{title} at {company}\nReference: {ref}\n\nApply DIRECTLY to the company:\n{contact}\n\n' +
  'UDF never collects CVs and never shares your details with the employer. This is an indication only.';

// ── Runtime flags & config (PRD-jobs FR-N4 / §9.7 kill-switch) ───────────

/** Read a feature flag; unknown keys fall back to `fallback` (register/relay default on). */
async function isFlagEnabled(key: string, fallback: boolean): Promise<boolean> {
  const res = await query<{ enabled: boolean }>(`SELECT enabled FROM feature_flags WHERE key = $1`, [key]);
  const row = res.rows[0];
  return row ? row.enabled : fallback;
}

async function getConfigStr(key: string, fallback: string): Promise<string> {
  const res = await query<{ value: string }>(`SELECT value FROM job_config WHERE key = $1`, [key]);
  return res.rows[0]?.value ?? fallback;
}

/** Positive-integer config value (windows); falls back on missing/invalid rows. */
async function getConfigInt(key: string, fallback: number): Promise<number> {
  const n = Number.parseInt(await getConfigStr(key, String(fallback)), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Replace `{token}` placeholders in a relay template. */
function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}


function nn(s: string | undefined | null): string | null {
  const t = (s ?? '').trim();
  return t ? t : null;
}

// ── Types ────────────────────────────────────────────────────────────────

export interface InterestView {
  id: string;
  firstName: string;
  surname: string;
  email: string;
  workTypes: string[];
  experience: string | null;
  wardCode: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpportunityStats {
  matched: number;
  notifiedInapp: number;
  emailed: number;
  emailFailed: number;
}

export interface OpportunityView {
  id: string;
  refNo: string;
  wardCode: string;
  regionCode: string | null;
  title: string;
  company: string;
  workTypes: string[];
  description: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactUrl: string | null;
  projectId: string | null;
  status: string;
  publishedAt: string | null;
  closesAt: string | null;
  createdAt: string;
  stats?: OpportunityStats;
}

export interface DemandView {
  scope: string[] | 'all';
  total: number;
  availableNow: number;
  byWorkType: Array<{ code: string; label: string; count: number }>;
  trend: Array<{ day: string; count: number }>;
}

// ── Scoping helpers ──────────────────────────────────────────────────────

/** Ancestor region (level='region') of a ward, for region-scoped staff. */
async function regionOfWard(wardCode: string): Promise<string | null> {
  const res = await query<{ code: string }>(
    `WITH RECURSIVE up AS (
       SELECT code, level, parent_code FROM regions WHERE code = $1
       UNION ALL
       SELECT r.code, r.level, r.parent_code FROM regions r JOIN up ON r.code = up.parent_code
     )
     SELECT code FROM up WHERE level = 'region' LIMIT 1`,
    [wardCode],
  );
  return res.rows[0]?.code ?? null;
}

/** Filter the taxonomy to codes that exist and are active. */
async function activeWorkTypeCodes(codes: string[]): Promise<string[]> {
  const res = await query<{ code: string }>(
    `SELECT code FROM work_types WHERE active AND code = ANY($1)`,
    [Array.from(new Set(codes))],
  );
  const allowed = new Set(res.rows.map((r) => r.code));
  // Preserve the caller's order, dropping unknown/inactive codes.
  return Array.from(new Set(codes)).filter((c) => allowed.has(c));
}

/**
 * Wards a staff principal may see. `null` ⇒ national (all wards).
 * Members never reach this (they have no jobs:demand_read / opportunity_write).
 */
async function scopeWardsFor(p: Principal): Promise<string[] | null> {
  if (p.wardCode) return [p.wardCode];
  if (isNationalScope(p)) return null;
  const codes = p.regionCodes ?? [];
  if (codes.length === 0) return null;
  const res = await query<{ code: string }>(
    `SELECT code FROM regions WHERE level = 'ward' AND (parent_code = ANY($1) OR code = ANY($1))`,
    [codes],
  );
  return res.rows.map((r) => r.code);
}

/**
 * The member row this account OWNS. Prefers the canonical `users.member_id`
 * link set at onboarding (FR-P1); falls back to the legacy `created_by` guess
 * for accounts provisioned before that link existed. Mirrors the resolution in
 * recruitment/scorecards `memberForPrincipal()`.
 *
 * Resolving on `created_by` ALONE silently broke every genuinely-onboarded
 * member: a member row is created with `created_by = NULL` (self-registration)
 * or the registering STAFF's id — never the member's own user id — so
 * `PUT /jobs/interest` 403'd ("No member profile is linked to this account")
 * for real members. Only the jobs seed, which manufactures a row with
 * `created_by = user id`, matched the old lookup, which masked the bug locally.
 */
async function memberContext(p: Principal): Promise<{ memberId: string; ward: string | null }> {
  const res = await query<{ id: string; ward: string | null }>(
    `SELECT m.id, m.ward
       FROM members m
      WHERE m.deleted_at IS NULL
        AND m.id = COALESCE(
          (SELECT u.member_id FROM users u WHERE u.id = $1),
          (SELECT m2.id FROM members m2 WHERE m2.created_by = $1 AND m2.deleted_at IS NULL LIMIT 1)
        )
      LIMIT 1`,
    [p.sub],
  );
  const row = res.rows[0];
  if (!row) throw httpError(403, 'No member profile is linked to this account');
  return { memberId: row.id, ward: row.ward ?? p.wardCode ?? null };
}

/** Build a typed ApiError so the central error handler maps it to the right HTTP status. */
function httpError(status: number, message: string): ApiError {
  switch (status) {
    case 400: return ApiError.badRequest(message);
    case 403: return ApiError.forbidden(message);
    case 404: return ApiError.notFound(message);
    case 409: return ApiError.conflict(message);
    default: return new ApiError(status, 'error', message);
  }
}

// ── Interest register (FR-K) ─────────────────────────────────────────────

function interestView(r: {
  id: string; first_name: string; surname: string; email: string;
  work_types: string[]; experience: string | null; ward_code: string;
  status: string; created_at: string; updated_at: string;
}): InterestView {
  return {
    id: r.id, firstName: r.first_name, surname: r.surname, email: r.email,
    workTypes: r.work_types ?? [], experience: r.experience, wardCode: r.ward_code,
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const INTEREST_COLS = `id, first_name, surname, email, work_types, experience, ward_code, status, created_at::text, updated_at::text`;

/** The signed-in member's own active interest, or null. */
export async function getOwnInterest(p: Principal): Promise<InterestView | null> {
  const res = await query<any>(
    `SELECT ${INTEREST_COLS} FROM job_interests WHERE user_id = $1 AND status = 'active' LIMIT 1`,
    [p.sub],
  );
  const row = res.rows[0];
  return row ? interestView(row) : null;
}

/** Create-or-update the member's own interest (one active row per member). */
export async function upsertInterest(
  input: UpsertInterest,
  p: Principal,
  ctx: { ip: string | null; userAgent: string | null },
): Promise<InterestView> {
  // §9.7 kill-switch: when the register is disabled, members cannot add/edit.
  if (!(await isFlagEnabled('jobs.register', true))) {
    throw httpError(403, 'The ward work register is currently closed');
  }
  const member = await memberContext(p);
  const ward = member.ward;
  if (!ward) throw httpError(400, 'Your membership has no ward yet');
  const codes = await activeWorkTypeCodes(input.workTypes);
  if (codes.length === 0) throw httpError(400, 'Select at least one valid type of work');
  const region = await regionOfWard(ward);

  const res = await query<any>(
    `INSERT INTO job_interests
       (member_id, user_id, ward_code, region_code, first_name, surname, email, work_types, experience, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')
     ON CONFLICT (member_id) WHERE status = 'active'
     DO UPDATE SET first_name = EXCLUDED.first_name, surname = EXCLUDED.surname,
                   email = EXCLUDED.email, work_types = EXCLUDED.work_types,
                   experience = EXCLUDED.experience, ward_code = EXCLUDED.ward_code,
                   region_code = EXCLUDED.region_code, updated_at = now()
     RETURNING ${INTEREST_COLS}`,
    [member.memberId, p.sub, ward, region, input.firstName.trim(), input.surname.trim(),
     input.email.trim(), codes, nn(input.experience)],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Interest upsert failed');
  await refreshDemand(ward, region);
  await recordAudit({
    action: 'jobs.interest.upsert', actorId: p.sub, actorRole: p.role,
    targetType: 'job_interest', targetId: row.id, regionCode: ward,
    metadata: { workTypes: codes }, ip: ctx.ip, userAgent: ctx.userAgent,
  });
  return interestView(row);
}

/** Withdraw = hard delete of the member's own row (POPIA minimisation). */
export async function withdrawInterest(
  p: Principal,
  ctx: { ip: string | null; userAgent: string | null },
): Promise<{ deleted: number }> {
  const res = await query<{ ward_code: string; region_code: string | null }>(
    `DELETE FROM job_interests WHERE user_id = $1 AND status = 'active'
     RETURNING ward_code, region_code`,
    [p.sub],
  );
  const row = res.rows[0];
  if (row) await refreshDemand(row.ward_code, row.region_code);
  await recordAudit({
    action: 'jobs.interest.withdraw', actorId: p.sub, actorRole: p.role,
    targetType: 'job_interest', targetId: p.sub, regionCode: row?.ward_code ?? null,
    metadata: { deleted: res.rowCount ?? 0 }, ip: ctx.ip, userAgent: ctx.userAgent,
  });
  return { deleted: res.rowCount ?? 0 };
}

// ── Demand rollup + aggregate view (FR-L) ────────────────────────────────

/** Snapshot today's per-work-type + distinct ('*') active counts for a ward. */
export async function refreshDemand(wardCode: string, regionCode: string | null): Promise<void> {
  await query(`DELETE FROM job_demand_daily WHERE ward_code = $1 AND day = CURRENT_DATE`, [wardCode]);
  await query(
    `INSERT INTO job_demand_daily (ward_code, region_code, work_type, day, active_count)
     SELECT $1, $2, wt, CURRENT_DATE, count(*)::int
       FROM job_interests, unnest(work_types) AS wt
      WHERE ward_code = $1 AND status = 'active'
      GROUP BY wt`,
    [wardCode, regionCode],
  );
  await query(
    `INSERT INTO job_demand_daily (ward_code, region_code, work_type, day, active_count)
     SELECT $1, $2, '*', CURRENT_DATE, count(*)::int
       FROM job_interests WHERE ward_code = $1 AND status = 'active'`,
    [wardCode, regionCode],
  );
}

/**
 * Aggregate, PII-free ward work-demand. `ward` narrows to one ward (scope-checked);
 * otherwise the principal's whole scope is aggregated.
 */
export async function getDemand(p: Principal, ward?: string): Promise<DemandView> {
  const scope = await scopeWardsFor(p);
  let filter: string[] | null = scope;
  if (ward) {
    if (scope !== null && !scope.includes(ward)) throw httpError(403, 'Ward outside your scope');
    filter = [ward];
  }
  const all = filter === null;
  const wc = all ? '' : 'AND ward_code = ANY($1)';
  const params = all ? [] : [filter];
  const staleDays = await getConfigInt('jobs.demandStaleDays', STALE_DAYS_DEFAULT);

  const [totalRes, nowRes, byTypeRes, labelsRes, trendRes] = await Promise.all([
    query<{ c: string }>(`SELECT count(*)::text AS c FROM job_interests WHERE status = 'active' ${wc}`, params),
    query<{ c: string }>(
      `SELECT count(*)::text AS c FROM job_interests
        WHERE status = 'active' AND updated_at >= now() - interval '${staleDays} days' ${wc}`,
      params,
    ),
    query<{ code: string; c: string }>(
      `SELECT wt AS code, count(*)::text AS c
         FROM job_interests, unnest(work_types) AS wt
        WHERE status = 'active' ${wc}
        GROUP BY wt ORDER BY count(*) DESC, wt`,
      params,
    ),
    query<{ code: string; label: string }>(`SELECT code, label FROM work_types ORDER BY sort`),
    query<{ day: string; c: string }>(
      `SELECT day::text AS day, sum(active_count)::text AS c
         FROM job_demand_daily
        WHERE work_type = '*' AND day >= CURRENT_DATE - 30 ${wc}
        GROUP BY day ORDER BY day`,
      params,
    ),
  ]);

  const labels = new Map(labelsRes.rows.map((r) => [r.code, r.label]));
  return {
    scope: all ? 'all' : (filter as string[]),
    total: Number(totalRes.rows[0]?.c ?? 0),
    availableNow: Number(nowRes.rows[0]?.c ?? 0),
    byWorkType: byTypeRes.rows.map((r) => ({
      code: r.code, label: labels.get(r.code) ?? r.code, count: Number(r.c),
    })),
    trend: trendRes.rows.map((r) => ({ day: r.day, count: Number(r.c) })),
  };
}

/** FR-L4: anonymous public count for a ward (suppressed unless the flag is on). */
export async function publicCount(ward: string): Promise<{ wardCode: string; peopleLookingForWork: number }> {
  // Flag-gated (default off): suppress the anonymous public cell entirely.
  if (!(await isFlagEnabled('jobs.publicCount', false))) {
    return { wardCode: ward, peopleLookingForWork: 0 };
  }
  const res = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM job_interests WHERE ward_code = $1 AND status = 'active'`,
    [ward],
  );
  return { wardCode: ward, peopleLookingForWork: Number(res.rows[0]?.c ?? 0) };
}

// ── Opportunities (FR-M) ─────────────────────────────────────────────────

function opportunityView(r: any, includeStats: boolean): OpportunityView {
  const v: OpportunityView = {
    id: r.id, refNo: r.ref_no, wardCode: r.ward_code, regionCode: r.region_code,
    title: r.title, company: r.company, workTypes: r.work_types ?? [], description: r.description,
    contactEmail: r.contact_email, contactPhone: r.contact_phone, contactUrl: r.contact_url,
    projectId: r.project_id, status: r.status, publishedAt: r.published_at,
    closesAt: r.closes_at, createdAt: r.created_at,
  };
  if (includeStats) {
    v.stats = {
      matched: Number(r.matched ?? 0), notifiedInapp: Number(r.notified_inapp ?? 0),
      emailed: Number(r.emailed ?? 0), emailFailed: Number(r.email_failed ?? 0),
    };
  }
  return v;
}

const OPP_COLS = `o.id, o.ref_no, o.ward_code, o.region_code, o.title, o.company, o.work_types,
  o.description, o.contact_email, o.contact_phone, o.contact_url, o.project_id, o.status,
  o.published_at::text, o.closes_at::text, o.created_at::text`;

/** Flip published opportunities past their expiry to 'expired' (lazy sweep). */
async function sweepExpired(): Promise<void> {
  await query(
    `UPDATE job_opportunities SET status = 'expired', updated_at = now()
      WHERE status = 'published' AND expires_at IS NOT NULL AND expires_at < now()`,
  );
}

/** Assert a staff principal may act on this ward. */
async function assertWardInScope(p: Principal, ward: string): Promise<void> {
  if (p.wardCode && p.wardCode !== ward) throw httpError(403, 'You can only act in your own ward');
  const scope = await scopeWardsFor(p);
  if (scope !== null && !scope.includes(ward)) throw httpError(403, 'Ward outside your scope');
}

async function nextRef(ward: string): Promise<string> {
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM job_opportunities WHERE ward_code = $1`,
    [ward],
  );
  const seq = Number(res.rows[0]?.n ?? 0) + 1;
  return `UDF-JOB-${ward}-${String(seq).padStart(6, '0')}`;
}

/**
 * List opportunities. Members see only their own ward's PUBLISHED adverts
 * (no delivery stats); staff see their scope with stats.
 */
export async function listOpportunities(
  p: Principal,
  q: { ward?: string; status?: string; limit: number },
): Promise<{ items: OpportunityView[] }> {
  await sweepExpired();
  const isMember = p.role === Role.MEMBER;

  let filter: string[] | null;
  let status: string | undefined;
  if (isMember) {
    if (!p.wardCode) return { items: [] };
    filter = [p.wardCode];
    status = 'published';
  } else {
    const scope = await scopeWardsFor(p);
    if (q.ward) {
      if (scope !== null && !scope.includes(q.ward)) throw httpError(403, 'Ward outside your scope');
      filter = [q.ward];
    } else {
      filter = scope;
    }
    status = q.status;
  }

  const conds: string[] = [];
  const params: any[] = [];
  if (filter !== null) { params.push(filter); conds.push(`o.ward_code = ANY($${params.length})`); }
  if (status) { params.push(status); conds.push(`o.status = $${params.length}`); }
  params.push(Math.min(Math.max(q.limit, 1), 100));
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const res = await query<any>(
    `SELECT ${OPP_COLS}, s.matched, s.notified_inapp, s.emailed, s.email_failed
       FROM job_opportunities o
       LEFT JOIN job_opportunity_stats s ON s.opportunity_id = o.id
       ${where}
      ORDER BY o.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return { items: res.rows.map((r) => opportunityView(r, !isMember)) };
}

export async function getOpportunity(id: string, p: Principal): Promise<OpportunityView> {
  const isMember = p.role === Role.MEMBER;
  const res = await query<any>(
    `SELECT ${OPP_COLS}, s.matched, s.notified_inapp, s.emailed, s.email_failed
       FROM job_opportunities o
       LEFT JOIN job_opportunity_stats s ON s.opportunity_id = o.id
      WHERE o.id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw httpError(404, 'Opportunity not found');
  if (isMember) {
    if (row.status !== 'published' || row.ward_code !== p.wardCode) {
      throw httpError(403, 'Opportunity not available');
    }
  } else {
    await assertWardInScope(p, row.ward_code);
  }
  return opportunityView(row, !isMember);
}

export async function createOpportunity(
  input: CreateOpportunity,
  p: Principal,
  ctx: { ip: string | null; userAgent: string | null },
): Promise<OpportunityView> {
  const ward = input.wardCode ?? p.wardCode;
  if (!ward) throw httpError(400, 'A target ward is required');
  await assertWardInScope(p, ward);
  const codes = await activeWorkTypeCodes(input.workTypes);
  if (codes.length === 0) throw httpError(400, 'Select at least one valid type of work');
  const region = await regionOfWard(ward);
  const ref = await nextRef(ward);

  const res = await query<any>(
    `INSERT INTO job_opportunities
       (ref_no, ward_code, region_code, title, company, work_types, description,
        contact_email, contact_phone, contact_url, project_id, status, created_by, closes_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12,$13)
     RETURNING ${OPP_COLS.replace(/o\./g, '')}`,
    [ref, ward, region, input.title.trim(), input.company.trim(), codes, nn(input.description),
     nn(input.contactEmail), nn(input.contactPhone), nn(input.contactUrl),
     input.projectId ?? null, p.sub, input.closesAt ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Opportunity insert failed');
  await recordAudit({
    action: 'jobs.opportunity.create', actorId: p.sub, actorRole: p.role,
    targetType: 'job_opportunity', targetId: row.id, regionCode: ward,
    metadata: { ref, workTypes: codes }, ip: ctx.ip, userAgent: ctx.userAgent,
  });
  return opportunityView(row, true);
}

export async function patchOpportunity(
  id: string,
  input: PatchOpportunity,
  p: Principal,
  ctx: { ip: string | null; userAgent: string | null },
): Promise<OpportunityView> {
  const cur = await query<any>(`SELECT ward_code, status FROM job_opportunities WHERE id = $1`, [id]);
  const row = cur.rows[0];
  if (!row) throw httpError(404, 'Opportunity not found');
  await assertWardInScope(p, row.ward_code);

  const sets: string[] = [];
  const params: any[] = [];
  const push = (col: string, val: any) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (input.title !== undefined) push('title', input.title.trim());
  if (input.company !== undefined) push('company', input.company.trim());
  if (input.description !== undefined) push('description', nn(input.description));
  if (input.contactEmail !== undefined) push('contact_email', nn(input.contactEmail));
  if (input.contactPhone !== undefined) push('contact_phone', nn(input.contactPhone));
  if (input.contactUrl !== undefined) push('contact_url', nn(input.contactUrl));
  if (input.projectId !== undefined) push('project_id', input.projectId);
  if (input.closesAt !== undefined) push('closes_at', input.closesAt);
  if (input.workTypes !== undefined) {
    const codes = await activeWorkTypeCodes(input.workTypes);
    if (codes.length === 0) throw httpError(400, 'Select at least one valid type of work');
    push('work_types', codes);
  }
  if (sets.length > 0) {
    params.push(id);
    await query(`UPDATE job_opportunities SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
  }
  await recordAudit({
    action: 'jobs.opportunity.update', actorId: p.sub, actorRole: p.role,
    targetType: 'job_opportunity', targetId: id, regionCode: row.ward_code,
    metadata: { fields: Object.keys(input) }, ip: ctx.ip, userAgent: ctx.userAgent,
  });
  return getOpportunity(id, p);
}

/**
 * Publish + relay (FR-M2): match active interests in the ward by work-type
 * overlap, send an in-app notification and capture an email in the internal
 * outbox for each, then record COUNTS ONLY in job_opportunity_stats.
 */
export async function publishOpportunity(
  id: string,
  p: Principal,
  ctx: { ip: string | null; userAgent: string | null },
): Promise<{ opportunity: OpportunityView; duplicateWarning: boolean }> {
  const cur = await query<any>(
    `SELECT id, ref_no, ward_code, title, company, work_types, status, closes_at,
            contact_email, contact_phone, contact_url
       FROM job_opportunities WHERE id = $1`,
    [id],
  );
  const row = cur.rows[0];
  if (!row) throw httpError(404, 'Opportunity not found');
  await assertWardInScope(p, row.ward_code);
  if (row.status === 'closed' || row.status === 'expired') {
    throw httpError(409, 'A closed or expired opportunity cannot be published');
  }

  // FR-M6 duplicate guard: same ward + title + company published within the window.
  const guardDays = await getConfigInt('jobs.duplicateGuardDays', DUPLICATE_GUARD_DAYS_DEFAULT);
  const dup = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM job_opportunities
      WHERE ward_code = $1 AND lower(title) = lower($2) AND lower(company) = lower($3)
        AND id <> $4 AND status = 'published' AND published_at >= now() - interval '${guardDays} days'`,
    [row.ward_code, row.title, row.company, id],
  );
  const duplicateWarning = Number(dup.rows[0]?.c ?? 0) > 0;

  await query(
    `UPDATE job_opportunities
        SET status = 'published', published_at = now(), updated_at = now(),
            expires_at = COALESCE((closes_at::date + interval '1 day'), now() + interval '30 days')
      WHERE id = $1`,
    [id],
  );

  // Match active interests in the ward whose work types overlap the advert.
  const matches = await query<{ user_id: string; email: string; first_name: string }>(
    `SELECT user_id, email, first_name FROM job_interests
      WHERE ward_code = $1 AND status = 'active' AND work_types && $2::text[]`,
    [row.ward_code, row.work_types],
  );

  // §9.7 kill-switch: with jobs.relay off, the opportunity is published WITHOUT
  // notifying anyone (manual briefing mode). Matches are still counted so the
  // councillor knows how many members would have been relayed.
  const relayOn = await isFlagEnabled('jobs.relay', true);
  const contact = [row.contact_email, row.contact_phone, row.contact_url].filter(Boolean).join(' · ');

  let notifiedInapp = 0;
  let emailed = 0;
  let emailFailed = 0;
  if (relayOn) {
    const [subjectTpl, bodyTpl] = await Promise.all([
      getConfigStr('jobs.relayEmailSubject', RELAY_SUBJECT_DEFAULT),
      getConfigStr('jobs.relayEmailBody', RELAY_BODY_DEFAULT),
    ]);
    for (const m of matches.rows) {
      const vars = {
        firstName: m.first_name ?? '',
        title: row.title,
        company: row.company,
        ref: row.ref_no,
        contact,
      };
      await notify({
        userId: m.user_id,
        kind: 'job',
        title: renderTemplate(subjectTpl, vars),
        body: renderTemplate(bodyTpl, vars),
        link: 'tab:engage#jobs',
        regionCode: row.ward_code,
      });
      await query(
        `INSERT INTO job_relay_outbox (opportunity_id, user_id, channel, status) VALUES ($1,$2,'inapp','sent')`,
        [id, m.user_id],
      );
      notifiedInapp++;
      try {
        // Dev transport: no SMTP configured, so capture the send in the outbox.
        await query(
          `INSERT INTO job_relay_outbox (opportunity_id, user_id, channel, to_email, status)
           VALUES ($1,$2,'email',$3,'sent')`,
          [id, m.user_id, m.email],
        );
        emailed++;
      } catch {
        emailFailed++;
      }
    }
  }

  await query(
    `INSERT INTO job_opportunity_stats (opportunity_id, matched, notified_inapp, emailed, email_failed)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (opportunity_id) DO UPDATE SET
       matched = $2, notified_inapp = $3, emailed = $4, email_failed = $5, updated_at = now()`,
    [id, matches.rows.length, notifiedInapp, emailed, emailFailed],
  );

  await recordAudit({
    action: 'jobs.opportunity.publish', actorId: p.sub, actorRole: p.role,
    targetType: 'job_opportunity', targetId: id, regionCode: row.ward_code,
    metadata: { ref: row.ref_no, matched: matches.rows.length, notifiedInapp, emailed },
    ip: ctx.ip, userAgent: ctx.userAgent,
  });

  const opportunity = await getOpportunity(id, p);
  return { opportunity, duplicateWarning };
}

export async function closeOpportunity(
  id: string,
  p: Principal,
  ctx: { ip: string | null; userAgent: string | null },
): Promise<OpportunityView> {
  const cur = await query<any>(`SELECT ward_code FROM job_opportunities WHERE id = $1`, [id]);
  const row = cur.rows[0];
  if (!row) throw httpError(404, 'Opportunity not found');
  await assertWardInScope(p, row.ward_code);
  await query(`UPDATE job_opportunities SET status = 'closed', updated_at = now() WHERE id = $1`, [id]);
  await recordAudit({
    action: 'jobs.opportunity.close', actorId: p.sub, actorRole: p.role,
    targetType: 'job_opportunity', targetId: id, regionCode: row.ward_code,
    ip: ctx.ip, userAgent: ctx.userAgent,
  });
  return getOpportunity(id, p);
}

/** The active taxonomy (for form chips + CRM editor). */
export async function listWorkTypes(): Promise<Array<{ code: string; label: string }>> {
  const res = await query<{ code: string; label: string }>(
    `SELECT code, label FROM work_types WHERE active ORDER BY sort`,
  );
  return res.rows.map((r) => ({ code: r.code, label: r.label }));
}

// ── FR-N4: national-admin taxonomy + config ──────────────────────────────

export interface WorkTypeAdminView {
  code: string;
  label: string;
  active: boolean;
  sort: number;
}

export interface JobsAdminConfig {
  flags: { register: boolean; relay: boolean; publicCount: boolean };
  relayEmailSubject: string;
  relayEmailBody: string;
  demandStaleDays: number;
  duplicateGuardDays: number;
}

const FLAG_KEYS = {
  register: 'jobs.register',
  relay: 'jobs.relay',
  publicCount: 'jobs.publicCount',
} as const;

/** The full taxonomy including inactive codes (national-admin editor). */
export async function listAllWorkTypes(): Promise<WorkTypeAdminView[]> {
  const res = await query<{ code: string; label: string; active: boolean; sort: number }>(
    `SELECT code, label, active, sort FROM work_types ORDER BY sort, code`,
  );
  return res.rows.map((r) => ({ code: r.code, label: r.label, active: r.active, sort: Number(r.sort) }));
}

/** Create a new work type or update an existing one's label/active/sort. */
export async function upsertWorkType(
  code: string,
  input: WorkTypeUpsert,
  p: Principal,
  ctx: { ip: string | null; userAgent: string | null },
): Promise<WorkTypeAdminView> {
  const existing = await query<{ code: string }>(`SELECT code FROM work_types WHERE code = $1`, [code]);
  const isNew = (existing.rowCount ?? 0) === 0;
  if (isNew && !input.label) throw httpError(400, 'A label is required for a new work type');

  let res;
  if (isNew) {
    const sort = input.sort ?? Number(
      (await query<{ n: string }>(`SELECT COALESCE(max(sort), 0)::text AS n FROM work_types`)).rows[0]?.n ?? 0,
    ) + 1;
    res = await query<{ code: string; label: string; active: boolean; sort: number }>(
      `INSERT INTO work_types (code, label, active, sort) VALUES ($1,$2,$3,$4)
       RETURNING code, label, active, sort`,
      [code, input.label, input.active ?? true, sort],
    );
  } else {
    res = await query<{ code: string; label: string; active: boolean; sort: number }>(
      `UPDATE work_types
          SET label = COALESCE($2, label), active = COALESCE($3, active), sort = COALESCE($4, sort)
        WHERE code = $1
       RETURNING code, label, active, sort`,
      [code, input.label ?? null, input.active ?? null, input.sort ?? null],
    );
  }
  const row = res.rows[0]!;
  await recordAudit({
    action: 'jobs.worktype.upsert', actorId: p.sub, actorRole: p.role,
    targetType: 'work_type', targetId: code, regionCode: null,
    metadata: { isNew, fields: Object.keys(input) }, ip: ctx.ip, userAgent: ctx.userAgent,
  });
  return { code: row.code, label: row.label, active: row.active, sort: Number(row.sort) };
}

/** Current flags + relay template + windows for the CRM Settings surface. */
export async function getAdminConfig(): Promise<JobsAdminConfig> {
  const [flagRows, cfgRows] = await Promise.all([
    query<{ key: string; enabled: boolean }>(
      `SELECT key, enabled FROM feature_flags WHERE key = ANY($1)`,
      [Object.values(FLAG_KEYS)],
    ),
    query<{ key: string; value: string }>(`SELECT key, value FROM job_config`),
  ]);
  const f = new Map(flagRows.rows.map((r) => [r.key, r.enabled]));
  const c = new Map(cfgRows.rows.map((r) => [r.key, r.value]));
  return {
    flags: {
      register: f.get(FLAG_KEYS.register) ?? true,
      relay: f.get(FLAG_KEYS.relay) ?? true,
      publicCount: f.get(FLAG_KEYS.publicCount) ?? false,
    },
    relayEmailSubject: c.get('jobs.relayEmailSubject') ?? RELAY_SUBJECT_DEFAULT,
    relayEmailBody: c.get('jobs.relayEmailBody') ?? RELAY_BODY_DEFAULT,
    demandStaleDays: Number(c.get('jobs.demandStaleDays') ?? STALE_DAYS_DEFAULT),
    duplicateGuardDays: Number(c.get('jobs.duplicateGuardDays') ?? DUPLICATE_GUARD_DAYS_DEFAULT),
  };
}

/** Persist flag/template/window changes (partial). Audited. */
export async function updateAdminConfig(
  input: AdminConfig,
  p: Principal,
  ctx: { ip: string | null; userAgent: string | null },
): Promise<JobsAdminConfig> {
  const changedFlags: string[] = [];
  if (input.flags) {
    for (const name of Object.keys(FLAG_KEYS) as Array<keyof typeof FLAG_KEYS>) {
      const val = input.flags[name];
      if (typeof val === 'boolean') {
        await query(
          `INSERT INTO feature_flags (key, enabled) VALUES ($1,$2)
           ON CONFLICT (key) DO UPDATE SET enabled = $2, updated_at = now()`,
          [FLAG_KEYS[name], val],
        );
        changedFlags.push(FLAG_KEYS[name]);
      }
    }
  }

  const cfg: Array<[string, string]> = [];
  if (input.relayEmailSubject !== undefined) cfg.push(['jobs.relayEmailSubject', input.relayEmailSubject]);
  if (input.relayEmailBody !== undefined) cfg.push(['jobs.relayEmailBody', input.relayEmailBody]);
  if (input.demandStaleDays !== undefined) cfg.push(['jobs.demandStaleDays', String(input.demandStaleDays)]);
  if (input.duplicateGuardDays !== undefined) cfg.push(['jobs.duplicateGuardDays', String(input.duplicateGuardDays)]);
  for (const [key, value] of cfg) {
    await query(
      `INSERT INTO job_config (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, value],
    );
  }

  await recordAudit({
    action: 'jobs.config.update', actorId: p.sub, actorRole: p.role,
    targetType: 'job_config', targetId: null, regionCode: null,
    metadata: { flags: changedFlags, keys: cfg.map((c) => c[0]) }, ip: ctx.ip, userAgent: ctx.userAgent,
  });
  return getAdminConfig();
}

/** Public booleans the client uses to gate the jobs UI (§9.7). No config values. */
export async function getPublicFlags(): Promise<{ register: boolean; relay: boolean; publicCount: boolean }> {
  return (await getAdminConfig()).flags;
}
