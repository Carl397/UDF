import { query } from '../../db/pool.js';
import { wardCodeScope, privateTierClause } from '../../auth/scope.js';
import { Permission, type Principal } from '../../auth/permissions.js';

/** Scoped database aggregates: never computed from a paginated list. */
export async function getDashboardActivity(principal: Principal, only?: 'reports' | 'cases' | 'patrols') {
  const configs = [
    { key: 'reports', table: 'resident_reports', permission: Permission.REPORT_READ, tier: false, category: 'category' },
    { key: 'cases', table: 'service_requests', permission: Permission.CASE_READ, tier: true, category: 'category::text' },
    { key: 'patrols', table: 'patrols', permission: Permission.PATROL_READ, tier: true, category: 'mode::text' },
  ] as const;
  const modules: Record<string, unknown> = {};
  for (const config of configs) {
    if (only && config.key !== only) continue;
    if (!principal.permissions?.includes(config.permission)) { modules[config.key] = null; continue; }
    const scope = await wardCodeScope(principal, 'x.ward_code', 1);
    const tier = config.tier ? privateTierClause(principal, 'x.visibility') : '';
    const extra = config.key === 'reports'
      ? `,'overdue', (SELECT count(*) FROM scoped WHERE follow_up_at < now() AND status NOT IN ('resolved','closed')),
         'unassigned', (SELECT count(*) FROM scoped s WHERE status <> 'closed' AND NOT EXISTS (
                    SELECT 1 FROM users u WHERE u.id = s.councillor_user_id AND u.is_active
                      AND u.role = 'ward_councillor' AND u.ward_code = s.ward_code)),
         'medianAcknowledgeHours', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM acknowledged_at-created_at)/3600) FROM scoped WHERE acknowledged_at IS NOT NULL),
         'acknowledgedSample', (SELECT count(*) FROM scoped WHERE acknowledged_at IS NOT NULL)`
      : config.key === 'patrols'
        ? `,'distanceM30d', (SELECT sum(distance_m)::float8 FROM scoped WHERE status='completed' AND ended_at >= now()-interval '30 days'),
           'completed30d', (SELECT count(*) FROM scoped WHERE status='completed' AND ended_at >= now()-interval '30 days'),
           'unknownDistance30d', (SELECT count(*) FROM scoped WHERE status='completed' AND ended_at >= now()-interval '30 days' AND distance_m IS NULL),
           'outstandingStops', (SELECT count(*) FROM patrol_stops ps JOIN scoped p ON ps.patrol_id=p.id WHERE ps.call_status <> 'completed')`
        : '';
    const { rows: [row] } = await query(`WITH scoped AS (
        SELECT x.* FROM ${config.table} x WHERE TRUE${scope.sql}${tier}
      ), statuses AS (SELECT status::text AS label, count(*)::int AS value FROM scoped GROUP BY status),
      categories AS (SELECT ${config.category} AS label, count(*)::int AS value FROM scoped GROUP BY ${config.category}),
      wards AS (SELECT COALESCE(ward_code,'Unassigned') AS label, count(*)::int AS value FROM scoped GROUP BY ward_code),
      days AS (SELECT generate_series((now() AT TIME ZONE 'Africa/Johannesburg')::date - 29,
          (now() AT TIME ZONE 'Africa/Johannesburg')::date, interval '1 day')::date AS day),
      daily AS (SELECT to_char(day,'YYYY-MM-DD') AS label, count(s.id)::int AS value
        FROM days LEFT JOIN scoped s ON (s.created_at AT TIME ZONE 'Africa/Johannesburg')::date = day GROUP BY day ORDER BY day),
      recent AS (SELECT id, status::text AS status, ward_code AS "wardCode", updated_at AS "updatedAt"
        FROM scoped ORDER BY updated_at DESC, id LIMIT 10)
      SELECT json_build_object('total',(SELECT count(*) FROM scoped),
        'byStatus',COALESCE((SELECT json_agg(statuses ORDER BY label) FROM statuses),'[]'::json),
        'byCategory',COALESCE((SELECT json_agg(categories ORDER BY value DESC) FROM categories),'[]'::json),
        'byWard',COALESCE((SELECT json_agg(wards ORDER BY value DESC) FROM wards),'[]'::json),
        'dailyCreated',(SELECT json_agg(daily ORDER BY label) FROM daily),
        'recent',COALESCE((SELECT json_agg(recent) FROM recent),'[]'::json)${extra}) AS stats`, scope.params);
    modules[config.key] = row.stats;
  }
  return { asOf: new Date().toISOString(), periodDays: 30, timezone: 'Africa/Johannesburg', modules };
}
