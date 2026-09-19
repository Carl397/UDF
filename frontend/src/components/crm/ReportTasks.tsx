'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { localDateTime, REPORT_PAGE_SIZE } from '../../lib/reportManagement';
import type { ReportAssignee, ReportTask, ReportTaskFilters, ReportTaskInput, ResidentReport } from '../../types';
import { CrmButton, CrmSmallButton, fmtDateTime } from './ui';
import styles from './ResidentReports.module.css';

export function ReportPager({ page, total, onPage, busy = false }: { page: number; total: number; onPage: (page: number) => void; busy?: boolean }) {
  const pages = Math.max(1, Math.ceil(total / REPORT_PAGE_SIZE));
  return <nav className={styles.pager} aria-label="Pagination">
    <span>Showing {total ? page * REPORT_PAGE_SIZE + 1 : 0}–{Math.min((page + 1) * REPORT_PAGE_SIZE, total)} of {total}</span>
    <div><CrmSmallButton disabled={busy || page === 0} onClick={() => onPage(page - 1)}>Previous</CrmSmallButton>
      <span>Page {page + 1} of {pages}</span><CrmSmallButton disabled={busy || page + 1 >= pages} onClick={() => onPage(page + 1)}>Next</CrmSmallButton></div>
  </nav>;
}

function TaskEditor({ reportId, task, report, onSaved, onCancel }: {
  reportId: string; task?: ReportTask; report?: ResidentReport; onSaved: () => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? `${report?.refNo ?? ''} — ${report?.category ?? 'Follow-up'}`);
  const [instructions, setInstructions] = useState(task?.instructions ?? report?.message ?? '');
  const [assignee, setAssignee] = useState(task?.assigneeId ?? '');
  const initialDue = task?.dueAt ? localDateTime(task.dueAt) : '';
  const [due, setDue] = useState(initialDue);
  const [status, setStatus] = useState<ReportTask['status']>(task && ['done','cancelled'].includes(task.status) ? 'todo' : task?.status ?? 'todo');
  const [outcome, setOutcome] = useState('');
  const [people, setPeople] = useState<ReportAssignee[]>([]);
  const [peopleReady, setPeopleReady] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<{ payload: string; id: string }>();
  const saving = useRef(false);
  useEffect(() => {
    let active = true;
    api.reportAssignees(reportId).then((r) => { if (active) { setPeople(r.items); setPeopleReady(true); } })
      .catch((e) => { if (active) setError(e.message || 'Could not load eligible staff'); });
    return () => { active = false; };
  }, [reportId]);
  const save = async () => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const payload = { title: title.trim(), instructions: instructions.trim() || null, assigneeId: assignee || null,
        ...(!task || due !== initialDue || ['done','cancelled'].includes(task.status) ? { dueAt: new Date(due).toISOString() } : {}),
        ...(task ? { status, expectedVersion: task.version, ...(['done','cancelled'].includes(status) ? { outcome: outcome.trim() } : {}) } : {}) };
      const serialized = JSON.stringify(payload);
      if (request.current?.payload !== serialized) request.current = { payload: serialized, id: crypto.randomUUID() };
      const input: ReportTaskInput = { ...payload, requestId: request.current.id };
      if (task) await api.updateReportTask(reportId, task.id, input); else await api.createReportTask(reportId, input);
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save task'); }
    finally { saving.current = false; setBusy(false); }
  };
  return <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <h3>{task ? 'Manage task' : 'Create linked task'}</h3>
    <label>Task title<input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
    <label>Instructions (staff only)<textarea maxLength={4000} rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} /></label>
    <label>Assign to<select value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={!peopleReady}>
      <option value="">Unassigned</option>{assignee && !people.some((p) => p.id === assignee) && <option value={assignee}>Previous assignee — reassignment needed</option>}
      {people.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.role.replace(/_/g, ' ')}{p.isMe ? ' (me)' : ''}</option>)}
    </select></label>
    <CrmSmallButton disabled={!people.some((p) => p.isMe)} onClick={() => setAssignee(people.find((p) => p.isMe)?.id ?? '')}>Claim for me</CrmSmallButton>
    <label>Due date and time<input required type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></label>
    {task && <label>Task status<select value={status} onChange={(e) => setStatus(e.target.value as ReportTask['status'])}>
      {(['done','cancelled'].includes(task.status) ? ['todo','in_progress'] : ['todo','in_progress','done','cancelled']).map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
    </select></label>}
    {['done','cancelled'].includes(status) && <label>Outcome / reason (staff only)<textarea required rows={3} maxLength={4000} value={outcome} onChange={(e) => setOutcome(e.target.value)} /></label>}
    <p className={styles.muted}>Task changes do not acknowledge or close the report. Dates use your device’s local time.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div><CrmButton type="submit" disabled={busy || !peopleReady}>{busy ? 'Saving…' : task ? 'Save task' : 'Create task'}</CrmButton>{' '}
      <CrmButton variant="secondary" disabled={busy} onClick={onCancel}>Cancel</CrmButton></div>
  </form>;
}

export default function ReportTasks({ report, refreshKey = 0, onOpen, onChanged, onDirtyChange }: {
  report?: ResidentReport; refreshKey?: number; onOpen?: (id: string) => void; onChanged: () => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const [items, setItems] = useState<ReportTask[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState<ReportTaskFilters>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<ReportTask | 'new' | null>(null);
  const dirty = editor !== null;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    api.reportTasks({ ...filters, reportId: report?.id }, REPORT_PAGE_SIZE, page * REPORT_PAGE_SIZE).then((r) => {
      if (!active) return;
      if (page && page * REPORT_PAGE_SIZE >= r.total) { setPage(Math.max(0, Math.ceil(r.total / REPORT_PAGE_SIZE) - 1)); return; }
      setItems(r.items); setTotal(r.total);
    }).catch((e) => { if (active) setError(e.message || 'Could not load tasks'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filters, page, report?.id, revision, refreshKey]);
  const discard = useCallback(() => !dirty || window.confirm('Discard the unsaved task changes?'), [dirty]);
  const changeFilter = (key: keyof ReportTaskFilters, value: string) => {
    if (!discard()) return; setEditor(null); setPage(0); setFilters((f) => ({ ...f, [key]: value || undefined }));
  };
  const saved = () => { setEditor(null); setRevision((r) => r + 1); onChanged(); };
  return <section aria-label="Report tasks">
    <div className={styles.toolbar}><div><h3>Linked tasks</h3><span className={styles.muted}>Staff-only work queue · 15 tasks per page</span></div>
      {report?.canManage && <CrmButton disabled={!!editor || ['resolved','closed'].includes(report.status)} onClick={() => setEditor('new')}>Create task</CrmButton>}
    </div>
    {report && ['resolved','closed'].includes(report.status) && <p className={styles.muted}>Existing tasks remain actionable. Reopen the report before creating a new task.</p>}
    <div className={styles.filters}>
      <label>Task owner<select value={filters.assignee ?? ''} onChange={(e) => changeFilter('assignee', e.target.value)}>
        <option value="">All permitted tasks</option><option value="me">My tasks</option><option value="unassigned">Unassigned</option>
      </select></label>
      <label>Task status<select value={filters.status ?? ''} onChange={(e) => changeFilter('status', e.target.value)}><option value="">All statuses</option>
        {['todo','in_progress','done','cancelled'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Due<select value={filters.overdue ?? ''} onChange={(e) => changeFilter('overdue', e.target.value)}><option value="">All dates</option><option value="yes">Overdue</option><option value="no">Not overdue</option></select></label>
      <label>Sort<select value={filters.sort ?? 'due'} onChange={(e) => changeFilter('sort', e.target.value)}><option value="due">Due date</option><option value="status">Status</option></select></label>
      <label>Direction<select value={filters.direction ?? 'asc'} onChange={(e) => changeFilter('direction', e.target.value)}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
    </div>
    {editor && <TaskEditor key={editor === 'new' ? 'new' : `${editor.id}:${editor.version}`} reportId={editor === 'new' ? report!.id : editor.reportId}
      report={report} task={editor === 'new' ? undefined : editor} onSaved={saved} onCancel={() => { if (discard()) setEditor(null); }} />}
    {error ? <p role="alert" className={styles.error}>{error} <CrmSmallButton onClick={() => setRevision((r) => r + 1)}>Retry</CrmSmallButton></p>
      : loading ? <p role="status" className={styles.empty}>Loading tasks…</p> : <>
        {!items.length && <p className={styles.empty}>No tasks match this view.</p>}
        {items.map((t) => <article className={styles.taskCard} key={t.id}>
          <div className={styles.toolbar}><h3>{t.title}</h3><span className={styles.tag}>{t.status.replace(/_/g, ' ')}</span></div>
          <p className={styles.muted}>{t.refNo} · {t.wardName ?? t.wardCode ?? 'Ward not set'}</p>
          <p>Assigned to <strong>{t.assigneeName ?? 'Unassigned'}</strong>{t.isMine ? ' (me)' : ''}{t.assigneeId && !t.assigneeEligible && <span className={`${styles.tag} ${styles.warning}`}>Reassignment needed</span>}</p>
          <p>Due {fmtDateTime(t.dueAt)}{' '}{['todo','in_progress'].includes(t.status) && Date.parse(t.dueAt) < Date.now() && <span className={`${styles.tag} ${styles.danger}`}>Overdue</span>}</p>
          {t.instructions && <p>{t.instructions}</p>}{t.outcome && <p><strong>Outcome:</strong> {t.outcome}</p>}
          <div>{t.canManage && <CrmSmallButton disabled={!!editor} onClick={() => setEditor(t)}>{['done','cancelled'].includes(t.status) ? 'Reopen task' : 'Manage / assign'}</CrmSmallButton>}
            {!report && onOpen && <CrmSmallButton disabled={!!editor} onClick={() => onOpen(t.reportId)}>View report</CrmSmallButton>}</div>
          <details><summary>Task history ({t.events.length})</summary><ol>{t.events.map((e) => <li key={e.id}>{e.action.replace(/_/g, ' ')} · {e.actorName} · {fmtDateTime(e.createdAt)}{e.outcome && <p>{e.outcome}</p>}</li>)}</ol></details>
        </article>)}
        <ReportPager page={page} total={total} onPage={(p) => { if (discard()) { setEditor(null); setPage(p); } }} />
      </>}
  </section>;
}
