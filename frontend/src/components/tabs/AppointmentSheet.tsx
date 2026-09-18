'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useShell } from '../AppShell';
import { Icon, Sheet, memberLabel, memberRefLabel, useToast } from '../ui';
import { REGIONS } from './FilterBar';
import type { Appointment, Member, Position } from '../../types';

const LEVEL_LABEL: Record<string, string> = {
  national: 'National',
  region: 'Regional',
  district: 'District',
  ward: 'Ward',
  branch: 'Branch',
};

interface Form {
  memberId: string;
  positionCode: string;
  title: string;
  regionCode: string;
  ward: string;
  appointedBy: string;
  termStart: string;
  termEnd: string;
  notes: string;
  status: 'proposed' | 'confirmed';
}

const emptyForm = (): Form => ({
  memberId: '',
  positionCode: '',
  title: '',
  regionCode: '',
  ward: '',
  appointedBy: 'Party Executive',
  termStart: new Date().toISOString().slice(0, 10),
  termEnd: '',
  notes: '',
  status: 'proposed',
});

export default function AppointmentSheet({
  appointment,
  onClose,
  onSaved,
}: {
  appointment?: Appointment | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { caps, filters, refreshUnread } = useShell();
  const toast = useToast();
  const [positions, setPositions] = useState<Position[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [form, setForm] = useState<Form>(emptyForm);
  const [editing, setEditing] = useState(!appointment);
  const [busy, setBusy] = useState(false);
  const [mandateUrl, setMandateUrl] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isNew = !appointment;

  useEffect(() => {
    api.listPositions().then((r) => {
      setPositions(r.items);
      if (!appointment && r.items[0]) setForm((f) => ({ ...f, positionCode: r.items[0]!.code }));
    }).catch(() => setPositions([]));
  }, [appointment]);

  // The member picker only needs to load when creating an appointment.
  useEffect(() => {
    if (!isNew) return;
    api
      .listMembers({ limit: 200, regionCode: filters.regionCode || undefined })
      .then((r) => setMembers(r.items))
      .catch(() => setMembers([]));
  }, [isNew, filters.regionCode]);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const positionName =
    positions.find((p) => p.code === (appointment?.positionCode ?? form.positionCode))?.name ??
    appointment?.positionName ??
    form.positionCode;

  async function save() {
    if (!form.memberId) return toast('Choose the member being appointed', 'err');
    if (!form.positionCode) return toast('Choose a party position', 'err');
    setBusy(true);
    try {
      if (appointment) {
        const payload: Record<string, unknown> = { status: form.status };
        if (form.positionCode) payload.positionCode = form.positionCode;
        if (form.ward.trim()) payload.ward = form.ward.trim();
        if (form.regionCode) payload.regionCode = form.regionCode;
        if (form.appointedBy.trim()) payload.appointedBy = form.appointedBy.trim();
        if (form.title.trim()) payload.title = form.title.trim();
        if (form.termStart) payload.termStart = form.termStart;
        if (form.termEnd) payload.termEnd = form.termEnd;
        if (form.notes.trim()) payload.notes = form.notes.trim();
        await api.updateAppointment(appointment.id, payload);
        toast('Appointment updated', 'ok');
      } else {
        const payload: Record<string, unknown> = {
          memberId: form.memberId,
          positionCode: form.positionCode,
          status: form.status,
          appointedBy: form.appointedBy.trim() || undefined,
          termStart: form.termStart || undefined,
          termEnd: form.termEnd || undefined,
          notes: form.notes.trim() || undefined,
          title: form.title.trim() || undefined,
          ward: form.ward.trim() || undefined,
          regionCode: form.regionCode || undefined,
        };
        const created = await api.createAppointment(payload);
        setMandateUrl(created.mandateUrl);
        toast('Appointment created — mandate link ready', 'ok');
      }
      refreshUnread();
      onSaved();
      if (appointment) onClose();
    } catch (e: any) {
      toast(e?.message ?? 'Could not save appointment', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(status: 'confirmed' | 'revoked') {
    if (!appointment) return;
    setBusy(true);
    try {
      await api.updateAppointment(appointment.id, { status });
      toast(status === 'confirmed' ? 'Appointment confirmed' : 'Mandate revoked', 'ok');
      refreshUnread();
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? 'Could not update', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function issueLink() {
    if (!appointment) return;
    setBusy(true);
    try {
      const r = await api.issueMandateLink(appointment.id);
      setMandateUrl(r.mandateUrl);
      toast('New mandate link issued', 'ok');
    } catch (e: any) {
      toast(e?.message ?? 'Could not issue link', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!appointment) return;
    setBusy(true);
    try {
      await api.deleteAppointment(appointment.id);
      toast('Appointment deleted', 'ok');
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? 'Could not delete', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast('Mandate link copied — send it to the appointee', 'ok');
    } catch {
      toast('Copy blocked by the browser', 'err');
    }
  }

  return (
    <Sheet
      title={editing ? (appointment ? 'Edit appointment' : 'New appointment') : (appointment?.positionName ?? 'Appointment')}
      subtitle={
        editing
          ? 'Bind a member to a party office and issue their mandate'
          : appointment
            ? `${memberRefLabel(appointment.member)}${appointment.ward ? ` · Ward ${appointment.ward}` : ''}`
            : undefined
      }
      onClose={onClose}
      footer={
        editing ? (
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" style={{ flex: 2 }} onClick={save} disabled={busy}>
              <Icon name="check" size={16} /> {busy ? 'Saving…' : appointment ? 'Save changes' : 'Appoint & issue mandate'}
            </button>
          </div>
        ) : mandateUrl ? (
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-gold" style={{ flex: 2 }} onClick={() => copyLink(mandateUrl)}>
              <Icon name="link" size={16} /> Copy mandate link
            </button>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" style={{ flex: 2 }} onClick={issueLink} disabled={busy}>
              <Icon name="link" size={16} /> Mandate link
            </button>
            {caps.appoint && appointment?.status !== 'confirmed' && (
              <button className="btn btn-ghost" onClick={() => changeStatus('confirmed')} disabled={busy}>
                Confirm
              </button>
            )}
            {caps.appoint && appointment?.status === 'confirmed' && (
              <button className="btn btn-ghost" onClick={() => changeStatus('revoked')} disabled={busy}>
                Revoke
              </button>
            )}
            {caps.appoint &&
              (confirmDelete ? (
                <button className="btn btn-danger" onClick={remove} disabled={busy}>
                  Confirm
                </button>
              ) : (
                <button className="btn btn-ghost" onClick={() => setConfirmDelete(true)} aria-label="Delete appointment">
                  <Icon name="trash" size={16} />
                </button>
              ))}
          </div>
        )
      }
    >
      {mandateUrl && isNew && (
        <div className="link-box">
          <div className="link-title">
            <Icon name="link" size={15} /> Mandate confirmation link
          </div>
          <code>{mandateUrl}</code>
          <p>
            Send this to the appointee. Opening it accepts the mandate, confirms the appointment and
            writes an entry to the tamper-evident audit log.
          </p>
        </div>
      )}

      {editing ? (
        <div className="form-grid">
          {isNew && (
            <div className="field">
              <label htmlFor="ap-member">Member</label>
              <select
                id="ap-member"
                className="input"
                value={form.memberId}
                onChange={(e) => {
                  const m = members.find((x) => x.id === e.target.value);
                  set({ memberId: e.target.value, regionCode: m?.regionCode ?? form.regionCode });
                }}
              >
                <option value="">Select a member…</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {memberLabel(m)} · {m.tier} · {m.regionCode ?? '—'}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="field">
            <label htmlFor="ap-position">Party position</label>
            <select
              id="ap-position"
              className="input"
              value={form.positionCode || appointment?.positionCode || ''}
              onChange={(e) => set({ positionCode: e.target.value })}
              disabled={!isNew && !caps.appoint}
            >
              <option value="">Select a position…</option>
              {positions.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name} ({LEVEL_LABEL[p.level] ?? p.level})
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="ap-title">Displayed as (optional)</label>
            <input
              id="ap-title"
              className="input"
              value={form.title}
              maxLength={160}
              placeholder="Ward Candidate — Ward 12"
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="ap-region">Region</label>
              <select
                id="ap-region"
                className="input"
                value={form.regionCode || appointment?.regionCode || ''}
                onChange={(e) => set({ regionCode: e.target.value })}
              >
                <option value="">—</option>
                {REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ap-ward">Ward</label>
              <input
                id="ap-ward"
                className="input"
                value={form.ward || appointment?.ward || ''}
                maxLength={64}
                placeholder="12"
                onChange={(e) => set({ ward: e.target.value })}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="ap-by">Appointed by</label>
            <input
              id="ap-by"
              className="input"
              value={form.appointedBy}
              maxLength={160}
              onChange={(e) => set({ appointedBy: e.target.value })}
            />
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="ap-start">Term start</label>
              <input
                id="ap-start"
                className="input"
                type="date"
                value={form.termStart}
                onChange={(e) => set({ termStart: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="ap-end">Term end</label>
              <input
                id="ap-end"
                className="input"
                type="date"
                value={form.termEnd}
                onChange={(e) => set({ termEnd: e.target.value })}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="ap-status">Status</label>
            <div className="chip-row">
              {(['proposed', 'confirmed'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`chip ${form.status === s ? 'on' : ''}`}
                  onClick={() => set({ status: s })}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="ap-notes">Notes</label>
            <textarea
              id="ap-notes"
              className="input"
              rows={3}
              value={form.notes}
              maxLength={2000}
              placeholder="Service commitments attached to this mandate…"
              onChange={(e) => set({ notes: e.target.value })}
            />
          </div>
        </div>
      ) : (
        appointment && (
          <>
            <div className="chip-row" style={{ marginBottom: 12 }}>
              <span className="badge tier">{positionName}</span>
              <span
                className={`badge ${
                  appointment.status === 'confirmed'
                    ? 'ok'
                    : appointment.status === 'revoked'
                      ? 'danger'
                      : 'warn'
                }`}
              >
                {appointment.status}
              </span>
              {appointment.mandateAcceptedAt && <span className="badge">mandate accepted</span>}
            </div>

            <div className="rows">
              <div className="row">
                <span className="row-ico"><Icon name="users" /></span>
                <span className="row-main">
                  <span className="row-title">
                    {memberRefLabel(appointment.member, appointment.memberId)}
                  </span>
                  <span className="row-sub">
                    {appointment.member.tier ?? 'member'}
                    {/* D53: when there is no membership number the card code is
                        already the title above, so repeating it here would read
                        "UDF-WCV-77E · voter · card UDF-WCV-77E". */}
                    {appointment.member.membershipNo && appointment.member.publicCode
                      ? ` · card ${appointment.member.publicCode}`
                      : ''}
                  </span>
                </span>
              </div>
              <div className="row">
                <span className="row-ico"><Icon name="pin" /></span>
                <span className="row-main">
                  <span className="row-title">
                    {appointment.ward ? `Ward ${appointment.ward}` : appointment.regionCode ?? 'National'}
                  </span>
                  <span className="row-sub">
                    {LEVEL_LABEL[appointment.positionLevel ?? ''] ?? appointment.positionLevel ?? '—'} level
                  </span>
                </span>
              </div>
              <div className="row">
                <span className="row-ico"><Icon name="calendar" /></span>
                <span className="row-main">
                  <span className="row-title">
                    {appointment.termStart ?? '—'} → {appointment.termEnd ?? 'open ended'}
                  </span>
                  <span className="row-sub">Appointed by {appointment.appointedBy ?? '—'}</span>
                </span>
              </div>
              <div className="row">
                <span className="row-ico"><Icon name="shield" /></span>
                <span className="row-main">
                  <span className="row-title">Mandate</span>
                  <span className="row-sub">
                    {appointment.mandateAcceptedAt
                      ? `Accepted ${new Date(appointment.mandateAcceptedAt).toLocaleDateString()}`
                      : 'Awaiting acceptance by the appointee'}
                  </span>
                </span>
                <span className={`dot ${appointment.mandateAcceptedAt ? 'ok' : 'warn'}`} />
              </div>
            </div>

            {appointment.notes && <p className="sheet-text">{appointment.notes}</p>}

            {caps.appoint && (
              <button
                className="btn btn-ghost btn-block btn-sm"
                style={{ marginTop: 12 }}
                onClick={() => {
                  setForm({
                    memberId: appointment.memberId,
                    positionCode: appointment.positionCode ?? '',
                    title: appointment.title ?? '',
                    regionCode: appointment.regionCode ?? '',
                    ward: appointment.ward ?? '',
                    appointedBy: appointment.appointedBy ?? '',
                    termStart: appointment.termStart?.slice(0, 10) ?? '',
                    termEnd: appointment.termEnd?.slice(0, 10) ?? '',
                    notes: appointment.notes ?? '',
                    status: appointment.status === 'revoked' ? 'proposed' : appointment.status,
                  });
                  setEditing(true);
                }}
              >
                <Icon name="edit" size={16} /> Edit appointment
              </button>
            )}
          </>
        )
      )}
    </Sheet>
  );
}
