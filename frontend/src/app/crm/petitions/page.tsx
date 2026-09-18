'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import type { Petition } from '../../../types';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmModal,
  CrmSmallButton, CrmFilters, downloadCsv, fmtDate,
} from '../../../components/crm/ui';

/**
 * CRM Petitions — oversight of open and closed petitions, signature
 * progress against goals, and per-ward/scope breakdown.
 */

export default function CrmPetitions() {
  const [items, setItems] = useState<Petition[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [detail, setDetail] = useState<Petition | null>(null);

  const load = () => {
    setLoading(true);
    api
      .publicPetitions()
      .then((r: { items: Petition[] }) => setItems(r.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const filtered = status ? items.filter((i) => i.status === status) : items;
  const open = items.filter((i) => i.status === 'open');
  const totalSignatures = items.reduce((sum, i) => sum + (i.signatureCount ?? 0), 0);
  const goalMet = items.filter((i) => i.signatureGoal && i.signatureCount >= i.signatureGoal).length;

  const progress = (p: Petition) => {
    if (!p.signatureGoal) return null;
    return Math.min(100, Math.round((p.signatureCount / p.signatureGoal) * 100));
  };

  return (
    <div>
      <CrmPageHeader
        title="Petitions"
        subtitle="Signature drives across wards, regions and national scope."
      />

      <CrmStatGrid
        stats={[
          { label: 'Total Petitions', value: items.length },
          { label: 'Open', value: open.length, tone: 'success' },
          { label: 'Signatures', value: totalSignatures.toLocaleString() },
          { label: 'Goals Met', value: goalMet, tone: goalMet > 0 ? 'success' : 'default' },
        ]}
      />

      <CrmFilters>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="draft">Draft</option>
        </select>
        <CrmSmallButton
          onClick={() =>
            downloadCsv(
              'petitions',
              ['Title', 'Target', 'Scope', 'Ward', 'Status', 'Signatures', 'Goal'],
              items.map((i) => [i.title, i.target ?? '', i.scope, i.wardCode ?? '', i.status, i.signatureCount ?? 0, i.signatureGoal ?? '']),
            )
          }
        >
          Export CSV
        </CrmSmallButton>
      </CrmFilters>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading petitions…</p>
      ) : (
        <CrmTable
          columns={['Title', 'Target', 'Scope', 'Progress', 'Status', '']}
          rows={filtered.map((p) => {
            const pct = progress(p);
            return [
              <span key="t"><strong>{p.title}</strong></span>,
              p.target ?? '—',
              <CrmBadge key="s" value={p.scope} />,
              <span key="pr" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
                {p.signatureCount.toLocaleString()}
                {p.signatureGoal ? ` / ${p.signatureGoal.toLocaleString()}` : ''}
                {pct !== null && (
                  <span style={{ display: 'block', width: 120, height: 6, background: '#eee', borderRadius: 3, marginTop: 4 }}>
                    <span style={{ display: 'block', width: `${pct}%`, height: 6, background: pct >= 100 ? '#16a34a' : '#c8102e', borderRadius: 3 }} />
                  </span>
                )}
              </span>,
              <CrmBadge key="st" value={p.status} />,
              <CrmSmallButton key="v" onClick={() => setDetail(p)}>View</CrmSmallButton>,
            ];
          })}
          empty="No petitions found."
        />
      )}

      {detail && (
        <CrmModal title={detail.title} onClose={() => setDetail(null)} wide>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
            <div><strong>Status:</strong> <CrmBadge value={detail.status} /></div>
            <div><strong>Scope:</strong> <CrmBadge value={detail.scope} /></div>
            <div><strong>Target:</strong> {detail.target ?? '—'}</div>
            <div><strong>Ward:</strong> {detail.wardCode ?? '—'}</div>
            <div><strong>Region:</strong> {detail.regionCode ?? '—'}</div>
            <div><strong>Signatures:</strong> {detail.signatureCount.toLocaleString()}</div>
            <div><strong>Goal:</strong> {detail.signatureGoal?.toLocaleString() ?? '—'}</div>
            <div><strong>Opens:</strong> {fmtDate(detail.opensAt)}</div>
            <div><strong>Closes:</strong> {fmtDate(detail.closesAt)}</div>
          </div>
          {detail.body && <p style={{ whiteSpace: 'pre-wrap', color: '#374151' }}>{detail.body}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <CrmSmallButton onClick={() => setDetail(null)}>Close</CrmSmallButton>
          </div>
        </CrmModal>
      )}
    </div>
  );
}
