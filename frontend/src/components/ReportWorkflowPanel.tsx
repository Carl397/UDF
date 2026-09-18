'use client';

import { useRef, useState } from 'react';
import { api } from '../lib/api';
import type { ResidentReport, ReportActionInput } from '../types';
import { MediaThumb } from './WardTransparency';

export const REPORT_LABEL: Record<string, string> = { submitted: 'Submitted', acknowledged: 'Acknowledged',
  in_progress: 'Follow-up', resolved: 'Awaiting member confirmation', closed: 'Completed' };

export default function ReportWorkflowPanel({ report, onUpdated }: { report: ResidentReport; onUpdated: (report: ResidentReport) => void }) {
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<ReportActionInput['contactMethod']>('phone');
  const [target, setTarget] = useState('');
  const [methodDetail, setMethodDetail] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [reference, setReference] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ payload: string; id: string } | null>(null);
  const saving = useRef(false);
  const run = async (action: ReportActionInput['action']) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setError('');
    try {
      const memberAction = action === 'confirm' || action === 'request_follow_up';
      const payload: ReportActionInput = { action, expectedVersion: report.version,
        ...(note.trim() ? { feedback: note.trim() } : {}),
        ...(!memberAction && reference.trim() && report.canSetReference ? { externalReference: reference.trim() } : {}),
        ...(action === 'contact' ? { contactMethod: method, contactTarget: target.trim(), ...(method === 'other' ? { contactMethodDetail: methodDetail.trim() } : {}) } : {}),
        ...(!memberAction && internalNote.trim() ? { internalNote: internalNote.trim() } : {}),
        ...(!memberAction && due ? { followUpAt: new Date(due).toISOString() } : {}),
      };
      const serialized = JSON.stringify(payload);
      if (request.current?.payload !== serialized) request.current = { payload: serialized, id: crypto.randomUUID() };
      const updated = await api.updateResidentReport(report.id, { ...payload, requestId: request.current.id });
      onUpdated(updated); setNote(''); setReference(''); setDue(''); setInternalNote(''); setTarget(''); setMethodDetail(''); request.current = null;
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the action'); }
    finally { setBusy(false); saving.current = false; }
  };
  const button = (label: string, action: ReportActionInput['action']) =>
    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(action)}>{label}</button>;
  return <section aria-label="Report follow-up" style={{ marginTop: 12 }}>
    <p><strong>{REPORT_LABEL[report.status] ?? report.status}</strong>{report.assigned === false ? ' · Unassigned — awaiting councilor assignment' : ''}</p>
    <p><strong>Service-provider reference:</strong> {report.externalReference || 'Not logged yet'}{report.referenceMasked && report.externalReference ? ' (masked)' : ''}</p>
    {report.followUpAt && <p>Next follow-up: {new Date(report.followUpAt).toLocaleString()}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      {report.media.map((m) => <MediaThumb key={m.mediaId} mediaId={m.mediaId} label={m.captureMode.replace('_', ' ')} />)}
    </div>
    <h4>Action history</h4>
    {report.events?.length ? <ol style={{ paddingLeft: 20 }}>{report.events.map((event) => <li key={event.id} style={{ marginBottom: 12 }}>
      <strong>{event.action.replace(/_/g, ' ')}</strong> · {event.actorRole?.replace(/_/g, ' ') || 'Legacy actor unknown'} · {event.action === 'legacy_feedback' ? 'Legacy feedback — original timing may be unknown' : new Date(event.createdAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}
      {event.contactMethod && <span> · {event.contactMethod.replace(/_/g, ' ')}</span>}
      {event.contactTarget && <p>Contacted: {event.contactTarget}{event.contactMethodDetail ? ` · ${event.contactMethodDetail}` : ''}</p>}
      {event.internalNote && <p><strong>Staff-only note:</strong> {event.internalNote}</p>}
      {event.note && <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{event.note}</p>}
      {event.followUpAt && <small>Follow-up due {new Date(event.followUpAt).toLocaleString()}</small>}
    </li>)}</ol> : <p>No follow-up actions recorded yet.</p>}
    {(report.canManage || report.isOwner) && <>
      <label style={{ display: 'block', marginBottom: 12 }}>Update / contact outcome / reason (shared with the reporter)
        <textarea className="input" value={note} maxLength={4000} rows={3} onChange={(e) => setNote(e.target.value)} />
      </label>
      {report.canManage && <div style={{ display: 'grid', gap: 12, marginBottom: 12 }}>
        <label>Contact method <select className="input" value={method} onChange={(e) => setMethod(e.target.value as ReportActionInput['contactMethod'])}>
          {['phone','email','sms','whatsapp','in_person','service_portal','other'].map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}
        </select></label>
        {method === 'other' && <label>Describe contact method<input className="input" maxLength={200} value={methodDetail} onChange={(e) => setMethodDetail(e.target.value)} /></label>}
        <label>Staff-only note<textarea className="input" maxLength={4000} value={internalNote} onChange={(e) => setInternalNote(e.target.value)} /></label>
        <label>Organization/person contacted (staff log)<input className="input" maxLength={200} value={target} onChange={(e) => setTarget(e.target.value)} /></label>
        {report.canSetReference && <label>New service-provider reference<input className="input" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Enter the full number; access is restricted" /></label>}
        <label>Next follow-up date<input className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        <small>Logging contact records your action; it does not place a call. Do not include sensitive reference numbers in the shared update.</small>
      </div>}
      {error && <p role="alert" style={{ color: '#b91c1c' }}>{error} <button type="button" onClick={() => api.residentReport(report.id).then(onUpdated).catch(() => setError('Could not reload report'))}>Reload report</button></p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {report.canManage && report.status === 'submitted' && button('Acknowledge', 'acknowledge')}
        {report.canManage && ['acknowledged','in_progress'].includes(report.status) && <>
          {button('Log contact', 'contact')}{button('Follow up', 'follow_up')}{button('Resolve', 'resolve')}
        </>}
        {report.canManage && button('Save update / reference', undefined)}
        {report.canManage && report.status !== 'closed' && button('Administrative close (reason required)', 'close')}
        {report.isOwner && button('Request follow-up', 'request_follow_up')}
        {report.isOwner && report.status === 'resolved' && button('Confirm completed', 'confirm')}
      </div>
    </>}
  </section>;
}
