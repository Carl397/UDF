'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import type { AppNotification } from '../../../types';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmModal, CrmField,
  CrmButton, CrmSmallButton, CrmFilters, downloadCsv, fmtDateTime,
} from '../../../components/crm/ui';

/**
 * CRM Notifications — broadcast centre. Compose and push notifications to
 * all members or a single region, and review the delivery log.
 */

const KINDS = ['announcement', 'alert', 'reminder', 'event', 'petition', 'bulletin'];

export default function CrmNotifications() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [unread, setUnread] = useState(0);
  const [total, setTotal] = useState(0);
  const [onlyBroadcast, setOnlyBroadcast] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [sending, setSending] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', kind: 'announcement', link: '', regionCode: '' });

  const load = () => {
    setLoading(true);
    api
      .listNotifications({ limit: 200 })
      .then((r: { items: AppNotification[]; total: number; unread: number }) => {
        setItems(r.items ?? []);
        setTotal(r.total ?? 0);
        setUnread(r.unread ?? 0);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const filtered = onlyBroadcast ? items.filter((i) => i.broadcast) : items;
  const broadcasts = items.filter((i) => i.broadcast).length;

  const send = async () => {
    setSending(true);
    try {
      await api.broadcastNotification({
        title: form.title,
        body: form.body || undefined,
        kind: form.kind,
        link: form.link || undefined,
        regionCode: form.regionCode || undefined,
      });
      setShowCompose(false);
      setForm({ title: '', body: '', kind: 'announcement', link: '', regionCode: '' });
      load();
    } catch {
      alert('Failed to send broadcast.');
    } finally {
      setSending(false);
    }
  };

  const markAllRead = async () => {
    try {
      await api.markAllNotificationsRead();
      load();
    } catch {
      alert('Failed to mark notifications read.');
    }
  };

  return (
    <div>
      <CrmPageHeader
        title="Notifications"
        subtitle="Broadcast announcements and alerts to members, and review the delivery log."
        actions={
          <>
            <CrmButton variant="secondary" onClick={markAllRead}>Mark All Read</CrmButton>
            <CrmButton onClick={() => setShowCompose(true)}>+ New Broadcast</CrmButton>
          </>
        }
      />

      <CrmStatGrid
        stats={[
          { label: 'Total Sent', value: total.toLocaleString() },
          { label: 'Broadcasts', value: broadcasts },
          { label: 'Unread (mine)', value: unread, tone: unread > 0 ? 'warn' : 'default' },
          { label: 'Kinds', value: KINDS.length },
        ]}
      />

      <CrmFilters>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
          <input type="checkbox" checked={onlyBroadcast} onChange={(e) => setOnlyBroadcast(e.target.checked)} style={{ width: 'auto' }} />
          Broadcasts only
        </label>
        <CrmSmallButton
          onClick={() =>
            downloadCsv(
              'notifications',
              ['Title', 'Kind', 'Body', 'Region', 'Broadcast', 'Read', 'Created'],
              items.map((i) => [i.title, i.kind, i.body ?? '', i.regionCode ?? '', i.broadcast ? 'yes' : 'no', i.read ? 'yes' : 'no', i.createdAt ?? '']),
            )
          }
        >
          Export CSV
        </CrmSmallButton>
      </CrmFilters>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading notifications…</p>
      ) : (
        <CrmTable
          columns={['Title', 'Kind', 'Audience', 'Sent', 'Status', '']}
          rows={filtered.map((n) => [
            <span key="t">
              <strong>{n.title}</strong>
              {n.body && <><br /><span style={{ color: '#64748b', fontSize: 13 }}>{n.body.slice(0, 90)}{n.body.length > 90 ? '…' : ''}</span></>}
            </span>,
            <CrmBadge key="k" value={n.kind} />,
            n.broadcast ? (n.regionCode ? `Region: ${n.regionCode}` : 'All members') : 'Direct',
            <span key="d" style={{ fontSize: 13 }}>{fmtDateTime(n.createdAt)}</span>,
            n.read ? <CrmBadge key="r" value="verified" /> : <CrmBadge key="r" value="pending" />,
            n.link ? <CrmSmallButton key="l" onClick={() => window.open(n.link!, '_blank')}>Open Link</CrmSmallButton> : '—',
          ])}
          empty="No notifications sent yet."
        />
      )}

      {showCompose && (
        <CrmModal title="New Broadcast" onClose={() => setShowCompose(false)}>
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
          <CrmField label="Region Code (leave blank for all members)">
            <input value={form.regionCode} onChange={(e) => setForm({ ...form, regionCode: e.target.value })} placeholder="e.g. CPT-SC4" />
          </CrmField>
          <CrmField label="Link (optional)">
            <input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="https://…" />
          </CrmField>
          <CrmField label="Body">
            <textarea rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </CrmField>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <CrmButton variant="secondary" onClick={() => setShowCompose(false)}>Cancel</CrmButton>
            <CrmButton onClick={send} disabled={!form.title || sending}>{sending ? 'Sending…' : 'Broadcast'}</CrmButton>
          </div>
        </CrmModal>
      )}
    </div>
  );
}
