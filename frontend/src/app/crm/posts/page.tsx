'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmFilters, CrmModal, CrmField,
  CrmButton, CrmSmallButton, downloadCsv, fmtDateTime,
} from '../../../components/crm/ui';

/**
 * CRM Posts — communications newsroom with moderation queue.
 * Community notes and service-delivery reports can be taken down with a
 * recorded reason (audited), then restored.
 */

const KINDS = ['news', 'press_release', 'highlight', 'statement', 'community_note', 'service_delivery'];

export default function CrmPosts() {
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ kind: '' });
  const [takeDown, setTakeDown] = useState<any>(null);
  const [reason, setReason] = useState('');

  const load = () => {
    setLoading(true);
    const params: Record<string, string> = { limit: '200' };
    if (filter.kind) params.kind = filter.kind;
    api
      .listPosts(params as any)
      .then((r: { items: any[] }) => setPosts(r.items ?? []))
      .catch(() => setPosts([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [filter]);

  const doTakeDown = async () => {
    if (!takeDown || !reason.trim()) return;
    try {
      await api.takeDownPost(takeDown.id, reason.trim());
      setTakeDown(null);
      setReason('');
      load();
    } catch {
      alert('Take-down failed.');
    }
  };

  const restore = async (id: string) => {
    try {
      await api.restorePost(id);
      load();
    } catch {
      alert('Restore failed.');
    }
  };

  const takenDown = posts.filter((p) => p.takenDownAt || p.status === 'taken_down');

  return (
    <div>
      <CrmPageHeader
        title="Posts & Moderation"
        subtitle="Party communications with take-down / restore moderation trail."
      />

      <CrmStatGrid
        stats={[
          { label: 'Total Posts', value: posts.length },
          { label: 'Published', value: posts.length - takenDown.length, tone: 'success' },
          { label: 'Taken Down', value: takenDown.length, tone: takenDown.length ? 'danger' : 'default' },
        ]}
      />

      <CrmFilters>
        <select value={filter.kind} onChange={(e) => setFilter({ kind: e.target.value })}>
          <option value="">All Kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>{k.replace('_', ' ')}</option>
          ))}
        </select>
        <CrmSmallButton
          onClick={() =>
            downloadCsv(
              'posts',
              ['Title', 'Kind', 'Status', 'Severity', 'Published'],
              posts.map((p) => [p.title ?? '', p.kind ?? '', p.takenDownAt ? 'taken_down' : 'published', p.severity ?? '', p.createdAt ?? '']),
            )
          }
        >
          Export CSV
        </CrmSmallButton>
      </CrmFilters>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading posts…</p>
      ) : (
        <CrmTable
          columns={['Title', 'Kind', 'Severity', 'Status', 'Published', 'Actions']}
          rows={posts.map((p) => [
            <span key="t"><strong>{p.title}</strong><br /><span style={{ color: '#64748b', fontSize: 13 }}>{(p.body ?? '').slice(0, 80)}…</span></span>,
            p.kind?.replace('_', ' ') ?? '—',
            p.severity ?? '—',
            <CrmBadge key="s" value={p.takenDownAt ? 'taken_down' : 'published'} />,
            fmtDateTime(p.createdAt),
            <span key="a">
              {p.takenDownAt ? (
                <CrmSmallButton onClick={() => restore(p.id)}>Restore</CrmSmallButton>
              ) : (
                <CrmSmallButton danger onClick={() => setTakeDown(p)}>Take Down</CrmSmallButton>
              )}
            </span>,
          ])}
          empty="No posts found."
        />
      )}

      {takeDown && (
        <CrmModal title={`Take down: ${takeDown.title ?? ''}`} onClose={() => setTakeDown(null)}>
          <p style={{ fontSize: 14, color: '#64748b' }}>
            Record the moderation reason. This action is written to the audit log.
          </p>
          <CrmField label="Reason">
            <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </CrmField>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <CrmButton variant="secondary" onClick={() => setTakeDown(null)}>Cancel</CrmButton>
            <CrmButton variant="danger" onClick={doTakeDown} disabled={!reason.trim()}>Take Down</CrmButton>
          </div>
        </CrmModal>
      )}
    </div>
  );
}
