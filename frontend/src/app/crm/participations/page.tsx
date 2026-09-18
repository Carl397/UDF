'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import type { Participation } from '../../../types';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmModal, CrmField,
  CrmButton, CrmSmallButton, CrmFilters, downloadCsv, fmtDate, fmtDateTime,
} from '../../../components/crm/ui';

/**
 * CRM Participations — oversight of public participation processes
 * (IDP reviews, budget consultations, by-law comment windows).
 * Admins can open a participation, view the window and add official comments.
 */

const SCOPES = ['ward', 'regional', 'national'];

export default function CrmParticipations() {
  const [items, setItems] = useState<Participation[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [detail, setDetail] = useState<Participation | null>(null);
  const [comment, setComment] = useState('');
  const [form, setForm] = useState({
    title: '', subject: '', body: '', scope: 'ward', wardCode: '', opensAt: '', closesAt: '',
  });

  const load = () => {
    setLoading(true);
    const params: Record<string, string> = { limit: '200' };
    if (scope) params.scope = scope;
    api
      .listParticipations(params)
      .then((r: { items: Participation[] }) => setItems(r.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [scope]);

  const openCount = items.filter((i) => i.status === 'open').length;
  const scheduled = items.filter((i) => i.status === 'scheduled').length;
  const closed = items.filter((i) => i.status === 'closed').length;

  const create = async () => {
    try {
      await api.createParticipation({
        title: form.title,
        subject: form.subject || undefined,
        body: form.body || undefined,
        scope: form.scope,
        wardCode: form.wardCode || undefined,
        opensAt: form.opensAt ? new Date(form.opensAt).toISOString() : new Date().toISOString(),
        closesAt: form.closesAt ? new Date(form.closesAt).toISOString() : undefined,
      });
      setShowCreate(false);
      setForm({ title: '', subject: '', body: '', scope: 'ward', wardCode: '', opensAt: '', closesAt: '' });
      load();
    } catch {
      alert('Failed to open participation.');
    }
  };

  const addComment = async () => {
    if (!detail || !comment.trim()) return;
    try {
      await api.addParticipationComment(detail.id, { comment: comment.trim() });
      setComment('');
      alert('Official comment recorded.');
      setDetail(null);
    } catch {
      alert('Failed to add comment.');
    }
  };

  return (
    <div>
      <CrmPageHeader
        title="Public Participations"
        subtitle="IDP reviews, budget consultations and by-law comment windows."
        actions={<CrmButton onClick={() => setShowCreate(true)}>+ Open Participation</CrmButton>}
      />

      <CrmStatGrid
        stats={[
          { label: 'Total', value: items.length },
          { label: 'Open', value: openCount, tone: 'success' },
          { label: 'Scheduled', value: scheduled, tone: 'warn' },
          { label: 'Closed', value: closed },
        ]}
      />

      <CrmFilters>
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">All scopes</option>
          {SCOPES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <CrmSmallButton
          onClick={() =>
            downloadCsv(
              'participations',
              ['Title', 'Subject', 'Scope', 'Ward', 'Status', 'Opens', 'Closes'],
              items.map((i) => [i.title, i.subject ?? '', i.scope, i.wardCode ?? '', i.status, i.opensAt ?? '', i.closesAt ?? '']),
            )
          }
        >
          Export CSV
        </CrmSmallButton>
      </CrmFilters>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading participations…</p>
      ) : (
        <CrmTable
          columns={['Title', 'Scope', 'Ward', 'Window', 'Status', '']}
          rows={items.map((i) => [
            <span key="t">
              <strong>{i.title}</strong>
              {i.subject && <><br /><span style={{ color: '#64748b', fontSize: 13 }}>{i.subject}</span></>}
            </span>,
            <CrmBadge key="s" value={i.scope} />,
            i.wardCode ?? '—',
            <span key="w" style={{ fontSize: 13 }}>{fmtDate(i.opensAt)} → {fmtDate(i.closesAt)}</span>,
            <CrmBadge key="st" value={i.status} />,
            <CrmSmallButton key="v" onClick={() => { setDetail(i); setComment(''); }}>View</CrmSmallButton>,
          ])}
          empty="No participation processes found."
        />
      )}

      {showCreate && (
        <CrmModal title="Open Participation" onClose={() => setShowCreate(false)}>
          <CrmField label="Title">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </CrmField>
          <CrmField label="Subject">
            <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="e.g. 2026 IDP Review" />
          </CrmField>
          <CrmField label="Scope">
            <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
              {SCOPES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </CrmField>
          <CrmField label="Ward Code">
            <input value={form.wardCode} onChange={(e) => setForm({ ...form, wardCode: e.target.value })} placeholder="e.g. NORTH-W09" />
          </CrmField>
          <CrmField label="Opens At">
            <input type="datetime-local" value={form.opensAt} onChange={(e) => setForm({ ...form, opensAt: e.target.value })} />
          </CrmField>
          <CrmField label="Closes At">
            <input type="datetime-local" value={form.closesAt} onChange={(e) => setForm({ ...form, closesAt: e.target.value })} />
          </CrmField>
          <CrmField label="Body">
            <textarea rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </CrmField>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <CrmButton variant="secondary" onClick={() => setShowCreate(false)}>Cancel</CrmButton>
            <CrmButton onClick={create} disabled={!form.title}>Open</CrmButton>
          </div>
        </CrmModal>
      )}

      {detail && (
        <CrmModal title={detail.title} onClose={() => setDetail(null)} wide>
          <p style={{ color: '#64748b', marginTop: 0 }}>{detail.subject}</p>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
            <div><strong>Scope:</strong> <CrmBadge value={detail.scope} /></div>
            <div><strong>Status:</strong> <CrmBadge value={detail.status} /></div>
            <div><strong>Ward:</strong> {detail.wardCode ?? '—'}</div>
            <div><strong>Opens:</strong> {fmtDateTime(detail.opensAt)}</div>
            <div><strong>Closes:</strong> {fmtDateTime(detail.closesAt)}</div>
          </div>
          {detail.body && <p style={{ whiteSpace: 'pre-wrap' }}>{detail.body}</p>}
          <CrmField label="Add official comment">
            <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Record an official response or note…" />
          </CrmField>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <CrmButton variant="secondary" onClick={() => setDetail(null)}>Close</CrmButton>
            <CrmButton onClick={addComment} disabled={!comment.trim()}>Post Comment</CrmButton>
          </div>
        </CrmModal>
      )}
    </div>
  );
}
