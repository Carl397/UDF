'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { AttachmentManager } from '../../../components/crm/AttachmentManager';
import { CoverEditor } from '../../../components/crm/CoverEditor';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmModal, CrmField,
  CrmButton, CrmSmallButton, fmtDateTime,
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ title: '', body: '' });
  const [attachFor, setAttachFor] = useState<{ id: string; title: string } | null>(null);
  const [coverFor, setCoverFor] = useState<{ id: string; title: string; hasCover: boolean } | null>(null);

  const load = () => {
    setLoading(true);
    api
      .listBulletins({ limit: '100' })
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

  const openEdit = (b: any) => {
    setEditingId(b.id);
    setEditForm({ title: b.title ?? '', body: b.body ?? '' });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    try {
      await api.updateBulletin(editingId, { title: editForm.title, body: editForm.body });
      setEditingId(null);
      load();
    } catch {
      alert('Failed to save bulletin.');
    }
  };

  const setStatus = async (id: string, status: 'published' | 'taken_down') => {
    const label = status === 'published' ? 'republish' : 'take down';
    if (!window.confirm(`Are you sure you want to ${label} this bulletin?`)) return;
    try {
      await api.updateBulletin(id, { status });
      load();
    } catch {
      alert(`Failed to ${label} bulletin.`);
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
          columns={['Title', 'Kind', 'Ward', 'Status', 'Published', '']}
          rows={items.map((i) => [
            <span key="t"><strong>{i.title}</strong><br /><span style={{ color: '#64748b', fontSize: 13 }}>{(i.body ?? '').slice(0, 90)}{(i.body ?? '').length > 90 ? '…' : ''}</span></span>,
            <CrmBadge key="k" value={i.kind} />,
            i.wardCode ?? '—',
            <CrmBadge key="s" value={i.status ?? 'published'} />,
            fmtDateTime(i.createdAt),
            <span key="a">
              <CrmSmallButton onClick={() => openEdit(i)}>Edit</CrmSmallButton>{' '}
              <CrmSmallButton onClick={() => setCoverFor({ id: i.id, title: i.title, hasCover: !!i.hasCover })}>Cover</CrmSmallButton>{' '}
              <CrmSmallButton onClick={() => setAttachFor({ id: i.id, title: i.title })}>Attachments</CrmSmallButton>{' '}
              {i.status !== 'published' && <CrmSmallButton onClick={() => setStatus(i.id, 'published')}>Publish</CrmSmallButton>}
              {i.status === 'published' && <CrmSmallButton danger onClick={() => setStatus(i.id, 'taken_down')}>Take down</CrmSmallButton>}
            </span>,
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

      {editingId && (
        <CrmModal title="Edit Bulletin" onClose={() => setEditingId(null)}>
          <CrmField label="Title">
            <input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} />
          </CrmField>
          <CrmField label="Body">
            <textarea rows={6} value={editForm.body} onChange={(e) => setEditForm({ ...editForm, body: e.target.value })} />
          </CrmField>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <CrmButton variant="secondary" onClick={() => setEditingId(null)}>Cancel</CrmButton>
            <CrmButton onClick={saveEdit} disabled={!editForm.title}>Save changes</CrmButton>
          </div>
        </CrmModal>
      )}

      {attachFor && (
        <AttachmentManager
          parentType="bulletin"
          parentId={attachFor.id}
          parentTitle={attachFor.title}
          onClose={() => setAttachFor(null)}
        />
      )}

      {coverFor && (
        <CoverEditor
          parentType="bulletin"
          parentId={coverFor.id}
          parentTitle={coverFor.title}
          hasCover={coverFor.hasCover}
          onClose={() => setCoverFor(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
