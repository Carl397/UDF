'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { acknowledgmentLabel, c3Label } from '../../lib/reportManagement';
import type { ResidentReport } from '../../types';
import ReportWorkflowPanel, { REPORT_LABEL } from '../ReportWorkflowPanel';
import { MediaThumb } from '../WardTransparency';
import ReportTasks from './ReportTasks';
import { CrmSmallButton, fmtDateTime } from './ui';
import styles from './ResidentReports.module.css';

export default function ResidentReportDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [report, setReport] = useState<ResidentReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState('overview');
  const [workflowDirty, setWorkflowDirty] = useState(false);
  const [taskDirty, setTaskDirty] = useState(false);
  const dirty = workflowDirty || taskDirty;
  useEffect(() => {
    const el = dialog.current!;
    const trigger = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    el.showModal(); document.body.style.overflow = 'hidden';
    return () => { el.close(); document.body.style.overflow = overflow; if (trigger?.isConnected) trigger.focus(); };
  }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    api.residentReport(id).then((r) => { if (active) setReport(r); })
      .catch((e) => { if (active) { setReport(null); setError(e.message || 'Could not open report'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, revision]);
  const close = () => { if (!dirty || window.confirm('Discard unsaved report or task changes?')) onClose(); };
  const update = (r: ResidentReport) => { setReport(r); onChanged(); };
  const tasksChanged = useCallback(() => { setRevision((n) => n + 1); onChanged(); }, [onChanged]);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="report-dialog-title" onCancel={(e) => { e.preventDefault(); close(); }}
    onClick={(e) => { if (e.target === e.currentTarget) { const rect = e.currentTarget.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right) close(); } }}>
    <header className={styles.dialogHead}>
      <div className={styles.toolbar}><div><h2 id="report-dialog-title">{report?.refNo ?? 'Resident report'}</h2><span className={styles.muted}>{report?.category ?? 'Report details'}</span></div>
        <CrmSmallButton onClick={close}>Close report</CrmSmallButton></div>
      {report && <><div>{report.wardName ?? report.wardCode ?? 'Ward not set'} · {report.councillorName ?? 'No assigned councillor'}{report.assignmentState !== 'active' ? ` (${report.assignmentState ?? 'unassigned'})` : ''}</div>
        <div className={styles.metadata}><span className={styles.tag}>{REPORT_LABEL[report.status] ?? report.status}</span>
          <span className={`${styles.tag} ${report.acknowledgment === 'yes' ? styles.success : styles.warning}`}>{acknowledgmentLabel(report)}</span>
          <span className={`${styles.tag} ${report.c3Requirement === 'required' && !report.hasC3 ? styles.danger : ''}`}>C3: {c3Label(report)}</span></div></>}
    </header>
    <div className={styles.dialogBody}>
      {error && <p role="alert" className={styles.error}>{error} <CrmSmallButton onClick={() => setRevision((n) => n + 1)}>Retry</CrmSmallButton></p>}
      {loading && <p role="status">Loading report…</p>}
      {report && <>
        <nav className={styles.tabs} aria-label="Report sections">{[['overview','Overview'],['actions','Actions & History'],['tasks','Tasks']].map(([key,label]) =>
          <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>{label}{key === 'tasks' ? ` (${report.openTasks ?? 0} open)` : ''}</button>)}</nav>
        <section hidden={tab !== 'overview'} aria-label="Report overview">
          <div className={styles.message}>{report.message}</div>
          <dl className={styles.overview}>
            <div><dt>Received</dt><dd>{fmtDateTime(report.createdAt)}</dd></div>
            <div><dt>Acknowledged</dt><dd>{acknowledgmentLabel(report)}{report.acknowledgedAt && <><br />{fmtDateTime(report.acknowledgedAt)}</>}{report.acknowledgedByName && <><br />{report.acknowledgedByName}</>}</dd></div>
            <div><dt>Action evidence</dt><dd>{report.lastActionAt ? `Action recorded ${fmtDateTime(report.lastActionAt)}` : 'No action recorded'}</dd></div>
            <div><dt>Responsible councillor action</dt><dd>{report.councillorActionAt ? fmtDateTime(report.councillorActionAt) : 'No councillor action recorded'}</dd></div>
            <div><dt>Next task / follow-up due</dt><dd>{fmtDateTime(report.nextDueAt)}</dd></div>
            <div><dt>C3 number presence</dt><dd>{report.hasC3 ? 'C3 number recorded' : 'No C3 number recorded'}{report.c3Reason && <p>{report.c3Reason}</p>}</dd></div>
            <div><dt>{report.referenceKind === 'c3' ? 'Municipal C3 number' : 'Service-provider reference'}</dt><dd>{report.externalReference ?? 'Not recorded'}{report.referenceMasked && report.externalReference ? ' (masked)' : ''}</dd></div>
          </dl>
          <h3>Attachments ({report.media.length})</h3><div className={styles.metadata}>{report.media.map((m) => <MediaThumb key={m.mediaId} mediaId={m.mediaId} label={m.captureMode.replace(/_/g, ' ')} />)}</div>
          {!report.media.length && <p className={styles.muted}>No attachments.</p>}
        </section>
        <section hidden={tab !== 'actions'} aria-label="Report actions and history"><ReportWorkflowPanel report={report} onUpdated={update} onDirtyChange={setWorkflowDirty} /></section>
        <section hidden={tab !== 'tasks'} aria-label="Linked report tasks"><ReportTasks report={report} onChanged={tasksChanged} onDirtyChange={setTaskDirty} /></section>
      </>}
    </div>
  </dialog>;
}
