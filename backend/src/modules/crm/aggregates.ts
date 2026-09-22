import { z } from 'zod';
import { withReadSnapshot } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import { Permission, type Principal } from '../../auth/permissions.js';
import { wardCodeScope, privateTierClause } from '../../auth/scope.js';

export interface CaseMetrics {
  total: number;
  open: number;
  resolved: number;
  slaBreached: number;
  resolutionRatePct: number | null;
}

export interface CasePerformance {
  asOf: string;
  totals: CaseMetrics;
  byStatus: { label: string; value: number }[];
  byCategory: { label: string; value: number }[];
  byWard: ({ wardCode: string | null } & CaseMetrics)[];
}

// Preserve microseconds so the returned clock is exactly the SLA comparison clock.
export const DATABASE_AS_OF_SQL = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const ELIGIBLE_CASE_SQL = `merged_into IS NULL AND status <> 'duplicate'`;
const RESOLVED = `('resolved','verified','closed')`;
const EMPTY_METRICS_SQL = `'${JSON.stringify({ total: 0, open: 0, resolved: 0, slaBreached: 0, resolutionRatePct: null })}'::json`;

/** Aggregate only an already authorized, duplicate/merge-free service-request set. */
export function caseMetricColumns(alias: string): string {
  return `count(${alias}.id)::int AS total,
    count(${alias}.id) FILTER (WHERE ${alias}.status NOT IN ${RESOLVED})::int AS open,
    count(${alias}.id) FILTER (WHERE ${alias}.status IN ${RESOLVED})::int AS resolved,
    count(${alias}.id) FILTER (WHERE ${alias}.status NOT IN ${RESOLVED} AND ${alias}.sla_due_at < now())::int AS "slaBreached",
    round(100.0 * count(${alias}.id) FILTER (WHERE ${alias}.status IN ${RESOLVED}) / NULLIF(count(${alias}.id), 0), 2)::float8 AS "resolutionRatePct"`;
}

/** Appended to the existing dashboard's scoped CTE; legacy totals stay unchanged. */
export const CASE_PERFORMANCE_CTES = `,
  performance_cases AS (SELECT * FROM scoped WHERE ${ELIGIBLE_CASE_SQL}),
  performance_totals AS (SELECT ${caseMetricColumns('c')} FROM performance_cases c),
  performance_statuses AS (SELECT status::text AS label, count(*)::int AS value FROM performance_cases GROUP BY status),
  performance_categories AS (SELECT category::text AS label, count(*)::int AS value FROM performance_cases GROUP BY category),
  performance_wards AS (SELECT c.ward_code AS "wardCode", ${caseMetricColumns('c')}
    FROM performance_cases c GROUP BY c.ward_code)`;

export const CASE_PERFORMANCE_JSON = `json_build_object(
  'asOf', ${DATABASE_AS_OF_SQL}, 'totals', (SELECT row_to_json(t) FROM performance_totals t),
  'byStatus', COALESCE((SELECT json_agg(s ORDER BY label) FROM performance_statuses s), '[]'::json),
  'byCategory', COALESCE((SELECT json_agg(c ORDER BY value DESC, label) FROM performance_categories c), '[]'::json),
  'byWard', COALESCE((SELECT json_agg(w ORDER BY "wardCode" NULLS LAST) FROM performance_wards w), '[]'::json))`;

export const wardSummaryQuery = z.object({ ward: z.string().trim().min(1).max(32).optional() });
export interface WardSummary {
  asOf: string;
  wardFilter: string | null;
  total: number;
  rows: {
    code: string;
    name: string;
    members: number;
    cases: CaseMetrics | null;
    candidateRecorded: boolean;
    councillor: { fullName: string } | null;
  }[];
}

export async function getWardSummary(principal: Principal, input: z.infer<typeof wardSummaryQuery> = {}): Promise<WardSummary> {
  if (!principal?.permissions?.includes(Permission.OVERVIEW_READ) ||
      !principal.permissions.includes(Permission.MEMBER_READ)) throw ApiError.forbidden();
  const { ward } = wardSummaryQuery.parse(input);
  const scope = await wardCodeScope(principal, 'w.code', 1);
  const caseRead = principal.permissions.includes(Permission.CASE_READ);
  return withReadSnapshot(async (run) => {
    // Check canonical existence before authorization so invalid and forbidden stay distinct.
    if (ward) {
      const { rows } = await run<{ allowed: boolean }>(
        `SELECT (TRUE${scope.sql}) AS allowed FROM regions w WHERE w.level = 'ward' AND w.code = $${scope.nextIndex}`,
        [...scope.params, ward]);
      if (!rows.length) throw ApiError.badRequest('Invalid ward');
      if (!rows[0]!.allowed) throw ApiError.forbidden('Ward outside your scope');
    }
    const params = [...scope.params];
    const wardFilterSql = ward ? ` AND w.code = $${scope.nextIndex}` : '';
    if (ward) params.push(ward);
    const casesCte = caseRead ? `,
      eligible_cases AS (SELECT s.* FROM service_requests s JOIN wards w ON w.code = s.ward_code
        WHERE ${ELIGIBLE_CASE_SQL}${privateTierClause(principal, 's.visibility')}),
      case_counts AS (SELECT c.ward_code, ${caseMetricColumns('c')} FROM eligible_cases c GROUP BY c.ward_code)` : '';
    const { rows: [result] } = await run<{ data: Omit<WardSummary, 'wardFilter'> }>(
      `WITH wards AS (SELECT w.code, w.name FROM regions w WHERE w.level = 'ward'${scope.sql}${wardFilterSql}),
       member_counts AS (SELECT m.ward, count(*)::int AS members FROM members m JOIN wards w ON w.code = m.ward
         WHERE m.deleted_at IS NULL GROUP BY m.ward),
       recorded AS (
         SELECT DISTINCT w.code FROM users u
         JOIN LATERAL unnest(array_append(COALESCE(u.ward_codes, '{}'::text[]), u.ward_code)) a(code) ON TRUE
         JOIN wards w ON w.code = a.code WHERE u.role = 'ward_councillor'
       )${casesCte},
       rows AS (
         SELECT w.code, w.name, COALESCE(m.members, 0) AS members,
           ${caseRead ? `CASE WHEN c.ward_code IS NULL THEN ${EMPTY_METRICS_SQL} ELSE (SELECT row_to_json(metrics) FROM (SELECT c.total, c.open, c.resolved, c."slaBreached", c."resolutionRatePct") metrics) END` : 'NULL::json'} AS cases,
           (r.code IS NOT NULL) AS "candidateRecorded",
           CASE WHEN l.full_name IS NOT NULL THEN json_build_object('fullName', l.full_name) END AS councillor
         FROM wards w LEFT JOIN member_counts m ON m.ward = w.code
         LEFT JOIN recorded r ON r.code = w.code
         ${caseRead ? 'LEFT JOIN case_counts c ON c.ward_code = w.code' : ''}
         LEFT JOIN LATERAL (
           SELECT l.full_name FROM leaders l LEFT JOIN users u ON u.id = l.user_id
           WHERE (l.ward_code = w.code OR w.code = ANY(l.ward_codes)) AND l.is_public
             AND (l.user_id IS NULL OR (u.is_active AND u.role = 'ward_councillor' AND u.ward_code = l.ward_code))
           ORDER BY (l.user_id IS NOT NULL) DESC,
             EXISTS (SELECT 1 FROM ward_profiles wp WHERE wp.ward_code = w.code AND wp.councillor_member_id = l.member_id) DESC,
             l.updated_at DESC, l.id LIMIT 1
         ) l ON TRUE
       ) SELECT json_build_object('asOf', ${DATABASE_AS_OF_SQL}, 'total', (SELECT count(*)::int FROM wards),
         'rows', COALESCE((SELECT json_agg(rows ORDER BY code) FROM rows), '[]'::json)) AS data`, params);
    return { ...result!.data, wardFilter: ward ?? null };
  });
}
