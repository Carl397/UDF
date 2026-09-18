'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import type { ServiceRequest } from '../../../types';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmCard, CrmBadge,
  CrmSmallButton, downloadCsv,
} from '../../../components/crm/ui';

/**
 * CRM Analytics — cross-ward performance intelligence. Aggregates service
 * requests into status/category distributions and a per-ward scorecard
 * (volume, resolution rate, SLA health) for leadership review.
 */

interface WardScore {
  ward: string;
  total: number;
  open: number;
  resolved: number;
  breach: number;
  resolutionRate: number;
}

function BarChart({ data, color = '#c8102e' }: { data: { label: string; value: number }[]; color?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div>
      {data.map((d) => (
        <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <span style={{ width: 130, fontSize: 13, color: '#374151', textTransform: 'capitalize' }}>{d.label.replace(/_/g, ' ')}</span>
          <span style={{ flex: 1, height: 18, background: '#f1f1f1', borderRadius: 4, overflow: 'hidden' }}>
            <span style={{ display: 'block', width: `${(d.value / max) * 100}%`, height: 18, background: color, borderRadius: 4 }} />
          </span>
          <span style={{ width: 40, textAlign: 'right', fontSize: 13, fontWeight: 600 }}>{d.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function CrmAnalytics() {
  const [cases, setCases] = useState<ServiceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ activeMembers: 0, openCases: 0, openPetitions: 0, openParticipations: 0 });

  useEffect(() => {
    Promise.all([
      api.crmEngagements({ limit: '1000' }).catch(() => ({ items: [] as ServiceRequest[] })),
      api.crmDashboard().catch(() => ({ activeMembers: 0, openCases: 0, openPetitions: 0, openParticipations: 0 })),
    ])
      .then(([eng, dash]) => {
        setCases((eng.items ?? []) as ServiceRequest[]);
        setStats(dash);
      })
      .finally(() => setLoading(false));
  }, []);

  const countBy = (key: keyof ServiceRequest) => {
    const map = new Map<string, number>();
    cases.forEach((c) => {
      const k = String(c[key] ?? 'unknown');
      map.set(k, (map.get(k) ?? 0) + 1);
    });
    return [...map.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  };

  const byStatus = countBy('status');
  const byCategory = countBy('category');

  const wardScores: WardScore[] = (() => {
    const map = new Map<string, WardScore>();
    cases.forEach((c) => {
      const ward = c.wardCode ?? 'Unassigned';
      if (!map.has(ward)) map.set(ward, { ward, total: 0, open: 0, resolved: 0, breach: 0, resolutionRate: 0 });
      const s = map.get(ward)!;
      s.total++;
      if (['resolved', 'verified', 'closed'].includes(c.status)) s.resolved++;
      else s.open++;
      if (c.slaDueAt && new Date(c.slaDueAt) < new Date() && !['resolved', 'verified', 'closed'].includes(c.status)) s.breach++;
    });
    return [...map.values()]
      .map((s) => ({ ...s, resolutionRate: s.total ? Math.round((s.resolved / s.total) * 100) : 0 }))
      .sort((a, b) => b.total - a.total);
  })();

  const resolvedTotal = cases.filter((c) => ['resolved', 'verified', 'closed'].includes(c.status)).length;
  const overallRate = cases.length ? Math.round((resolvedTotal / cases.length) * 100) : 0;

  if (loading) {
    return (
      <div>
        <CrmPageHeader title="Analytics" subtitle="Cross-ward performance intelligence." />
        <p style={{ color: '#64748b' }}>Crunching numbers…</p>
      </div>
    );
  }

  return (
    <div>
      <CrmPageHeader
        title="Analytics"
        subtitle="Cross-ward performance intelligence and service-delivery scorecards."
        actions={
          <CrmSmallButton
            onClick={() =>
              downloadCsv(
                'ward-scorecards',
                ['Ward', 'Total Cases', 'Open', 'Resolved', 'SLA Breaches', 'Resolution Rate %'],
                wardScores.map((w) => [w.ward, w.total, w.open, w.resolved, w.breach, w.resolutionRate]),
              )
            }
          >
            Export Scorecards
          </CrmSmallButton>
        }
      />

      <CrmStatGrid
        stats={[
          { label: 'Active Members', value: stats.activeMembers.toLocaleString() },
          { label: 'Total Cases', value: cases.length.toLocaleString() },
          { label: 'Resolution Rate', value: `${overallRate}%`, tone: overallRate >= 60 ? 'success' : overallRate >= 30 ? 'warn' : 'danger' },
          { label: 'Open Petitions', value: stats.openPetitions },
          { label: 'Live Participations', value: stats.openParticipations },
        ]}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 20 }}>
        <CrmCard title="Cases by Status">
          <BarChart data={byStatus} />
        </CrmCard>
        <CrmCard title="Cases by Category">
          <BarChart data={byCategory} color="#0369a1" />
        </CrmCard>
      </div>

      <CrmCard title="Ward Scorecards">
        <CrmTable
          columns={['Ward', 'Total', 'Open', 'Resolved', 'SLA Breach', 'Resolution Rate']}
          rows={wardScores.map((w) => [
            <strong key="w">{w.ward}</strong>,
            w.total,
            <span key="o" style={{ color: w.open > 0 ? '#92400e' : '#64748b' }}>{w.open}</span>,
            <span key="r" style={{ color: '#166534' }}>{w.resolved}</span>,
            w.breach > 0 ? <CrmBadge key="b" value="sla_breach" /> : <span style={{ color: '#94a3b8' }}>0</span>,
            <span key="rr" style={{ fontSize: 13 }}>
              {w.resolutionRate}%
              <span style={{ display: 'block', width: 100, height: 6, background: '#eee', borderRadius: 3, marginTop: 4 }}>
                <span style={{ display: 'block', width: `${w.resolutionRate}%`, height: 6, background: w.resolutionRate >= 60 ? '#16a34a' : w.resolutionRate >= 30 ? '#d97706' : '#c8102e', borderRadius: 3 }} />
              </span>
            </span>,
          ])}
          empty="No case data to score yet."
        />
      </CrmCard>
    </div>
  );
}
