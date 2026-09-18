'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmModal, CrmField,
  CrmButton, CrmSmallButton, downloadCsv, fmtDateTime,
} from '../../../components/crm/ui';

/**
 * CRM Bulletins — ward bulletin oversight and publishing.
 * Kinds: news | vacancy | completed_work | vote | announcement.
 */

const KINDS = ['news', 'vacancy', 'completed_work', 'vote', 'announcement'];

export default function CrmBulletins() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', kind: 'news', wardCode: '' });

  const load = () => {
    setLoading(true);
    api
      .listBulletins({ limit: '200' })
      .then((r: { items: any[] }) => setItems(r.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const create = async () => {
    try {
      await api.createBulletin({
        title: form.title,
        body: form.body,
        kind: form.kind,
        wardCode: form.wardCode || undefined,
      });
      setShowCreate(false);
      setForm({ title: '', body: '', kind: 'news', wardCode: '' });
      load();
    } catch {
      alert('Failed to publish bulletin.');
    }
  };

  return (
    <div>
      <CrmPageHeader
        title="Ward Bulletins"
        subtitle="Ward news feed: completed work, vacancies, votes and announcements."
        actions={<CrmButton onClick={() => setShowCreate(true)}>+ Publish Bulletin</CrmButton>}
      />

      <CrmStatGrid
        stats={[
          { label: 'Total Bulletins', value: items.length },
          ...KINDS.slice(0, 3).map((k) => ({
            label: k.replace('_', ' '),
            value: items.filter((i) => i.kind === k).length,
          })),
        ]}
      />

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading bulletins…</p>
      ) : (
        <CrmTable
          columns={['Title', 'Kind', 'Ward', 'Published', '']}
          rows={items.map((i) => [
            <span key="t"><strong>{i.title}</strong><br /><span style={{ color: '#64748b', fontSize: 13 }}>{(i.body ?? '').slice(0, 90)}{(i.body ?? '').length > 90 ? '…' : ''}</span></span>,
            <CrmBadge key="k" value={i.kind} />,
            i.wardCode ?? '—',
            fmtDateTime(i.createdAt),
            <CrmSmallButton
              key="c"
              onClick={() =>
                downloadCsv('bulletin', ['Title', 'Kind', 'Ward', 'Body'], [[i.title ?? '', i.kind ?? '', i.wardCode ?? '', i.body ?? '']])
              }
            >
              Export
            </CrmSmallButton>,
          ])}
          empty="No bulletins published yet."
        />
      )}

      {showCreate && (
        <CrmModal title="Publish Bulletin" onClose={() => setShowCreate(false)}>
          <CrmField label="Title">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </CrmField>
          <CrmField label="Kind">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>{k.replace('_', ' ')}</option>
              ))}
            </select>
          </CrmField>
          <CrmField label="Ward Code">
            <input value={form.wardCode} onChange={(e) => setForm({ ...form, wardCode: e.target.value })} placeholder="e.g. NORTH-W09" />
          </CrmField>
          <CrmField label="Body">
            <textarea rows={5} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </CrmField>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <CrmButton variant="secondary" onClick={() => setShowCreate(false)}>Cancel</CrmButton>
            <CrmButton onClick={create} disabled={!form.title || !form.body || !form.wardCode}>Publish</CrmButton>
          </div>
        </CrmModal>
      )}
    </div>
  );
}
