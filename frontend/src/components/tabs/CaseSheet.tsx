'use client';

import { useState } from 'react';
import { api } from '../../lib/api';
import { useShell } from '../AppShell';
import { Icon, Sheet, useToast } from '../ui';
import MediaCapture, { useMediaDrafts } from '../supporter/MediaCapture';
import {
  srStatusBadgeClass,
  srStatusLabel,
  followUpBadgeClass,
  followUpLabel,
  type FollowUpState,
} from '../../lib/caseStatus';
import type { ServiceRequest } from '../../types';

/**
 * Log a case / case detail.
 *
 * Dual-mode, mirroring `EventSheet`: with no `sr` it is the **create** form a
 * councillor or coordinator opens from "Log a case" in Engage › Cases — category,
 * severity, title, description, the house / stand number, an optional GPS fix and
 * on-device photo / video / voice-note attachments (the shared `MediaCapture`),
 * submitted through `api.createServiceRequest`. With an `sr` it is the **detail**
 * view: the colour-coded status badge plus the independent follow-up chip, and a
 * follow-up control (Set awaiting / Mark done / Engage, with an optional note)
 * gated on `caps.caseUpdate` that writes the sub-state + a timeline row.
 *
 * The two signals are kept visually separate on purpose — the status colour and
 * the follow-up chip come from `lib/caseStatus` and never share a hue.
 */

const CATEGORIES = ['water', 'power', 'roads', 'sanitation', 'housing', 'safety', 'health', 'education', 'other'] as const;
const SEVERITIES = ['info', 'report', 'urgent'] as const;

/** The follow-up transitions offered in the detail view (plan §3.3). */
const FOLLOW_UP_ACTIONS: { state: FollowUpState; label: string }[] = [
  { state: 'awaiting', label: 'Set awaiting' },
  { state: 'done', label: 'Mark done' },
  { state: 'engaged', label: 'Engage' },
];

export default function CaseSheet({
  sr,
  onClose,
  onSaved,
}: {
  /** A case to view / follow up; null or omitted opens the create form. */
  sr?: ServiceRequest | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { caps } = useShell();
  const toast = useToast();
  const capture = useMediaDrafts(10);

  // Create-mode form state.
  const [category, setCategory] = useState<string>(CATEGORIES[0]!);
  const [severity, setSeverity] = useState<string>('report');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [streetNumber, setStreetNumber] = useState('');
  const [streetAddress, setStreetAddress] = useState('');
  const [busy, setBusy] = useState(false);

  // Detail-mode state: a local copy so a follow-up change repaints immediately.
  const [current, setCurrent] = useState<ServiceRequest | null>(sr ?? null);
  const [note, setNote] = useState('');

  const creating = !sr;

  async function submitCreate() {
    if (!title.trim()) {
      toast('A short title is required', 'err');
      return;
    }
    setBusy(true);
    try {
      const pos = capture.pos;
      const created = await api.createServiceRequest({
        title: title.trim(),
        category,
        severity,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(streetNumber.trim() ? { streetNumber: streetNumber.trim() } : {}),
        ...(streetAddress.trim() ? { streetAddress: streetAddress.trim() } : {}),
        ...(pos ? { lat: pos.lat, lng: pos.lng } : {}),
        media: capture.payload(),
      });
      toast(`Case ${created.refNo} logged`, 'ok');
      capture.clear();
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? 'Could not log the case', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function setFollowUp(state: FollowUpState) {
    if (!current) return;
    setBusy(true);
    try {
      const updated = await api.updateServiceRequest(current.id, {
        followUpState: state,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setCurrent(updated);
      setNote('');
      toast('Follow-up updated', 'ok');
      onSaved();
    } catch (e: any) {
      toast(e?.message ?? 'Could not update the follow-up', 'err');
    } finally {
      setBusy(false);
    }
  }

  const followCls = current ? followUpBadgeClass(current.followUpState) : null;

  return (
    <Sheet
      title={creating ? 'Log a case' : (current?.title ?? 'Case')}
      subtitle={
        creating
          ? 'Service delivery, safety or infrastructure — with photos, video or a voice note'
          : current
            ? `${current.refNo}${current.wardCode ? ` · Ward ${current.wardCode}` : ''}`
            : undefined
      }
      onClose={onClose}
      footer={
        creating ? (
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" style={{ flex: 2 }} onClick={submitCreate} disabled={busy}>
              <Icon name="send" size={16} /> {busy ? 'Logging…' : 'Log case'}
            </button>
          </div>
        ) : undefined
      }
    >
      {creating ? (
        <div className="form-grid">
          <div className="field">
            <div className="mini-label">Category</div>
            <div className="chip-row" style={{ marginTop: 6 }}>
              {CATEGORIES.map((c) => (
                <button key={c} className={`chip ${category === c ? 'on' : ''}`} onClick={() => setCategory(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <div className="mini-label">Severity</div>
            <div className="chip-row" style={{ marginTop: 6 }}>
              {SEVERITIES.map((s) => (
                <button key={s} className={`chip ${severity === s ? 'on' : ''}`} onClick={() => setSeverity(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="case-title">Title *</label>
            <input
              id="case-title"
              className="input"
              value={title}
              maxLength={200}
              placeholder="e.g. Burst water main on Spine Road"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="case-desc">Description</label>
            <textarea
              id="case-desc"
              className="input"
              rows={4}
              maxLength={5000}
              value={description}
              placeholder="What is happening, how long, who is affected…"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="case-street-number">Street / stand no.</label>
              <input
                id="case-street-number"
                className="input"
                value={streetNumber}
                maxLength={32}
                placeholder="48"
                onChange={(e) => setStreetNumber(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="case-street-address">Street address</label>
              <input
                id="case-street-address"
                className="input"
                value={streetAddress}
                maxLength={500}
                placeholder="Spine Road, Town Centre"
                onChange={(e) => setStreetAddress(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <div className="mini-label">Attach location, photos, video or a voice note</div>
            <MediaCapture api={capture} />
          </div>
        </div>
      ) : (
        current && (
          <>
            <div className="chip-row" style={{ marginBottom: 12 }}>
              <span className={srStatusBadgeClass(current.status)}>{srStatusLabel(current.status)}</span>
              {followCls && <span className={followCls}>{followUpLabel(current.followUpState)}</span>}
              <span className="badge">{current.category}</span>
              <span className="badge">{current.severity}</span>
            </div>

            {current.description && (
              <p className="sheet-text" style={{ whiteSpace: 'pre-wrap' }}>
                {current.description}
              </p>
            )}

            <div className="rows" style={{ margin: '12px 0' }}>
              {(current.streetNumber || current.streetAddress) && (
                <div className="row">
                  <span className="row-ico"><Icon name="pin" /></span>
                  <span className="row-main">
                    <span className="row-title">
                      {[current.streetNumber, current.streetAddress].filter(Boolean).join(' · ') || '—'}
                    </span>
                    <span className="row-sub">Street / stand</span>
                  </span>
                </div>
              )}
              <div className="row">
                <span className="row-ico"><Icon name="calendar" /></span>
                <span className="row-main">
                  <span className="row-title">
                    {current.slaDueAt ? new Date(current.slaDueAt).toLocaleString() : 'No SLA set'}
                  </span>
                  <span className="row-sub">SLA due · logged {new Date(current.createdAt).toLocaleDateString()}</span>
                </span>
              </div>
            </div>

            {caps.caseUpdate ? (
              <div className="card" style={{ marginTop: 4 }}>
                <div className="mini-label">Follow-up</div>
                <div className="chip-row" style={{ marginTop: 6 }}>
                  {FOLLOW_UP_ACTIONS.map((a) => (
                    <button
                      key={a.state}
                      className={`chip ${current.followUpState === a.state ? 'on' : ''}`}
                      onClick={() => setFollowUp(a.state)}
                      disabled={busy || current.followUpState === a.state}
                    >
                      {a.label}
                    </button>
                  ))}
                  {current.followUpState !== 'none' && (
                    <button
                      className="chip"
                      onClick={() => setFollowUp('none')}
                      disabled={busy}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="field" style={{ marginTop: 10 }}>
                  <label htmlFor="case-follow-note">Note (optional)</label>
                  <input
                    id="case-follow-note"
                    className="input"
                    value={note}
                    maxLength={2000}
                    placeholder="Called the resident back; meter reader booked for Thursday."
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
                <p className="hint-text" style={{ marginTop: 8 }}>
                  The follow-up state is separate from the lifecycle status — a case can be
                  in&nbsp;progress and still awaiting a callback. Each change writes a timeline row.
                </p>
              </div>
            ) : (
              <p className="hint-text" style={{ marginTop: 8 }}>
                Follow-up is tracked by ward staff. You can view this case&apos;s status but not
                change its follow-up.
              </p>
            )}
          </>
        )
      )}
    </Sheet>
  );
}
