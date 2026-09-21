'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import type { AnalyticsOverview, AnalyticsTraffic, AnalyticsDevices } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { can, Perm } from '../../../lib/caps';
import { CrmPageHeader, CrmCard, CrmStatGrid, CrmTable, CrmFilters } from '../../../components/crm/ui';
import { TimeSeriesArea, HBarChart, DonutChart } from '../../../components/crm/charts';

/**
 * Platform → Website Analytics (SuperAdmin).
 *
 * First-party, cookieless traffic intelligence across the marketing site, the
 * member app and the CRM. No personally identifiable data is here by design —
 * visitors are anonymous daily-rotating HMAC hashes, so the figures are stable
 * counts, never a drill-down into an individual.
 */

const WINDOWS = [7, 30, 90];
const SITES: { value: string; label: string }[] = [
  { value: '', label: 'All sites' },
  { value: 'marketing', label: 'Marketing site' },
  { value: 'app', label: 'Member app' },
  { value: 'crm', label: 'CRM' },
];

function delta(v: number | null): { text: string; color: string } {
  if (v == null) return { text: '—', color: '#8a817b' };
  const sign = v > 0 ? '+' : '';
  return { text: `${sign}${v}% vs prev`, color: v > 0 ? '#16a34a' : v < 0 ? '#c8102e' : '#8a817b' };
}

export default function WebsiteAnalytics() {
  const { permissions } = useAuth();
  const allowed = can(permissions, Perm.ANALYTICS_READ);
  const [days, setDays] = useState(30);
  const [site, setSite] = useState('');
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [traffic, setTraffic] = useState<AnalyticsTraffic | null>(null);
  const [devices, setDevices] = useState<AnalyticsDevices | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    const params = { days, site: site || undefined };
    try {
      const [ov, tr, dv] = await Promise.all([
        api.getAnalyticsOverview(params),
        api.getAnalyticsTraffic(params),
        api.getAnalyticsDevices(params),
      ]);
      setOverview(ov);
      setTraffic(tr);
      setDevices(dv);
    } catch {
      /* leave the prior figures on screen; a transient error is not fatal */
    } finally {
      setLoading(false);
    }
  }, [allowed, days, site]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!allowed) {
    return (
      <div>
        <CrmPageHeader title="Website Analytics" subtitle="First-party, cookieless traffic." />
        <CrmCard>
          <p style={{ color: '#8a817b', margin: 0 }}>You do not have access to analytics.</p>
        </CrmCard>
      </div>
    );
  }

  const dPv = delta(overview?.deltas.pageviews ?? null);
  const dVis = delta(overview?.deltas.visitors ?? null);
  const dSess = delta(overview?.deltas.sessions ?? null);
  const points = (overview?.daily ?? []).map((d) => d.day.slice(5));

  return (
    <div>
      <CrmPageHeader
        title="Website Analytics"
        subtitle="Cookieless, first-party traffic — aggregate counts only, no personal data."
        actions={loading ? <span style={{ fontSize: 12, color: '#8a817b', alignSelf: 'center' }}>Loading…</span> : undefined}
      />

      <CrmFilters>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Window">
          {WINDOWS.map((w) => (
            <option key={w} value={w}>Last {w} days</option>
          ))}
        </select>
        <select value={site} onChange={(e) => setSite(e.target.value)} aria-label="Site">
          {SITES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </CrmFilters>

      <CrmStatGrid
        stats={[
          { label: 'Pageviews', value: (overview?.current.pageviews ?? 0).toLocaleString() },
          { label: 'Δ Pageviews', value: dPv.text, tone: overview && overview.deltas.pageviews != null && overview.deltas.pageviews < 0 ? 'danger' : undefined },
          { label: 'Visitors', value: (overview?.current.visitors ?? 0).toLocaleString() },
          { label: 'Δ Visitors', value: dVis.text },
          { label: 'Sessions', value: (overview?.current.sessions ?? 0).toLocaleString() },
          { label: 'PV / session', value: overview?.avgPageviewsPerSession ?? '—' },
        ]}
      />
      <p style={{ marginTop: -12, marginBottom: 20, fontSize: 12, color: '#8a817b' }}>
        Deltas compare this window to the equivalent previous one ({days}d). Timezone: {overview?.timezone ?? '—'}. {dSess.text} sessions.
      </p>

      <CrmCard title="Traffic over time">
        <TimeSeriesArea
          points={points}
          series={[
            { name: 'Pageviews', values: (overview?.daily ?? []).map((d) => d.pageviews) },
            { name: 'Visitors', values: (overview?.daily ?? []).map((d) => d.visitors), color: '#0369a1' },
          ]}
        />
      </CrmCard>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 20 }}>
        <CrmCard title="Top pages">
          <CrmTable
            columns={['Path', 'Views', 'Visitors']}
            rows={(traffic?.topPages ?? []).map((p) => [p.path, p.views, p.visitors])}
            empty="No pageviews yet."
          />
        </CrmCard>
        <CrmCard title="Referrers">
          <CrmTable
            columns={['Host', 'Views']}
            rows={(traffic?.referrers ?? []).map((r) => [r.host, r.views])}
            empty="No external referrers recorded."
          />
        </CrmCard>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
        <CrmCard title="Devices">
          <DonutChart data={(devices?.deviceType ?? []).map((d) => ({ label: d.key, value: d.views }))} />
        </CrmCard>
        <CrmCard title="Browsers">
          <HBarChart data={(devices?.browser ?? []).map((d) => ({ label: d.key, value: d.views }))} color="#0369a1" />
        </CrmCard>
        <CrmCard title="Operating systems">
          <HBarChart data={(devices?.os ?? []).map((d) => ({ label: d.key, value: d.views }))} color="#16a34a" />
        </CrmCard>
      </div>

      <CrmCard title="Campaigns (UTM)">
        <CrmTable
          columns={['Source', 'Medium', 'Campaign', 'Views']}
          rows={(traffic?.utm ?? []).map((u) => [u.source, u.medium, u.campaign, u.views])}
          empty="No UTM-tagged traffic in this window."
        />
      </CrmCard>
    </div>
  );
}
