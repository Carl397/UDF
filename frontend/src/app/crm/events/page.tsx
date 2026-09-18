'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
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
  const [form, setForm] = useState({ title: '', kind: 'meeting', startsAt: '', regionCode: '', venue: '' });

  const load = () => {
    setLoading(true);
    const params: Record<string, string> = { limit: '200' };
    if (filter.kind) params.kind = filter.kind;
    if (filter.status) params.status = filter.status;
    api
      .listEvents(params as any)
      .then((r: { items: any[] }) => setEvents(r.items ?? []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [filter]);

  const create = async () => {
    try {
      await api.createEvent({
        title: form.title,
        kind: form.kind,
        startsAt: new Date(form.startsAt).toISOString(),
        regionCode: form.regionCode || undefined,
        venue: form.venue || undefined,
      });
      setShowCreate(false);
      load();
    } catch {
      alert('Failed to create event.');
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
        actions={<CrmButton onClick={() => setShowCreate(true)}>+ Create Event</CrmButton>}
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
              {e.status === 'scheduled' && <CrmSmallButton onClick={() => setStatus(e.id, 'live')}>Go Live</CrmSmallButton>}
              {e.status === 'live' && <CrmSmallButton onClick={() => setStatus(e.id, 'done')}>Mark Done</CrmSmallButton>}
              {e.status !== 'cancelled' && e.status !== 'done' && (
                <CrmSmallButton danger onClick={() => setStatus(e.id, 'cancelled')}>Cancel</CrmSmallButton>
              )}
            </span>,
          ])}
          empty="No events found."
        />
      )}

      {showCreate && (
        <CrmModal title="Create Event" onClose={() => setShowCreate(false)}>
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
            <CrmButton variant="secondary" onClick={() => setShowCreate(false)}>Cancel</CrmButton>
            <CrmButton onClick={create} disabled={!form.title || !form.startsAt}>Create</CrmButton>
          </div>
        </CrmModal>
      )}
    </div>
  );
}
