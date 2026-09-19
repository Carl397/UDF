'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { acknowledgmentLabel, c3Label, REPORT_EXPORT_HEADERS, REPORT_PAGE_SIZE, reportExportRows } from '../../../lib/reportManagement';
import { CrmPageHeader, CrmStatGrid, CrmTable, CrmSmallButton, downloadCsv, fmtDateTime } from '../../../components/crm/ui';
import { REPORT_LABEL } from '../../../components/ReportWorkflowPanel';
import ReportTasks, { ReportPager } from '../../../components/crm/ReportTasks';
import ResidentReportDialog from '../../../components/crm/ResidentReportDialog';
import type { ReportAccountability, ReportFilterOptions, ReportFilters, ReportStats, ResidentReport } from '../../../types';
import styles from '../../../components/crm/ResidentReports.module.css';

const emptyOptions: ReportFilterOptions = { categories: [], wards: [], councillors: [] };

/** Staff inbox; all lists, counts, tasks, and exports are territory-scoped by the API. */
export default function CrmResidentReports() {
  const [items, setItems] = useState<ResidentReport[]>([]);
  const [groups, setGroups] = useState<ReportAccountability[]>([]);
  const [stats, setStats] = useState<ReportStats | null>(null);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<ReportFilters>({});
  const [options, setOptions] = useState(emptyOptions);
  const [optionsError, setOptionsError] = useState('');
  const [page, setPage] = useState(0);
  const [tab, setTab] = useState('reports');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [taskDirty, setTaskDirty] = useState(false);
  const changed = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('report');
    if (id && /^[\da-f-]{36}$/i.test(id)) setSelectedId(id);
  }, []);
  useEffect(() => {
    let active = true;
    api.reportFilterOptions().then((r) => { if (active) { setOptions(r); setOptionsError(''); } })
      .catch(() => { if (active) setOptionsError('Filter options could not be loaded.'); });
    return () => { active = false; };
  }, [revision]);
  useEffect(() => {
    if (tab === 'tasks') return;
    let active = true; setLoading(true); setError('');
    const timer = window.setTimeout(async () => {
      try {
        const reports = await api.managedReports(filters, REPORT_PAGE_SIZE, tab === 'reports' ? page * REPORT_PAGE_SIZE : 0);
        const summary = tab === 'summary' ? await api.reportAccountability(filters, REPORT_PAGE_SIZE, page * REPORT_PAGE_SIZE) : null;
        if (!active) return;
        const count = summary?.total ?? reports.total;
        if (page && page * REPORT_PAGE_SIZE >= count) { setPage(Math.max(0, Math.ceil(count / REPORT_PAGE_SIZE) - 1)); return; }
        setItems(reports.items); setGroups(summary?.items ?? []); setTotal(count); setStats(reports.stats);
      } catch (e) { if (active) { setError(e instanceof Error ? e.message : 'Could not load reports'); setStats(null); } }
      finally { if (active) setLoading(false); }
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [filters, page, revision, tab]);
  const filter = (key: keyof ReportFilters, value: string) => { setPage(0); setFilters((f) => ({ ...f, [key]: value || undefined })); };
  const activeFilters = Object.entries(filters).filter(([key, value]) => !!value && !['sort','direction'].includes(key));
  const select = (key: keyof ReportFilters, label: string, values: Array<[string, string]>, placeholder = 'All') =>
    <label>{label}<select value={filters[key] ?? ''} onChange={(e) => filter(key, e.target.value)}><option value="">{placeholder}</option>
      {values.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>;
  const exportCsv = async () => {
    if (exporting) return; setExporting(true); setExportError('');
    try { downloadCsv('resident-reports-filtered', REPORT_EXPORT_HEADERS, await reportExportRows({ ...filters })); }
    catch (e) { setExportError(e instanceof Error ? e.message : 'Could not export reports'); }
    finally { setExporting(false); }
  };
  const closeReport = () => {
    setSelectedId(null);
    const url = new URL(window.location.href); url.searchParams.delete('report'); window.history.replaceState(null, '', url);
  };
  return <div className={styles.root}>
    <CrmPageHeader title="Resident Reports" subtitle="Manage resident concerns, municipal references, and accountable follow-through across your territory."
      actions={<><CrmSmallButton onClick={changed}>Refresh</CrmSmallButton>{tab !== 'tasks' && <CrmSmallButton disabled={exporting || loading || !!error} onClick={exportCsv}>{exporting ? 'Exporting…' : 'Export filtered CSV'}</CrmSmallButton>}</>} />
    {tab !== 'tasks' && !loading && stats && <CrmStatGrid stats={[
      { label: 'Open reports', value: stats.open }, { label: 'Unacknowledged', value: stats.unacknowledged, tone: 'warn' },
      { label: 'No action recorded', value: stats.noAction, tone: 'warn' }, { label: 'Required C3 missing', value: stats.missingC3, tone: 'danger' },
      { label: 'Overdue work', value: stats.overdue, tone: 'danger' },
    ]} />}
    <nav className={styles.tabs} aria-label="Resident report views">{[['reports','Reports'],['summary','Ward / Councillor summary'],['tasks','Tasks']].map(([key,label]) =>
      <button key={key} type="button" aria-pressed={tab === key} onClick={() => { if (key === tab) return; if (!taskDirty || window.confirm('Discard the unsaved task changes?')) { setTab(key); setPage(0); setTaskDirty(false); } }}>{label}</button>)}</nav>
    {exportError && <p role="alert" className={styles.error}>{exportError}</p>}
    {tab !== 'tasks' && <>
      {optionsError && <p role="alert" className={styles.error}>{optionsError} <CrmSmallButton onClick={changed}>Retry options</CrmSmallButton></p>}
      <div className={styles.filters}>
        <label>Search reports<input type="search" maxLength={200} placeholder="Reference or message" value={filters.search ?? ''} onChange={(e) => filter('search', e.target.value)} /></label>
        {select('status','Report status',Object.entries(REPORT_LABEL),'All statuses')}
        {select('category','Category',options.categories.map((c) => [c,c]),'All categories')}
        {select('ward','Ward',[['unassigned','Ward not set'], ...options.wards.map((w): [string,string] => [w.code,w.name])],'All wards')}
        {select('councillor','Responsible councillor',[['unassigned','No active assignment'], ...options.councillors.map((p): [string,string] => [p.id,p.name])],'All councillors')}
        {select('acknowledged','Acknowledgment',[['yes','Acknowledged'],['no','Not acknowledged'],['unknown','Legacy unknown']])}
        {select('actionTaken','Action evidence',[['yes','Action recorded'],['no','No action recorded'],['councillor','Councillor action recorded']])}
        {select('c3','C3 tracking',[['needs_assessment','Needs assessment'],['required','C3 required'],['not_required','C3 not required'],['missing','Required — number missing'],['recorded','C3 number recorded']])}
        {select('assignee','Open task owner',[['me','Assigned to me'],['unassigned','Unassigned'], ...(options.taskAssignees ?? []).map((p): [string,string] => [p.id,p.name])])}
        {select('overdue','Due work',[['yes','Overdue'],['no','Not overdue']])}
        <label>Received from<input type="date" value={filters.from?.slice(0,10) ?? ''} onChange={(e) => filter('from', e.target.value ? `${e.target.value}T00:00:00+02:00` : '')} /></label>
        <label>Received through<input type="date" value={filters.to?.slice(0,10) ?? ''} onChange={(e) => filter('to', e.target.value ? `${e.target.value}T23:59:59.999+02:00` : '')} /></label>
      </div>
      <div className={styles.toolbar}><div><strong>{loading ? 'Loading results…' : `${stats?.total ?? 0} matching reports`}</strong><p className={styles.muted}>Totals cover all matching reports. Received-date filters use South African time.{stats?.unknownAcknowledgment ? ` ${stats.unknownAcknowledgment} legacy acknowledgment(s) unknown.` : ''}</p></div>
        <CrmSmallButton onClick={() => { setFilters({}); setPage(0); }}>Clear filters</CrmSmallButton></div>
      {!!activeFilters.length && <div className={styles.chips} aria-label="Active filters">{activeFilters.map(([key,value]) => <button key={key} type="button" onClick={() => filter(key as keyof ReportFilters, '')}>{key}: {options.councillors.find((p) => p.id === value)?.name ?? options.taskAssignees?.find((p) => p.id === value)?.name ?? value} ×</button>)}</div>}
      {tab === 'reports' && <div className={styles.filters}>
        <label>Sort reports<select value={filters.sort ?? 'received'} onChange={(e) => filter('sort', e.target.value)}><option value="received">Received date</option><option value="lastAction">Last substantive action</option><option value="nextDue">Next due date</option></select></label>
        <label>Sort direction<select value={filters.direction ?? 'desc'} onChange={(e) => filter('direction', e.target.value)}><option value="desc">Descending / newest first</option><option value="asc">Ascending / oldest first</option></select></label>
      </div>}
      {error ? <p role="alert" className={styles.error}>{error} <CrmSmallButton onClick={changed}>Retry</CrmSmallButton></p>
        : loading ? <p role="status" className={styles.empty}>Loading resident reports…</p> : <>
          {tab === 'reports' ? <CrmTable columns={['Report','Ward / Councillor','Status','Acknowledgment','Action evidence','C3','Tasks / Due','Received','Actions']}
            rows={items.map((r) => [
              <div className={styles.cell} key="report"><strong>{r.refNo}</strong><span className={styles.muted}>{r.category}</span><span className={styles.preview}>{r.message}</span></div>,
              <div className={styles.cell} key="ward"><strong>{r.wardName ?? r.wardCode ?? 'Ward not set'}</strong><span>{r.councillorName ?? 'Unassigned'}</span>{r.assignmentState !== 'active' && <span className={`${styles.tag} ${styles.warning}`}>{r.assignmentState}</span>}</div>,
              <span className={styles.tag} key="status">{REPORT_LABEL[r.status] ?? r.status}</span>,
              <div className={styles.cell} key="ack"><span className={`${styles.tag} ${r.acknowledgment === 'yes' ? styles.success : styles.warning}`}>{acknowledgmentLabel(r)}</span>{r.acknowledgedByName && <small>{r.acknowledgedByName}</small>}{r.acknowledgedAt && <small>{fmtDateTime(r.acknowledgedAt)}</small>}</div>,
              <div className={styles.cell} key="action"><span className={`${styles.tag} ${r.lastActionAt ? styles.success : styles.warning}`}>{r.lastActionAt ? 'Action recorded' : 'No action recorded'}</span>{r.lastActionAt && <small>{fmtDateTime(r.lastActionAt)}</small>}<small>{r.councillorActionAt ? 'Councillor action recorded' : 'No councillor action recorded'}</small></div>,
              <div className={styles.cell} key="c3"><span className={`${styles.tag} ${r.c3Requirement === 'required' && !r.hasC3 ? styles.danger : ''}`}>{c3Label(r)}</span><small>{r.hasC3 ? 'C3 number present' : 'No C3 number'}</small></div>,
              <div className={styles.cell} key="tasks"><span>{r.openTasks ?? 0} open tasks</span><small>{fmtDateTime(r.nextDueAt)}</small>{r.nextDueAt && Date.parse(r.nextDueAt) < Date.now() && <span className={`${styles.tag} ${styles.danger}`}>Overdue</span>}</div>,
              fmtDateTime(r.createdAt), <CrmSmallButton key="view" onClick={() => setSelectedId(r.id)}>View</CrmSmallButton>,
            ])} empty={activeFilters.length ? 'No reports match your filters. Clear filters to broaden the search.' : 'No resident reports in your territory yet.'} />
            : <CrmTable columns={['Ward','Councillor','Reports','Unacknowledged','Unknown acknowledgment','No action recorded','Councillor acknowledgments','Councillor actions','C3 missing','Overdue']}
              rows={groups.map((g) => [g.wardName ?? g.wardCode ?? 'Ward not set', `${g.councillorName ?? 'Unassigned'}${g.assignmentState !== 'active' ? ` (${g.assignmentState})` : ''}`, g.total, g.unacknowledged, g.unknownAcknowledgment, g.noAction, g.councillorAcknowledged, g.councillorActions, g.missingC3, g.overdue])} empty="No ward/councillor groups match these filters." />}
          <ReportPager page={page} total={total} onPage={setPage} />
        </>}
    </>}
    {tab === 'tasks' && <ReportTasks refreshKey={revision} onOpen={setSelectedId} onChanged={changed} onDirtyChange={setTaskDirty} />}
    {selectedId && <ResidentReportDialog key={selectedId} id={selectedId} onClose={closeReport} onChanged={changed} />}
  </div>;
}
