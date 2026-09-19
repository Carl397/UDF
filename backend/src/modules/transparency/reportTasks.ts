import { query, withTransaction } from '../../db/pool.js';
import { wardCodeScope } from '../../auth/scope.js';
import { Permission, type Principal } from '../../auth/permissions.js';
import { ApiError } from '../../http/errors.js';
import { notify } from '../notifications/service.js';
import { recordAudit } from '../../security/audit.js';
import { logger } from '../../config/logger.js';
import { authorizeReportStaff, eligibleStaff, liveReportStaff, staffNames } from './reportAccess.js';
import { taskListQuerySchema, type CreateReportTask, type UpdateReportTask, type TaskListQuery } from './schemas.js';

export async function reportAssignees(reportId: string, principal: Principal) {
  const { report, principal: p } = await authorizeReportStaff(reportId, principal, true);
  const people = await eligibleStaff(report.ward_code);
  const names = await staffNames(people.map((u) => u.sub), p);
  return { items: people.map((u) => ({ id: u.sub, name: names[u.sub], role: u.role, isMe: u.sub === p.sub })) };
}

export async function listReportTasks(principal: Principal, options: Partial<TaskListQuery> = {}) {
  const p = await liveReportStaff(principal);
  const f = taskListQuerySchema.parse(options);
  if (f.reportId) await authorizeReportStaff(f.reportId, p);
  const scope = await wardCodeScope(p, 'r.ward_code', 1);
  const params: unknown[] = [...scope.params];
  let where = `WHERE TRUE${scope.sql}`;
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.reportId) where += ` AND t.report_id=${bind(f.reportId)}::uuid`;
  if (f.status) where += ` AND t.status=${bind(f.status)}`;
  if (f.assignee) where += f.assignee === 'unassigned' ? ' AND t.assignee_id IS NULL' : ` AND t.assignee_id=${bind(f.assignee === 'me' ? p.sub : f.assignee)}::uuid`;
  if (f.overdue) where += ` AND ${f.overdue === 'no' ? 'NOT ' : ''}(t.status IN ('todo','in_progress') AND t.due_at < now())`;
  const dir = f.direction === 'desc' ? 'DESC' : 'ASC';
  const sort = f.sort === 'status' ? `t.status ${dir}, t.due_at ASC` : `t.due_at ${dir}`;
  const { rows: [result] } = await query(`WITH filtered AS (SELECT t.*,r.ref_no,r.ward_code,w.name AS ward_name
    FROM resident_report_tasks t JOIN resident_reports r ON r.id=t.report_id LEFT JOIN regions w ON w.code=r.ward_code ${where}),
    page AS (SELECT t.*, COALESCE((SELECT json_agg(e ORDER BY e.created_at,e.id) FROM resident_report_task_events e WHERE e.task_id=t.id),'[]'::json) AS events
      FROM filtered t ORDER BY ${sort},t.id ${dir} LIMIT $${params.length + 1} OFFSET $${params.length + 2})
    SELECT (SELECT count(*)::int FROM filtered) AS total, COALESCE((SELECT json_agg(p) FROM page p),'[]'::json) AS items`, [...params, f.limit, f.offset]);
  const names = await staffNames(result.items.flatMap((t: any) => [t.assignee_id, t.created_by, ...t.events.map((e: any) => e.actor_id)]), p);
  const validity = new Map<string, boolean>();
  for (const t of result.items) {
    const key = `${t.ward_code}:${t.assignee_id}`;
    if (t.assignee_id && !validity.has(key)) validity.set(key, (await eligibleStaff(t.ward_code, [t.assignee_id])).length === 1);
  }
  return { total: result.total, items: result.items.map((t: any) => ({
    id: t.id, reportId: t.report_id, refNo: t.ref_no, wardCode: t.ward_code, wardName: t.ward_name,
    title: t.title, instructions: t.instructions, assigneeId: t.assignee_id, assigneeName: names[t.assignee_id] ?? null,
    assigneeEligible: t.assignee_id ? !!validity.get(`${t.ward_code}:${t.assignee_id}`) : false,
    isMine: t.assignee_id === p.sub, canManage: p.permissions?.includes(Permission.REPORT_WRITE),
    dueAt: t.due_at, status: t.status, outcome: t.outcome, version: t.version,
    createdAt: t.created_at, completedAt: t.completed_at,
    events: t.events.map((e: any) => ({ id: e.id, action: e.action, actorName: names[e.actor_id] ?? 'Former staff member',
      outcome: e.outcome, createdAt: e.created_at })),
  })) };
}

function futureDue(value: string) {
  if (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) throw ApiError.badRequest('Choose a future task due date');
}

export async function saveReportTask(reportId: string, taskId: string | null, input: CreateReportTask | UpdateReportTask, principal: Principal) {
  const result = await withTransaction(async (client) => {
    const { report, principal: p } = await authorizeReportStaff(reportId, principal, true, client);
    let previous;
    let task;
    if (taskId) {
      task = (await client.query('SELECT * FROM resident_report_tasks WHERE id=$1 AND report_id=$2 FOR UPDATE', [taskId, reportId])).rows[0];
      if (!task) throw ApiError.notFound('Task not found on this report');
      previous = (await client.query('SELECT actor_id FROM resident_report_task_events WHERE task_id=$1 AND request_id=$2', [taskId, input.requestId])).rows[0];
    } else {
      previous = (await client.query('SELECT id,created_by AS actor_id FROM resident_report_tasks WHERE report_id=$1 AND request_id=$2', [reportId, input.requestId])).rows[0];
    }
    if (previous) {
      if (previous.actor_id !== p.sub) throw ApiError.conflict('Request already used by another staff member');
      return { id: taskId ?? previous.id, replay: true, ward: report.ward_code };
    }
    if (!task && ['closed','resolved'].includes(report.status)) throw ApiError.conflict('Reopen the report before creating another task');
    const update = input as UpdateReportTask;
    if (task && update.expectedVersion !== task.version) throw ApiError.conflict('Task changed. Reload before saving.');
    const status = task ? update.status ?? task.status : 'todo';
    const terminal = ['done','cancelled'].includes(status);
    const wasTerminal = task && ['done','cancelled'].includes(task.status);
    if (wasTerminal && terminal) throw ApiError.conflict('Reopen the task before editing it');
    if (terminal && !update.outcome) throw ApiError.badRequest('A completion or cancellation outcome is required');
    const due = input.dueAt ?? task?.due_at;
    if (!task || input.dueAt || (wasTerminal && !terminal)) futureDue(String(due));
    const assignee = input.assigneeId !== undefined ? input.assigneeId : task?.assignee_id ?? null;
    const assigneePrincipal = assignee ? (await eligibleStaff(report.ward_code, [assignee], client))[0] : null;
    if (assignee && !assigneePrincipal) {
      throw ApiError.badRequest('Assignee no longer has access. Choose an eligible staff member or leave unassigned.');
    }
    const title = input.title ?? task?.title;
    const instructions = input.instructions !== undefined ? input.instructions : task?.instructions ?? null;
    const outcome = terminal ? update.outcome : null;
    const action = !task ? 'created' : status !== task.status ? status : assignee !== task.assignee_id ? 'assigned' : 'updated';
    let id = taskId;
    if (task) {
      await client.query(`UPDATE resident_report_tasks SET title=$2,instructions=$3,assignee_id=$4,due_at=$5,status=$6,
        outcome=$7,completed_at=CASE WHEN $6='done' THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE id=$1`,
      [id, title, instructions, assignee, due, status, outcome]);
    } else {
      id = (await client.query(`INSERT INTO resident_report_tasks(report_id,title,instructions,assignee_id,due_at,created_by,request_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [reportId, title, instructions, assignee, due, p.sub, input.requestId])).rows[0].id;
    }
    await client.query(`INSERT INTO resident_report_task_events(task_id,actor_id,action,from_status,to_status,outcome,assignee_id,due_at,request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, p.sub, action, task?.status ?? null, status, outcome, assignee, due, input.requestId]);
    if (assignee && assignee !== task?.assignee_id) await notify({ userId: assignee, kind: 'report', title: 'Resident report task assigned',
      body: 'Open Resident Reports to review your assigned task.',
      link: assigneePrincipal?.role === 'local_coordinator' ? `tab:engage#report:${reportId}` : `/crm/resident-reports?report=${reportId}`,
      regionCode: report.ward_code }, client);
    return { id: id!, replay: false, ward: report.ward_code };
  });
  if (!result.replay) await recordAudit({ action: 'transparency.report.task.update', actorId: principal.sub, actorRole: principal.role,
    targetType: 'resident_report_task', targetId: result.id, regionCode: result.ward,
    metadata: { reportId } }).catch(() => logger.error({ taskId: result.id }, 'Task committed; audit delivery failed'));
  return { id: result.id };
}
