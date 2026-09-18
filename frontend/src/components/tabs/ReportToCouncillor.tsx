'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { EmptyState, Icon, useToast } from '../ui';
import MediaCapture, { useMediaDrafts } from '../supporter/MediaCapture';
import type { ResidentReport } from '../../types';
import { useAuth } from '../../lib/auth';
import ReportWorkflowPanel, { REPORT_LABEL } from '../ReportWorkflowPanel';

/** Roles that receive a ward inbox of resident reports (mirrors the backend). */
const STAFF_ROLES = ['national_admin', 'regional_organizer', 'local_coordinator', 'ward_councillor'];

/**
 * Resident → ward councillor report channel.
 *
 * A resident in a ward can send information to their councillor: a category,
 * a message, an optional GPS fix (used to resolve the ward), and optional
 * photo / video / voice-note attachments captured on-device. Submissions are
 * private to the author and the ward's staff, and the ward councillor receives
 * an in-app notification.
 */

const CATEGORIES = [
  'Service delivery',
  'Safety & crime',
  'Water & sanitation',
  'Electricity',
  'Roads & paving',
  'Corruption',
  'Suggestion',
  'Other',
];

export default function ReportToCouncillor() {
  const toast = useToast();
  const { role } = useAuth();
  const isStaff = STAFF_ROLES.includes(role ?? '');
  const [category, setCategory] = useState(CATEGORIES[0]!);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const request = useRef<{ payload: string; id: string } | null>(null);
  const opening = useRef(0);
  useEffect(() => () => { opening.current++; }, []);
  const [mine, setMine] = useState<ResidentReport[] | null>(null);
  const [inbox, setInbox] = useState<ResidentReport[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openReport, setOpenReport] = useState<ResidentReport | null>(null);
  const capture = useMediaDrafts();
  const [loadError, setLoadError] = useState('');
  const applyUpdate = (r: ResidentReport) => {
    setOpenReport(r);
    setMine((rows) => rows?.map((item) => item.id === r.id ? r : item) ?? null);
    setInbox((rows) => rows?.map((item) => item.id === r.id ? r : item) ?? null);
  };

  const loadMine = useCallback(() => {
    api
      .allResidentReports('mine')
      .then((r) => setMine(r.items))
      .catch(() => setLoadError('Could not load your reports. Please retry.'));
  }, []);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  const loadInbox = useCallback(() => {
    if (!isStaff) return;
    api
      .allResidentReports('inbox')
      .then((r) => setInbox(r.items))
      .catch(() => setLoadError('Could not load the ward inbox. Please retry.'));
  }, [isStaff]);

  useEffect(() => {
    loadInbox();
  }, [loadInbox]);

  async function toggleOpen(id: string) {
    const generation = ++opening.current;
    if (openId === id) {
      setOpenId(null);
      setOpenReport(null);
      return;
    }
    setOpenId(id);
    setOpenReport(null);
    try {
      const report = await api.residentReport(id);
      if (generation === opening.current) setOpenReport(report);
    } catch {
      if (generation !== opening.current) return;
      setOpenId(null);
      toast('Could not open that report. Please retry.', 'err');
    }
  }

  async function submit() {
    if (saving.current) return;
    if (message.trim().length < 5) {
      toast('Please describe the issue (at least 5 characters)', 'err');
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      const pos = capture.pos;
      const payload = {
        category,
        message: message.trim(),
        ...(pos ? { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM } : {}),
        media: capture.payload(),
      };
      const serialized = JSON.stringify(payload);
      if (request.current?.payload !== serialized) {
        request.current = { payload: serialized, id: crypto.randomUUID() };
      }
      const res = await api.submitResidentReport({ ...payload, requestId: request.current.id });
      request.current = null;
      toast(
        res.routed
          ? `Report ${res.refNo} sent to your ward councillor`
          : `Report ${res.refNo} captured — no councillor linked to this ward yet`,
        'ok',
      );
      setMessage('');
      capture.clear();
      loadMine();
    } catch (e: any) {
      toast(e?.message ?? 'Could not send the report', 'err');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-label" style={{ marginTop: 12 }}>
        Report to my ward councillor
      </div>

      <div className="card">
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="mini-label">What is it about</div>
        <div className="chip-row" style={{ marginTop: 6 }}>
          {CATEGORIES.map((c) => (
            <button key={c} className={`chip ${category === c ? 'on' : ''}`} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="rr-msg">Describe the issue *</label>
          <textarea
            id="rr-msg"
            className="input"
            rows={4}
            maxLength={4000}
            value={message}
            placeholder="e.g. The street lights on the corner of Main and 3rd have been out for two weeks."
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>

        <MediaCapture api={capture} />

        <button className="btn btn-primary btn-block" style={{ marginTop: 14 }} onClick={submit} disabled={busy}>
          <Icon name="send" size={17} /> {busy ? 'Sending…' : 'Send to my councillor'}
        </button>

        <p className="hint-text" style={{ marginTop: 10 }}>
          Private to you and your ward&apos;s staff. Attachments are stored with a tamper-evident hash;
          your location is used only to route the report to the right ward and is never shown publicly.
        </p>
        </fieldset>
      </div>

      {loadError && <p role="alert">{loadError} <button onClick={() => { setLoadError(''); loadMine(); loadInbox(); }}>Retry</button></p>}
      <div className="section-label" style={{ marginTop: 16 }}>
        My reports
      </div>
      {mine === null ? (
        <div className="skeleton" style={{ height: 76 }} />
      ) : mine.length === 0 ? (
        <div className="card">
          <EmptyState icon="send" title="No reports yet" hint="Send information to your ward councillor — it lands in their inbox." />
        </div>
      ) : (
        <div className="rows">
          {mine.map((r) => (
            <div key={r.id} className="card" style={{ marginBottom: 8 }}>
              <div className="row" style={{ cursor: 'default' }}>
                <span className="row-ico">
                  <Icon name="alert" />
                </span>
                <span className="row-main">
                  <span className="row-title">{r.category}</span>
                  <span className="row-sub">
                    {r.refNo}
                    {r.wardCode ? ` · ${r.wardCode}` : ''}
                    {r.media.length ? ` · ${r.media.length} attachment${r.media.length > 1 ? 's' : ''}` : ''}
                  </span>
                  <span className="row-sub tiny">{new Date(r.createdAt).toLocaleString()}</span>
                </span>
                <span className={`badge ${r.status === 'resolved' || r.status === 'closed' ? 'ok' : r.status === 'submitted' ? 'warn' : ''}`}>
                  {REPORT_LABEL[r.status] ?? r.status}
                </span>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleOpen(r.id)}>View / follow up</button>
              {openId === r.id && openReport?.id === r.id && <ReportWorkflowPanel key={r.id} report={openReport} onUpdated={applyUpdate} />}
              {r.feedback && (
                <div style={{ padding: '2px 2px 0' }}>
                  <p className="hint-text" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>
                    <strong>Councillor’s reply:</strong> {r.feedback}
                    {r.respondedAt ? ` · ${new Date(r.respondedAt).toLocaleDateString()}` : ''}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {isStaff && (
        <>
          <div className="section-label" style={{ marginTop: 16 }}>
            Ward inbox · reports from residents
          </div>
          {inbox === null ? (
            <div className="skeleton" style={{ height: 76 }} />
          ) : inbox.length === 0 ? (
            <div className="card">
              <EmptyState icon="bell" title="No resident reports" hint="Reports residents send to this ward land here." />
            </div>
          ) : (
            <div className="rows">
              {inbox.map((r) => (
                <div key={r.id} className="card" style={{ marginBottom: 8 }}>
                  <button className="row" style={{ cursor: 'pointer', width: '100%' }} onClick={() => toggleOpen(r.id)}>
                    <span className="row-ico">
                      <Icon name="alert" />
                    </span>
                    <span className="row-main">
                      <span className="row-title">{r.category}</span>
                      <span className="row-sub">
                        {r.refNo}
                        {r.wardCode ? ` · ${r.wardCode}` : ''}
                        {r.media.length ? ` · ${r.media.length} attachment${r.media.length > 1 ? 's' : ''}` : ''}
                      </span>
                      <span className="row-sub tiny">{new Date(r.createdAt).toLocaleString()}</span>
                    </span>
                    <span className={`badge ${r.status === 'closed' ? 'ok' : r.status === 'acknowledged' ? '' : 'warn'}`}>
                      {REPORT_LABEL[r.status] ?? r.status}
                    </span>
                  </button>
                  {openId === r.id && (
                    <div style={{ padding: '2px 2px 0' }}>
                      {openReport && openReport.id === r.id ? (
                        <>
                          <p className="hint-text" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>
                            {openReport.message}
                          </p>
                          {openReport.lat != null && openReport.lng != null && (
                            <p className="hint-text">
                              <Icon name="pin" size={13} /> {openReport.lat.toFixed(5)}, {openReport.lng.toFixed(5)}
                              {openReport.accuracyM != null ? ` · ±${Math.round(openReport.accuracyM)}m` : ''}
                            </p>
                          )}
                          <ReportWorkflowPanel key={r.id} report={openReport} onUpdated={applyUpdate} />
                        </>
                      ) : (
                        <div className="skeleton" style={{ height: 40, marginTop: 6 }} />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
