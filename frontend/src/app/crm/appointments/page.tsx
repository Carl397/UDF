'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmModal, CrmField,
  CrmButton, CrmSmallButton, downloadCsv, fmtDate,
} from '../../../components/crm/ui';

/**
 * CRM Appointments — party office appointments and mandate issuance.
 * Positions come from the catalog; mandates are issued as time-limited links.
 */

export default function CrmAppointments() {
  const [appointments, setAppointments] = useState<any[]>([]);
  const [positions, setPositions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ memberId: '', positionId: '', regionCode: '' });
  const [mandate, setMandate] = useState<{ url: string; expiresAt: string } | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      api.listAppointments({ limit: 200 }).catch(() => ({ items: [] as any[] })),
      api.listPositions().catch(() => ({ items: [] as any[] })),
    ]).then(([a, p]) => {
      setAppointments(a.items ?? []);
      setPositions(p.items ?? []);
    }).finally(() => setLoading(false));
  };

  useEffect(load, []);

  const create = async () => {
    try {
      const res = await api.createAppointment({
        memberId: form.memberId,
        positionId: form.positionId,
        regionCode: form.regionCode || undefined,
      });
      setShowCreate(false);
      setMandate({ url: (res as any).mandateUrl, expiresAt: (res as any).expiresAt ?? '' });
      load();
    } catch {
      alert('Failed to create appointment.');
    }
  };

  const issueMandate = async (id: string) => {
    try {
      const res = await api.issueMandateLink(id);
      setMandate({ url: res.mandateUrl, expiresAt: res.expiresAt });
    } catch {
      alert('Failed to issue mandate link.');
    }
  };

  const positionName = (id: string) => positions.find((p) => p.id === id)?.title ?? id.slice(0, 8);

  return (
    <div>
      <CrmPageHeader
        title="Appointments & Mandates"
        subtitle="Party office appointments with audited mandate issuance."
        actions={<CrmButton onClick={() => setShowCreate(true)}>+ Appoint</CrmButton>}
      />

      <CrmStatGrid
        stats={[
          { label: 'Appointments', value: appointments.length },
          { label: 'Proposed', value: appointments.filter((a) => a.status === 'proposed').length, tone: 'warn' },
          { label: 'Accepted', value: appointments.filter((a) => a.status === 'accepted').length, tone: 'success' },
          { label: 'Ended', value: appointments.filter((a) => a.status === 'ended').length },
        ]}
      />

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading appointments…</p>
      ) : (
        <CrmTable
          columns={['Position', 'Member', 'Region', 'Status', 'From', 'Actions']}
          rows={appointments.map((a) => [
            positionName(a.positionId),
            <code key="m">{(a.memberId ?? '—').slice(0, 8)}</code>,
            a.regionCode ?? '—',
            <CrmBadge key="s" value={a.status} />,
            fmtDate(a.startsAt ?? a.createdAt),
            <span key="a">
              <CrmSmallButton onClick={() => issueMandate(a.id)}>Issue Mandate</CrmSmallButton>
            </span>,
          ])}
          empty="No appointments recorded."
        />
      )}

      <CrmSmallButton
        onClick={() =>
          downloadCsv(
            'appointments',
            ['Position', 'Member', 'Region', 'Status', 'From'],
            appointments.map((a) => [positionName(a.positionId), a.memberId ?? '', a.regionCode ?? '', a.status ?? '', a.startsAt ?? a.createdAt ?? '']),
          )
        }
      >
        Export CSV
      </CrmSmallButton>

      {showCreate && (
        <CrmModal title="Create Appointment" onClose={() => setShowCreate(false)}>
          <CrmField label="Member ID">
            <input value={form.memberId} onChange={(e) => setForm({ ...form, memberId: e.target.value })} placeholder="member uuid" />
          </CrmField>
          <CrmField label="Position">
            <select value={form.positionId} onChange={(e) => setForm({ ...form, positionId: e.target.value })}>
              <option value="">Select position…</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </CrmField>
          <CrmField label="Region Code (optional)">
            <input value={form.regionCode} onChange={(e) => setForm({ ...form, regionCode: e.target.value })} />
          </CrmField>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <CrmButton variant="secondary" onClick={() => setShowCreate(false)}>Cancel</CrmButton>
            <CrmButton onClick={create} disabled={!form.memberId || !form.positionId}>Appoint</CrmButton>
          </div>
        </CrmModal>
      )}

      {mandate && (
        <CrmModal title="Mandate Link Issued" onClose={() => setMandate(null)}>
          <p style={{ fontSize: 14, color: '#64748b' }}>
            Share this time-limited link with the appointee to accept the mandate:
          </p>
          <code style={{ display: 'block', background: '#f5f5f5', padding: 12, borderRadius: 6, wordBreak: 'break-all', fontSize: 12 }}>
            {mandate.url}
          </code>
          {mandate.expiresAt && (
            <p style={{ fontSize: 13, color: '#991b1b', marginTop: 12 }}>Expires: {new Date(mandate.expiresAt).toLocaleString()}</p>
          )}
        </CrmModal>
      )}
    </div>
  );
}
