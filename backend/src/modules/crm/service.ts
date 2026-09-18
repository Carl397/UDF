import { query } from '../../db/pool.js';
import { getDashboardActivity } from './activityStats.js';
import type { Principal } from '../../auth/permissions.js';
import { memberScope, privateTierClause, wardCodeScope } from '../../auth/scope.js';

/**
 * CRM service — aggregated queries for the desktop admin interface.
 *
 * SCOPE IS MANDATORY. Every method takes the caller's `Principal` and filters
 * through `auth/scope.ts`, so a `ward_councillor` sees only their ward and a
 * `regional_organizer` only the wards under their subcouncils. Only
 * `national_admin` / national-scope principals get unfiltered results.
 *
 * This was not the case originally: these were global queries reachable by
 * anyone holding `overview:read`, which leaked metro-wide member and case data
 * across scope boundaries — a POPIA breach, not merely a bug.
 *
 * Rows are mapped to camelCase DTOs to match the frontend `Member` /
 * `ServiceRequest` types and the rest of the API surface. The audit log is
 * intentionally left as raw snake_case rows (its viewer consumes that shape)
 * and is national_admin-only (`audit:read`) at the route layer, so it needs no
 * scope filter.
 */

/** Map a service_requests row (+ joined reporter membership no) to the API DTO. */
function srToView(r: any) {
  return {
    id: r.id,
    refNo: r.ref_no,
    category: r.category,
    severity: r.severity,
    title: r.title,
    description: r.description ?? null,
    status: r.status,
    wardCode: r.ward_code ?? null,
    reporterMemberId: r.reporter_member_id ?? null,
    councillorMemberId: r.councillor_member_id ?? null,
    slaDueAt: r.sla_due_at ?? null,
    reportCount: r.report_count ?? 0,
    resolvedAt: r.resolved_at ?? null,
    verifiedAt: r.verified_at ?? null,
    closedAt: r.closed_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    reporterMembershipNo: r.reporter_membership_no ?? null,
  };
}

/** Escalation = service request + computed reason. */
function escalationToView(r: any) {
  return { ...srToView(r), escalationReason: r.escalation_reason };
}

/** Map a members row to the public API DTO (no sealed PII here). */
function memberToView(r: any) {
  return {
    id: r.id,
    membershipNo: r.membership_no ?? null,
    publicCode: r.public_code ?? null,
    tier: r.tier,
    status: r.status,
    ward: r.ward ?? null,
    createdAt: r.created_at,
  };
}

export async function getEngagements(
  principal: Principal,
  filters: {
    ward?: string;
    status?: string;
    category?: string;
    search?: string;
    limit?: number;
    offset?: number;
  },
) {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters.ward) {
    conditions.push(`sr.ward_code = $${idx}`);
    params.push(filters.ward);
    idx++;
  }
  if (filters.status) {
    conditions.push(`sr.status = $${idx}`);
    params.push(filters.status);
    idx++;
  }
  if (filters.category) {
    conditions.push(`sr.category = $${idx}`);
    params.push(filters.category);
    idx++;
  }
  if (filters.search) {
    /**
     * Free-text search over the case's own PLAINTEXT columns.
     *
     * Deliberately not extended to who reported it. The reporter's identity is
     * in `sr.reporter_sealed` and their name in `members.sealed_pii`, both
     * encrypted at rest with only blind indexes (`email_bidx`, `phone_bidx`)
     * for exact-match lookup — so a `LIKE` over them would mean decrypting the
     * whole table to answer a search, which is precisely what the sealing
     * exists to prevent. Searching a case by ref, title, ward or category needs
     * no personal data, and `category` is an enum so it takes a cast.
     *
     * Added because the CRM top bar promised "search members, cases…" and only
     * the member half was ever implemented (D9): a filter the server drops
     * silently is worse than no filter, because the result set looks complete.
     */
    conditions.push(
      `(sr.ref_no ILIKE $${idx} OR sr.title ILIKE $${idx} OR sr.ward_code ILIKE $${idx} OR sr.category::text ILIKE $${idx})`,
    );
    params.push(`%${filters.search}%`);
    idx++;
  }

  // Scope last so it can never be displaced by a caller-supplied `ward` filter:
  // a councillor asking for another ward gets the AND of both, i.e. nothing.
  const scope = await wardCodeScope(principal, 'sr.ward_code', idx);
  conditions.push(scope.sql.replace(/^\s*AND\s*/, ''));
  params.push(...scope.params);
  idx = scope.nextIndex;

  // VISIBILITY TIER — orthogonal to territory (FR-E). `visibility = 'private'`
  // cases were logged by a resident in confidence and are readable by STAFF roles
  // only. `analyst` holds `overview:read` but is NOT a staff role, and being
  // national-scope it passes `wardCodeScope` unfiltered — so without this clause
  // it received every private case in the country, titles and descriptions
  // included (D45). Empty string for staff, which `filter(Boolean)` drops.
  conditions.push(privateTierClause(principal, 'sr.visibility').replace(/^\s*AND\s*/, ''));

  const where = conditions.filter(Boolean).length
    ? `WHERE ${conditions.filter(Boolean).join(' AND ')}`
    : '';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const [countRes, dataRes] = await Promise.all([
    query(`SELECT COUNT(*) as total FROM service_requests sr ${where}`, params),
    query(
      `SELECT sr.*, m.membership_no as reporter_membership_no
       FROM service_requests sr
       LEFT JOIN members m ON sr.reporter_member_id = m.id
       ${where}
       ORDER BY sr.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    ),
  ]);

  return {
    items: dataRes.rows.map(srToView),
    total: parseInt(countRes.rows[0].total, 10),
    limit,
    offset,
  };
}

export async function getEscalations(principal: Principal) {
  // Cases that are overdue (past SLA) or stuck in submitted/in_progress for >30 days
  const scope = await wardCodeScope(principal, 'sr.ward_code', 1);
  const res = await query(
    `
    SELECT sr.*, m.membership_no as reporter_membership_no,
           CASE
             WHEN sr.sla_due_at < NOW() THEN 'sla_breach'
             WHEN sr.status IN ('submitted', 'in_progress') AND sr.created_at < NOW() - INTERVAL '30 days' THEN 'stuck'
             ELSE 'overdue'
           END as escalation_reason
    FROM service_requests sr
    LEFT JOIN members m ON sr.reporter_member_id = m.id
    WHERE sr.status IN ('submitted', 'in_progress', 'logged')
      AND (sr.sla_due_at < NOW() OR sr.created_at < NOW() - INTERVAL '30 days')${scope.sql}${privateTierClause(principal, 'sr.visibility')}
    ORDER BY COALESCE(sr.sla_due_at, sr.created_at) ASC
  `,
    scope.params,
  );

  return { items: res.rows.map(escalationToView), total: res.rows.length };
}

export async function getMembers(
  principal: Principal,
  filters: {
    ward?: string;
    tier?: string;
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  },
) {
  const conditions: string[] = ['m.deleted_at IS NULL'];
  const params: any[] = [];
  let idx = 1;

  if (filters.ward) {
    conditions.push(`m.ward = $${idx}`);
    params.push(filters.ward);
    idx++;
  }
  if (filters.tier) {
    conditions.push(`m.tier = $${idx}`);
    params.push(filters.tier);
    idx++;
  }
  if (filters.status) {
    conditions.push(`m.status = $${idx}`);
    params.push(filters.status);
    idx++;
  }
  if (filters.search) {
    conditions.push(`(m.membership_no ILIKE $${idx} OR m.public_code ILIKE $${idx})`);
    params.push(`%${filters.search}%`);
    idx++;
  }

  const scope = await memberScope(principal, 'm', idx);
  conditions.push(scope.sql.replace(/^\s*AND\s*/, ''));
  params.push(...scope.params);
  idx = scope.nextIndex;

  const where = `WHERE ${conditions.filter(Boolean).join(' AND ')}`;
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const [countRes, dataRes] = await Promise.all([
    query(`SELECT COUNT(*) as total FROM members m ${where}`, params),
    query(
      `SELECT m.id, m.membership_no, m.public_code, m.tier, m.status, m.ward, m.created_at
       FROM members m
       ${where}
       ORDER BY m.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    ),
  ]);

  return {
    items: dataRes.rows.map(memberToView),
    total: parseInt(countRes.rows[0].total, 10),
    limit,
    offset,
  };
}

export async function getAuditLog(filters: {
  action?: string;
  actorRole?: string;
  limit?: number;
  offset?: number;
}) {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters.action) {
    conditions.push(`action = $${idx}`);
    params.push(filters.action);
    idx++;
  }
  if (filters.actorRole) {
    conditions.push(`actor_role = $${idx}`);
    params.push(filters.actorRole);
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const [countRes, dataRes] = await Promise.all([
    query(`SELECT COUNT(*) as total FROM audit_log ${where}`, params),
    query(
      `SELECT * FROM audit_log
       ${where}
       ORDER BY seq DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    ),
  ]);

  return {
    items: dataRes.rows,
    total: parseInt(countRes.rows[0].total, 10),
    limit,
    offset,
  };
}

export async function getDashboardStats(principal: Principal) {
  const m = await memberScope(principal, 'members', 1);
  const c = await wardCodeScope(principal, 'service_requests.ward_code', 1);
  const pet = await wardCodeScope(principal, 'petitions.ward_code', 1);
  const part = await wardCodeScope(principal, 'public_participations.ward_code', 1);

  const [membersRes, casesRes, petitionsRes, participationsRes] = await Promise.all([
    query(
      `SELECT COUNT(*) as total FROM members
        WHERE status = 'active' AND deleted_at IS NULL${m.sql}`,
      m.params,
    ),
    query(
      // Private cases are excluded from the count for non-staff callers (D45),
      // so an analyst's `openCases` is the aggregate it is meant to be rather
      // than a tally that includes confidential reports they may not read.
      `SELECT COUNT(*) as total FROM service_requests
        WHERE status NOT IN ('resolved', 'closed', 'verified', 'duplicate') AND merged_into IS NULL${c.sql}${privateTierClause(principal, 'visibility')}`,
      c.params,
    ),
    query(`SELECT COUNT(*) as total FROM petitions WHERE status = 'open'${pet.sql}`, pet.params),
    query(
      `SELECT COUNT(*) as total FROM public_participations WHERE status = 'open'${part.sql}`,
      part.params,
    ),
  ]);

  return {
    activity: await getDashboardActivity(principal),
    activeMembers: parseInt(membersRes.rows[0].total, 10),
    openCases: parseInt(casesRes.rows[0].total, 10),
    openPetitions: parseInt(petitionsRes.rows[0].total, 10),
    openParticipations: parseInt(participationsRes.rows[0].total, 10),
  };
}
