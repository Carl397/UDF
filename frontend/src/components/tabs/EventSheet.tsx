'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useShell } from '../AppShell';
import { Icon, Sheet, useToast } from '../ui';
import { REGIONS } from './FilterBar';
import type { EventKind, EventStatus, PartyEvent } from '../../types';

const KINDS: EventKind[] = [
  'rally',
  'meeting',
  'training',
  'canvass',
  'debate',
  'fundraiser',
  'service',
  'webinar',
];
const EVENT_STATUSES: EventStatus[] = ['scheduled', 'live', 'done', 'cancelled'];

/** `<input type="datetime-local">` wants local, un-zoned `YYYY-MM-DDTHH:mm`. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Form {
  title: string;
  kind: EventKind;
  summary: string;
  body: string;
  venue: string;
  regionCode: string;
  ward: string;
  startsAt: string;
  endsAt: string;
  capacity: string;
  status: EventStatus;
}

function defaultForm(event?: PartyEvent | null): Form {
  const soon = new Date(Date.now() + 7 * 86_400_000);
  soon.setHours(10, 0, 0, 0);
  return {
    title: event?.title ?? '',
    kind: event?.kind ?? 'rally',
    summary: event?.summary ?? '',
    body: event?.body ?? '',
    venue: event?.venue ?? '',
    regionCode: event?.regionCode ?? '',
    ward: event?.ward ?? '',
    startsAt: toLocalInput(event?.startsAt) || toLocalInput(soon.toISOString()),
    endsAt: toLocalInput(event?.endsAt),
    capacity: event?.capacity ? String(event.capacity) : '',
    status: event?.status ?? 'scheduled',
  };
}

export default function EventSheet({
  event,
  onClose,
  onSaved,
}: {
  event?: PartyEvent | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { caps, refreshUnread } = useShell();
  const { authenticated } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState<Form>(() => defaultForm(event));
  const [editing, setEditing] = useState(!event);
  const [busy, setBusy] = useState(false);
  const [rsvpCount, setRsvpCount] = useState(event?.rsvpCount ?? 0);
  const [going, setGoing] = useState(event?.going ?? false);
  const [coverFailed, setCoverFailed] = useState(false);

  // RSVP is now named, so "going" is only known per signed-in member. A sheet
  // opened from the public calendar carries `going: false`; re-read the single
  // event (which the server annotates for the caller) once we know they're in.
  useEffect(() => {
    if (!event?.id || !authenticated) return;
    const controller = new AbortController();
    api
      .getEvent(event.id)
      .then((fresh) => {
        setGoing(fresh.going);
        setRsvpCount(fresh.rsvpCount);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [event?.id, authenticated]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    if (!form.title.trim()) return toast('Title is required', 'err');
    if (!form.startsAt) return toast('Start date & time is required', 'err');
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        title: form.title.trim(),
        kind: form.kind,
        status: form.status,
        startsAt: new Date(form.startsAt).toISOString(),
      };
      if (form.summary.trim()) payload.summary = form.summary.trim();
      if (form.body.trim()) payload.body = form.body.trim();
      if (form.venue.trim()) payload.venue = form.venue.trim();
      if (form.regionCode) payload.regionCode = form.regionCode;
      if (form.ward.trim()) payload.ward = form.ward.trim();
      if (form.endsAt) payload.endsAt = new Date(form.endsAt).toISOString();
      if (form.capacity.trim()) payload.capacity = Number(form.capacity);

      if (event) await api.updateEvent(event.id, payload);
      else await api.createEvent(payload);

      toast(event ? 'Event updated' : 'Event published — members notified', 'ok');
      refreshUnread();
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? 'Could not save event', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function rsvp() {
    if (!event) return;
    if (!authenticated) {
      toast('Please sign in to RSVP', 'err');
      return;
    }
    setBusy(true);
    try {
      const updated = await api.rsvpEvent(event.id);
      setRsvpCount(updated.rsvpCount);
      setGoing(true);
      toast('You are on the list', 'ok');
    } catch (e: any) {
      toast(e?.message ?? 'RSVP failed', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function cancelRsvp() {
    if (!event) return;
    setBusy(true);
    try {
      const updated = await api.cancelRsvp(event.id);
      setRsvpCount(updated.rsvpCount);
      setGoing(false);
      toast('Removed from the list', 'ok');
    } catch (e: any) {
      toast(e?.message ?? 'Could not update RSVP', 'err');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!event) return;
    setBusy(true);
    try {
      await api.deleteEvent(event.id);
      toast('Event removed', 'ok');
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? 'Could not remove event', 'err');
    } finally {
      setBusy(false);
    }
  }

  const when = event ? new Date(event.startsAt) : form.startsAt ? new Date(form.startsAt) : null;

  return (
    <Sheet
      title={editing ? (event ? 'Edit event' : 'New event') : (event?.title ?? 'Event')}
      subtitle={
        editing
          ? 'Rallies, meetings, training and service actions'
          : when
            ? `${when.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}`
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
              <Icon name="check" size={16} /> {busy ? 'Saving…' : event ? 'Save changes' : 'Publish event'}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              className={`btn ${going ? 'btn-ghost' : 'btn-primary'}`}
              style={{ flex: 2 }}
              onClick={going ? cancelRsvp : rsvp}
              disabled={busy}
            >
              <Icon name={going ? 'checkCircle' : 'calendar'} size={16} />
              {going ? `Going · tap to cancel${rsvpCount ? ` (${rsvpCount})` : ''}` : `I'm going${rsvpCount ? ` · ${rsvpCount}` : ''}`}
            </button>
            {caps.eventWrite && (
              <button className="btn btn-ghost" onClick={() => setEditing(true)} aria-label="Edit event">
                <Icon name="edit" size={16} /> Edit
              </button>
            )}
            {caps.eventWrite &&
              (confirmDelete ? (
                <button className="btn btn-danger" onClick={remove} disabled={busy}>
                  Confirm
                </button>
              ) : (
                <button
                  className="btn btn-ghost"
                  onClick={() => setConfirmDelete(true)}
                  aria-label="Delete event"
                >
                  <Icon name="trash" size={16} />
                </button>
              ))}
          </div>
        )
      }
    >
      {editing ? (
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ev-title">Title</label>
            <input
              id="ev-title"
              className="input"
              value={form.title}
              maxLength={160}
              placeholder="Ward 12 branch meeting"
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="ev-kind">Type</label>
              <select
                id="ev-kind"
                className="input"
                value={form.kind}
                onChange={(e) => set({ kind: e.target.value as EventKind })}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ev-status">Status</label>
              <select
                id="ev-status"
                className="input"
                value={form.status}
                onChange={(e) => set({ status: e.target.value as EventStatus })}
              >
                {EVENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="ev-start">Starts</label>
              <input
                id="ev-start"
                className="input"
                type="datetime-local"
                value={form.startsAt}
                onChange={(e) => set({ startsAt: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="ev-end">Ends</label>
              <input
                id="ev-end"
                className="input"
                type="datetime-local"
                value={form.endsAt}
                onChange={(e) => set({ endsAt: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="ev-venue">Venue</label>
            <input
              id="ev-venue"
              className="input"
              value={form.venue}
              maxLength={200}
              placeholder="Community Hall / Online"
              onChange={(e) => set({ venue: e.target.value })}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="ev-region">Region</label>
              <select
                id="ev-region"
                className="input"
                value={form.regionCode}
                onChange={(e) => set({ regionCode: e.target.value })}
              >
                <option value="">National</option>
                {REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ev-ward">Ward</label>
              <input
                id="ev-ward"
                className="input"
                value={form.ward}
                maxLength={64}
                placeholder="12"
                onChange={(e) => set({ ward: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="ev-cap">Capacity</label>
            <input
              id="ev-cap"
              className="input"
              type="number"
              min={0}
              value={form.capacity}
              placeholder="Unlimited"
              onChange={(e) => set({ capacity: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="ev-summary">Summary</label>
            <input
              id="ev-summary"
              className="input"
              value={form.summary}
              maxLength={500}
              placeholder="One line shown in the calendar and alerts"
              onChange={(e) => set({ summary: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="ev-body">Agenda / details</label>
            <textarea
              id="ev-body"
              className="input"
              rows={5}
              value={form.body}
              maxLength={8000}
              placeholder="Agenda, what to bring, contact person…"
              onChange={(e) => set({ body: e.target.value })}
            />
          </div>
        </div>
      ) : (
        event && (
          <>
            {event.hasCover && !coverFailed && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={api.eventCoverUrl(event.id)}
                alt=""
                onError={() => setCoverFailed(true)}
                style={{
                  width: '100%',
                  aspectRatio: '16 / 9',
                  objectFit: 'cover',
                  borderRadius: 12,
                  marginBottom: 12,
                  background: '#f1f5f9',
                }}
              />
            )}
            <div className="chip-row" style={{ marginBottom: 12 }}>
              <span className="badge">{event.kind}</span>
              <span className={`badge ${event.status === 'cancelled' ? 'danger' : event.status === 'live' ? 'ok' : ''}`}>
                {event.status}
              </span>
              {event.regionCode && <span className="badge tier">{event.regionCode}</span>}
              {event.ward && <span className="badge">Ward {event.ward}</span>}
            </div>

            <div className="rows" style={{ marginBottom: 14 }}>
              <div className="row">
                <span className="row-ico"><Icon name="calendar" /></span>
                <span className="row-main">
                  <span className="row-title">
                    {new Date(event.startsAt).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                  <span className="row-sub">
                    {event.endsAt
                      ? `Until ${new Date(event.endsAt).toLocaleTimeString(undefined, { timeStyle: 'short' })}`
                      : 'End time not set'}
                  </span>
                </span>
              </div>
              <div className="row">
                <span className="row-ico"><Icon name="pin" /></span>
                <span className="row-main">
                  <span className="row-title">{event.venue ?? 'Venue to be confirmed'}</span>
                  <span className="row-sub">
                    {[event.regionCode, event.ward ? `Ward ${event.ward}` : null]
                      .filter(Boolean)
                      .join(' · ') || 'National'}
                  </span>
                </span>
              </div>
              <div className="row">
                <span className="row-ico"><Icon name="users" /></span>
                <span className="row-main">
                  <span className="row-title">{rsvpCount} going</span>
                  <span className="row-sub">
                    {event.capacity ? `Capacity ${event.capacity}` : 'No capacity limit'}
                  </span>
                </span>
              </div>
            </div>

            {event.summary && (
              <p className="sheet-text strong" style={{ marginTop: 0 }}>
                {event.summary}
              </p>
            )}
            {event.body && <p className="sheet-text">{event.body}</p>}
          </>
        )
      )}
    </Sheet>
  );
}
