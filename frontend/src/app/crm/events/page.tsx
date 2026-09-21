'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { AttachmentManager } from '../../../components/crm/AttachmentManager';
import { CoverEditor } from '../../../components/crm/CoverEditor';
import { EventAttendees } from '../../../components/crm/EventAttendees';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmFilters, CrmModal, CrmField,
  CrmButton, CrmSmallButton, downloadCsv, fmtDateTime,
} from '../../../components/crm/ui';

/**
 * CRM Events — party event management: rallies, meetings, training,
 * canvass, debates, fundraisers, service days and webinars with RSVP counts.
 */

const KINDS = ['rally', 'meeting', 'training', 'canvass', 'debate', 'fundraiser', 'service', 'webinar'];
const STATUSES = ['scheduled', 'live', 'done', 'cancelled'];

export default function CrmEvents() {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ kind: '', status: '' });
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', kind: 'meeting', startsAt: '', regionCode: '', venue: '' });
  const [attachFor, setAttachFor] = useState<{ id: string; title: string } | null>(null);
  const [coverFor, setCoverFor] = useState<{ id: string; title: string; hasCover: boolean } | null>(null);
  const [attendeesFor, setAttendeesFor] = useState<{ id: string; title: string } | null>(null);

  const load = () => {
    setLoading(true);
    // upcoming=false: the CRM must also see events that already started —
    // otherwise a rally vanishes from the table mid-event and can never be
    // marked done, cancelled or deleted. The public calendar keeps its own
    // upcoming-only default.
    const params: Record<string, string> = { limit: '200', upcoming: 'false' };
    if (filter.kind) params.kind = filter.kind;
    if (filter.status) params.status = filter.status;
    api
      .listEvents(params as any)
      .then((r: { items: any[] }) => setEvents(r.items ?? []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [filter]);

  const resetForm = () => {
    setForm({ title: '', kind: 'meeting', startsAt: '', regionCode: '', venue: '' });
    setEditingId(null);
  };

  const create = async () => {
    try {
      const payload: Record<string, unknown> = {
        title: form.title,
        kind: form.kind,
        startsAt: new Date(form.startsAt).toISOString(),
        regionCode: form.regionCode || undefined,
        venue: form.venue || undefined,
      };
      if (editingId) {
        await api.updateEvent(editingId, payload);
      } else {
        await api.createEvent(payload);
      }
      setShowCreate(false);
      resetForm();
      load();
    } catch {
      alert(editingId ? 'Failed to update event.' : 'Failed to create event.');
    }
  };

  // ISO → the value shape a `datetime-local` input expects, in local time.
  const toLocalInput = (iso: string | null): string => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const openEdit = (e: any) => {
    setEditingId(e.id);
    setForm({
      title: e.title ?? '',
      kind: e.kind ?? 'meeting',
      startsAt: toLocalInput(e.startsAt),
      regionCode: e.regionCode ?? '',
      venue: e.venue ?? '',
    });
    setShowCreate(true);
  };

  const remove = async (id: string, title: string) => {
    if (!window.confirm(`Delete event "${title}"? This cannot be undone.`)) return;
    try {
      await api.deleteEvent(id);
      load();
    } catch {
      alert('Failed to delete event.');
    }
  };

  const setStatus = async (id: string, status: string) => {
    try {
      await api.updateEvent(id, { status });
      load();
    } catch {
      alert('Failed to update event.');
    }
  };

  const upcoming = events.filter((e) => e.status === 'scheduled').length;

  return (
    <div>
      <CrmPageHeader
        title="Events"
        subtitle="Party events with RSVP tracking and lifecycle status."
        actions={<CrmButton onClick={() => { resetForm(); setShowCreate(true); }}>+ Create Event</CrmButton>}
      />

      <CrmStatGrid
        stats={[
          { label: 'Total Events', value: events.length },
          { label: 'Scheduled', value: upcoming, tone: 'default' },
          { label: 'Live', value: events.filter((e) => e.status === 'live').length, tone: 'success' },
          { label: 'Completed', value: events.filter((e) => e.status === 'done').length },
        ]}
      />

      <CrmFilters>
        <select value={filter.kind} onChange={(e) => setFilter({ ...filter, kind: e.target.value })}>
          <option value="">All Kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          <option value="">All Statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <CrmSmallButton
          onClick={() =>
            downloadCsv(
              'events',
              ['Title', 'Kind', 'Status', 'Starts', 'RSVPs', 'Region'],
              events.map((e) => [e.title ?? '', e.kind ?? '', e.status ?? '', e.startsAt ?? '', e.rsvpCount ?? 0, e.regionCode ?? '']),
            )
          }
        >
          Export CSV
        </CrmSmallButton>
      </CrmFilters>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading events…</p>
      ) : (
        <CrmTable
          columns={['Title', 'Kind', 'Status', 'Starts', 'RSVPs', 'Region', 'Actions']}
          rows={events.map((e) => [
            e.title ?? '—',
            e.kind ?? '—',
            <CrmBadge key="s" value={e.status} />,
            fmtDateTime(e.startsAt),
            e.rsvpCount ?? 0,
            e.regionCode ?? '—',
            <span key="a">
              <CrmSmallButton onClick={() => openEdit(e)}>Edit</CrmSmallButton>{' '}
              <CrmSmallButton onClick={() => setCoverFor({ id: e.id, title: e.title, hasCover: !!e.hasCover })}>Cover</CrmSmallButton>{' '}
              <CrmSmallButton onClick={() => setAttendeesFor({ id: e.id, title: e.title })}>Attendees</CrmSmallButton>{' '}
              <CrmSmallButton onClick={() => setAttachFor({ id: e.id, title: e.title })}>Attachments</CrmSmallButton>{' '}
              {e.status === 'scheduled' && <CrmSmallButton onClick={() => setStatus(e.id, 'live')}>Go Live</CrmSmallButton>}
              {e.status === 'live' && <CrmSmallButton onClick={() => setStatus(e.id, 'done')}>Mark Done</CrmSmallButton>}
              {e.status !== 'cancelled' && e.status !== 'done' && (
                <CrmSmallButton danger onClick={() => setStatus(e.id, 'cancelled')}>Cancel</CrmSmallButton>
              )}{' '}
              <CrmSmallButton danger onClick={() => remove(e.id, e.title)}>Delete</CrmSmallButton>
            </span>,
          ])}
          empty="No events found."
        />
      )}

      {showCreate && (
        <CrmModal title={editingId ? 'Edit Event' : 'Create Event'} onClose={() => { setShowCreate(false); resetForm(); }}>
          <CrmField label="Title">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </CrmField>
          <CrmField label="Kind">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </CrmField>
          <CrmField label="Starts At">
            <input type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
          </CrmField>
          <CrmField label="Region Code (optional)">
            <input value={form.regionCode} onChange={(e) => setForm({ ...form, regionCode: e.target.value })} placeholder="e.g. NORTH-W09" />
          </CrmField>
          <CrmField label="Venue (optional)">
            <input value={form.venue} onChange={(e) => setForm({ ...form, venue: e.target.value })} />
          </CrmField>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <CrmButton variant="secondary" onClick={() => { setShowCreate(false); resetForm(); }}>Cancel</CrmButton>
            <CrmButton onClick={create} disabled={!form.title || !form.startsAt}>{editingId ? 'Save changes' : 'Create'}</CrmButton>
          </div>
        </CrmModal>
      )}

      {attachFor && (
        <AttachmentManager
          parentType="event"
          parentId={attachFor.id}
          parentTitle={attachFor.title}
          onClose={() => setAttachFor(null)}
        />
      )}

      {coverFor && (
        <CoverEditor
          parentType="event"
          parentId={coverFor.id}
          parentTitle={coverFor.title}
          hasCover={coverFor.hasCover}
          onClose={() => setCoverFor(null)}
          onSaved={load}
        />
      )}

      {attendeesFor && (
        <EventAttendees
          eventId={attendeesFor.id}
          eventTitle={attendeesFor.title}
          onClose={() => setAttendeesFor(null)}
        />
      )}
    </div>
  );
}
