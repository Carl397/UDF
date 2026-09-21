'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import type { AnalyticsDownloads } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { can, Perm } from '../../../lib/caps';
import { CrmPageHeader, CrmCard, CrmStatGrid, CrmTable, CrmFilters } from '../../../components/crm/ui';
import { TimeSeriesArea, HBarChart } from '../../../components/crm/charts';
import AppUpdatesCard from '../../../components/crm/AppUpdatesCard';

/**
 * Platform → App Downloads (SuperAdmin).
 *
 * Counts of the counted `/api/public/download/apk` redirect: how many times the
 * installer was fetched, from roughly where, and onto what class of device. The
 * originating IP is stored only as a daily-rotating HMAC hash, so "unique" is a
 * per-day distinct count — never a way to follow a single person.
 */

const WINDOWS = [7, 30, 90];

export default function Downloads() {
  const { permissions } = useAuth();
  const allowed = can(permissions, Perm.ANALYTICS_READ);
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AnalyticsDownloads | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    try {
      setData(await api.getAnalyticsDownloads({ days }));
    } catch {
      /* keep the last snapshot */
    } finally {
      setLoading(false);
    }
  }, [allowed, days]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!allowed) {
    return (
      <div>
        <CrmPageHeader title="App Downloads" subtitle="Installer download accounting." />
        <CrmCard>
          <p style={{ color: '#8a817b', margin: 0 }}>You do not have access to analytics.</p>
        </CrmCard>
      </div>
    );
  }

  const bars = (metric: string) =>
    (data?.breakdowns[metric] ?? []).map((v) => ({ label: v.key, value: v.n }));
  const points = (data?.daily ?? []).map((d) => d.day.slice(5));

  return (
    <div>
      <CrmPageHeader
        title="App Downloads"
        subtitle="How often the Android installer is fetched, and onto what devices."
        actions={loading ? <span style={{ fontSize: 12, color: '#8a817b', alignSelf: 'center' }}>Loading…</span> : undefined}
      />

      <AppUpdatesCard />

      <CrmFilters>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Window">
          {WINDOWS.map((w) => (
            <option key={w} value={w}>Last {w} days</option>
          ))}
        </select>
      </CrmFilters>

      <CrmStatGrid
        stats={[
          { label: 'Downloads', value: (data?.total ?? 0).toLocaleString() },
          { label: 'Unique (per-day)', value: (data?.uniqueIps ?? 0).toLocaleString() },
          { label: 'Window', value: `${data?.windowDays ?? days} days` },
        ]}
      />

      <CrmCard title="Downloads over time">
        <TimeSeriesArea
          points={points}
          series={[{ name: 'Downloads', values: (data?.daily ?? []).map((d) => d.downloads) }]}
        />
      </CrmCard>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
        <CrmCard title="By device type">
          <HBarChart data={bars('deviceType')} />
        </CrmCard>
        <CrmCard title="By operating system">
          <HBarChart data={bars('os')} color="#16a34a" />
        </CrmCard>
        <CrmCard title="By browser">
          <HBarChart data={bars('browser')} color="#0369a1" />
        </CrmCard>
        <CrmCard title="By country">
          <HBarChart data={bars('country')} color="#7c3aed" />
        </CrmCard>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
        <CrmCard title="By app version">
          <CrmTable columns={['Version', 'Downloads']} rows={bars('version').map((b) => [b.label, b.value])} empty="No version tags recorded." />
        </CrmCard>
        <CrmCard title="By referrer">
          <CrmTable columns={['Referrer', 'Downloads']} rows={bars('referrer').map((b) => [b.label, b.value])} empty="No referrers recorded." />
        </CrmCard>
      </div>
    </div>
  );
}
