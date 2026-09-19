import { query } from '../../db/pool.js';
import type { Principal } from '../../auth/permissions.js';
import { wardCodeScope } from '../../auth/scope.js';
import { liveReportStaff, staffNames } from './reportAccess.js';
import { reportListQuerySchema, type ReportListQuery } from './schemas.js';

// Every derived value is computed from authorized reports before user filters.
export async function reportQuery(principal: Principal, options: Partial<ReportListQuery>, id?: string) {
  const p = await liveReportStaff(principal);
  const f = reportListQuerySchema.parse({ ...options, scope: 'inbox' });
  const scope = await wardCodeScope(p, 'r.ward_code', 1);
  const params: unknown[] = [...scope.params];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const idClause = id ? ` AND r.id=${bind(id)}::uuid` : '';
  const cte = `WITH scoped AS (SELECT r.* FROM resident_reports r WHERE TRUE${scope.sql}${idClause}),
  enriched AS (SELECT r.*, w.name AS ward_name,
    CASE WHEN r.councillor_user_id IS NULL THEN 'unassigned'
      WHEN u.id IS NULL THEN 'missing' WHEN NOT u.is_active OR u.moderation_status IN ('banned','suspended') THEN 'inactive'
      WHEN u.role <> 'ward_councillor' OR u.ward_code IS DISTINCT FROM r.ward_code THEN 'moved' ELSE 'active' END AS assignment_state,
    ack.actor_id AS acknowledged_by, ack.created_at AS acknowledgment_event_at,
    CASE WHEN r.acknowledged_at IS NOT NULL OR ack.id IS NOT NULL THEN 'yes'
      WHEN r.status='submitted' THEN 'no' ELSE 'unknown' END AS acknowledgment,
    EXISTS(SELECT 1 FROM resident_report_events e WHERE e.report_id=r.id AND e.action='acknowledge' AND e.actor_id=r.councillor_user_id) AS councillor_acknowledged,
    actions.last_action_at, actions.councillor_action_at,
    COALESCE(tasks.open_tasks,0)::int AS open_tasks,
    LEAST(CASE WHEN r.status NOT IN ('resolved','closed') THEN r.follow_up_at END, tasks.task_due) AS next_due_at,
    (r.reference_kind='c3' AND r.sealed_reference IS NOT NULL) AS has_c3
    FROM scoped r LEFT JOIN regions w ON w.code=r.ward_code LEFT JOIN users u ON u.id=r.councillor_user_id
    LEFT JOIN LATERAL (SELECT id,actor_id,created_at FROM resident_report_events e WHERE e.report_id=r.id AND e.action='acknowledge' ORDER BY created_at,id LIMIT 1) ack ON TRUE
    LEFT JOIN LATERAL (SELECT max(a.created_at) AS last_action_at,
      max(a.created_at) FILTER (WHERE a.actor_id=r.councillor_user_id) AS councillor_action_at FROM (
      SELECT e.created_at,e.actor_id FROM resident_report_events e WHERE e.report_id=r.id AND e.action IN ('contact','follow_up','resolve')
      UNION ALL SELECT e.created_at,e.actor_id FROM resident_report_task_events e JOIN resident_report_tasks t ON t.id=e.task_id
        WHERE t.report_id=r.id AND e.action='done' AND e.outcome IS NOT NULL) a) actions ON TRUE
    LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE status IN ('todo','in_progress')) AS open_tasks,
      min(due_at) FILTER (WHERE status IN ('todo','in_progress')) AS task_due FROM resident_report_tasks t WHERE t.report_id=r.id) tasks ON TRUE),
    filtered AS (SELECT r.* FROM enriched r WHERE TRUE`;
  let where = '';
  if (f.search) { const b = bind(`%${f.search.replace(/[\\%_]/g, '\\$&')}%`); where += ` AND (r.ref_no ILIKE ${b} OR r.message ILIKE ${b})`; }
  if (f.category) where += ` AND r.category=${bind(f.category)}`;
  if (f.status) where += ` AND r.status=${bind(f.status)}`;
  if (f.ward) where += f.ward === 'unassigned' ? ' AND r.ward_code IS NULL' : ` AND r.ward_code=${bind(f.ward)}`;
  if (f.councillor) where += f.councillor === 'unassigned' ? " AND r.assignment_state <> 'active'" : ` AND r.councillor_user_id=${bind(f.councillor)}::uuid`;
  if (f.acknowledged) where += ` AND r.acknowledgment=${bind(f.acknowledged)}`;
  if (f.actionTaken) where += f.actionTaken === 'councillor' ? ' AND r.councillor_action_at IS NOT NULL' : ` AND r.last_action_at IS ${f.actionTaken === 'yes' ? 'NOT ' : ''}NULL`;
  if (f.c3) where += f.c3 === 'missing' ? " AND r.c3_requirement='required' AND NOT r.has_c3" :
    f.c3 === 'recorded' ? ' AND r.has_c3' : ` AND r.c3_requirement=${bind(f.c3)}`;
  if (f.assignee) where += ` AND EXISTS(SELECT 1 FROM resident_report_tasks t WHERE t.report_id=r.id AND t.status IN ('todo','in_progress') AND ${
    f.assignee === 'unassigned' ? 't.assignee_id IS NULL' : `t.assignee_id=${bind(f.assignee === 'me' ? p.sub : f.assignee)}::uuid`})`;
  if (f.overdue) where += f.overdue === 'yes' ? ' AND r.next_due_at < now()' : ' AND (r.next_due_at IS NULL OR r.next_due_at >= now())';
  if (f.from) where += ` AND r.created_at >= ${bind(f.from)}::timestamptz`;
  if (f.to) where += ` AND r.created_at <= ${bind(f.to)}::timestamptz`;
  return { sql: cte + where + ')', params, f, principal: p };
}

const metrics = `count(*)::int AS total,
  count(*) FILTER(WHERE status NOT IN ('resolved','closed'))::int AS open,
  count(*) FILTER(WHERE acknowledgment='no')::int AS unacknowledged,
  count(*) FILTER(WHERE acknowledgment='unknown')::int AS "unknownAcknowledgment",
  count(*) FILTER(WHERE last_action_at IS NULL)::int AS "noAction",
  count(*) FILTER(WHERE c3_requirement='required' AND NOT has_c3)::int AS "missingC3",
  count(*) FILTER(WHERE next_due_at < now())::int AS overdue`;

export function reportMetadata(r: Record<string, any>, names: Record<string, string>) {
  return { wardName: r.ward_name, councillorId: r.councillor_user_id,
    councillorName: names[r.councillor_user_id] ?? null, assignmentState: r.assignment_state,
    assigned: r.assignment_state === 'active', acknowledgment: r.acknowledgment,
    acknowledgedAt: r.acknowledged_at ?? r.acknowledgment_event_at,
    acknowledgedBy: r.acknowledged_by, acknowledgedByName: names[r.acknowledged_by] ?? null,
    councillorAcknowledged: r.councillor_acknowledged,
    lastActionAt: r.last_action_at, councillorActionAt: r.councillor_action_at,
    openTasks: r.open_tasks, nextDueAt: r.next_due_at, c3Requirement: r.c3_requirement,
    c3Reason: r.c3_reason, referenceKind: r.reference_kind, hasC3: r.has_c3 };
}

export async function getReportManagementMetadata(id: string, principal: Principal) {
  const q = await reportQuery(principal, {}, id);
  const r = (await query(`${q.sql} SELECT * FROM filtered`, q.params)).rows[0];
  if (!r) return {};
  const names = await staffNames([r.councillor_user_id, r.acknowledged_by], q.principal);
  return reportMetadata(r, names);
}

export async function listManagedReports(principal: Principal, options: Partial<ReportListQuery> = {}) {
  const q = await reportQuery(principal, options);
  const { f, params } = q;
  const sort = { received: 'r.created_at', lastAction: 'r.last_action_at', nextDue: 'r.next_due_at' }[f.sort];
  const direction = f.direction === 'asc' ? 'ASC' : 'DESC';
  const { rows: [result] } = await query(`${q.sql}, page AS (SELECT r.*,
    COALESCE((SELECT json_agg(json_build_object('mediaId',m.media_asset_id,'contentType',ma.content_type,'captureMode',ma.capture_mode) ORDER BY ma.created_at)
      FROM resident_report_media m JOIN media_assets ma ON ma.id=m.media_asset_id WHERE m.report_id=r.id), '[]'::json) AS media,
    ST_Y(r.location::geometry) AS lat, ST_X(r.location::geometry) AS lng
    FROM filtered r ORDER BY ${sort} ${direction} NULLS LAST, r.id ${direction} LIMIT $${params.length + 1} OFFSET $${params.length + 2})
    SELECT (SELECT row_to_json(s) FROM (SELECT ${metrics} FROM filtered) s) AS stats,
      COALESCE((SELECT json_agg(p) FROM page p),'[]'::json) AS items`, [...params, f.limit, f.offset]);
  const names = await staffNames(result.items.flatMap((r: any) => [r.councillor_user_id, r.acknowledged_by]), q.principal);
  return { total: result.stats.total as number, stats: result.stats, items: result.items.map((r: any) => ({
    id: r.id, refNo: r.ref_no, category: r.category, message: r.message, wardCode: r.ward_code, status: r.status,
    feedback: r.feedback, respondedAt: r.responded_at, lat: r.lat, lng: r.lng, accuracyM: r.accuracy_m,
    media: r.media, createdAt: r.created_at, ...reportMetadata(r, names),
  })) };
}

export async function reportAccountability(principal: Principal, options: Partial<ReportListQuery>) {
  const q = await reportQuery(principal, options);
  const { rows: [result] } = await query(`${q.sql}, groups AS (SELECT ward_code AS "wardCode", ward_name AS "wardName",
    councillor_user_id AS "councillorId", assignment_state AS "assignmentState", ${metrics},
    count(*) FILTER(WHERE councillor_acknowledged)::int AS "councillorAcknowledged",
    count(*) FILTER(WHERE councillor_action_at IS NOT NULL)::int AS "councillorActions"
    FROM filtered GROUP BY ward_code,ward_name,councillor_user_id,assignment_state),
    page AS (SELECT * FROM groups ORDER BY "wardCode" NULLS LAST,"councillorId" NULLS LAST LIMIT $${q.params.length + 1} OFFSET $${q.params.length + 2})
    SELECT (SELECT count(*)::int FROM groups) AS total, COALESCE((SELECT json_agg(p) FROM page p),'[]'::json) AS items`,
    [...q.params, q.f.limit, q.f.offset]);
  const names = await staffNames(result.items.map((r: any) => r.councillorId), q.principal);
  return { total: result.total, items: result.items.map((r: any) => ({ ...r, councillorName: names[r.councillorId] ?? null })) };
}

export async function reportFilterOptions(principal: Principal) {
  const p = await liveReportStaff(principal);
  const scope = await wardCodeScope(p, 'r.ward_code', 1);
  const rows = (await query(`SELECT DISTINCT r.ward_code,w.name,r.category,r.councillor_user_id FROM resident_reports r
    LEFT JOIN regions w ON w.code=r.ward_code WHERE TRUE${scope.sql}`, scope.params)).rows;
  const names = await staffNames(rows.map((r) => r.councillor_user_id), p);
  const assigneeRows = (await query(`SELECT DISTINCT t.assignee_id FROM resident_report_tasks t JOIN resident_reports r ON r.id=t.report_id
    WHERE t.assignee_id IS NOT NULL AND TRUE${scope.sql}`, scope.params)).rows;
  const assigneeNames = await staffNames(assigneeRows.map((r) => r.assignee_id), p);
  return {
    taskAssignees: Object.entries(assigneeNames).map(([id, name]) => ({ id, name })),
    categories: [...new Set(rows.map((r) => r.category as string))].sort(),
    wards: [...new Map(rows.filter((r) => r.ward_code).map((r) => [r.ward_code, { code: r.ward_code, name: r.name ?? r.ward_code }])).values()],
    councillors: Object.entries(names).map(([id, name]) => ({ id, name })),
  };
}
