'use client';

import { useEffect, useState } from 'react';
import { api, dataReadError } from '../../../lib/api';
import type { CrmDashboard } from '../../../types';
import { CrmPageHeader, CrmStatGrid, CrmTable, CrmCard, CrmSmallButton, downloadCsv } from '../../../components/crm/ui';

function BarChart({ data, color = '#c8102e' }: { data: { label: string; value: number }[]; color?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return <div>{data.map((d) => <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
    <span style={{ width: 130, fontSize: 13, textTransform: 'capitalize' }}>{d.label.replace(/_/g, ' ')}</span>
    <span aria-hidden="true" style={{ flex: 1, height: 18, background: '#f1f1f1', borderRadius: 4, overflow: 'hidden' }}>
      <span style={{ display: 'block', width: `${(d.value / max) * 100}%`, height: 18, background: color }} />
    </span>
    <span style={{ minWidth: 40, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{d.value}</span>
  </div>)}</div>;
}

export default function CrmAnalytics() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ attempt: number; data: CrmDashboard | null; error: string | null }>({ attempt: -1, data: null, error: null });
  useEffect(() => {
    let active = true;
    api.crmDashboard().then((data) => {
      if (active) setState({ attempt, data, error: null });
    }).catch((error: unknown) => {
      if (active) setState({ attempt, data: null, error: dataReadError(error) });
    });
    return () => { active = false; };
  }, [attempt]);
  const data = state.attempt === attempt ? state.data : null;
  const error = state.attempt === attempt ? state.error : null;
  const loading = !data && !error;
  const cases = data?.activity.modules.cases;
  const performance = cases?.performance;

  return <div>
    <CrmPageHeader title="Analytics" subtitle="All-time service-case performance across your authorized territory. Not resident-report counts or private monthly councillor scores."
      actions={<CrmSmallButton disabled={!performance} onClick={() => performance && downloadCsv('all-time-case-performance-by-ward',
        ['Ward', 'Total cases', 'Open', 'Resolved', 'SLA breached', 'Resolution rate %'],
        performance.byWard.map((w) => [w.wardCode ?? 'No ward assigned', w.total, w.open, w.resolved, w.slaBreached, w.resolutionRatePct ?? 'No cases']))}>Export case performance</CrmSmallButton>} />
    <CrmSmallButton disabled={loading} onClick={() => setAttempt((n) => n + 1)}>{error ? 'Retry' : 'Refresh'}</CrmSmallButton>
    {loading ? <p role="status">Loading case analytics…</p> : error ? <p role="alert">{error}</p> : data && <>
      {cases === null ? <CrmCard title="Case performance unavailable">
        <p role="status">Your account does not have access to case data. No case counts or rates are shown.</p>
        <p style={{ fontSize: 12 }}>Last successful fetch · dashboard generated at <time dateTime={data.activity.asOf}>{data.activity.asOf}</time></p>
      </CrmCard> : performance && <>
        <p style={{ fontSize: 12 }}>Last successful fetch · database as of <time dateTime={performance.asOf}>{performance.asOf}</time></p>
        <CrmStatGrid stats={[
          { label: 'Eligible cases · all-time', value: performance.totals.total },
          { label: 'Open · all-time', value: performance.totals.open },
          { label: 'Resolved · all-time', value: performance.totals.resolved },
          { label: 'Open past SLA deadline', value: performance.totals.slaBreached },
          { label: 'Resolution rate · all-time', value: performance.totals.resolutionRatePct === null ? 'No cases' : `${performance.totals.resolutionRatePct}%` },
        ]} />
        <p style={{ fontSize: 13 }}>Actual service requests only; duplicates and merged records excluded. Resolved includes resolved, verified and closed.
          SLA breaches are open cases past a recorded deadline at the database snapshot. Empty sets have no resolution rate.</p>
        {performance.totals.total === 0 && <p>No eligible service cases in your authorized scope.</p>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 20 }}>
          <CrmCard title="Cases by status · all-time"><BarChart data={performance.byStatus} /></CrmCard>
          <CrmCard title="Cases by category · all-time"><BarChart data={performance.byCategory} color="#0369a1" /></CrmCard>
        </div>
        <CrmCard title="Case performance by ward · all-time">
          <CrmTable columns={['Ward', 'Total', 'Open', 'Resolved', 'SLA breached', 'Resolution rate']}
            rows={performance.byWard.map((w) => [w.wardCode ?? 'No ward assigned', w.total, w.open, w.resolved,
              w.slaBreached, w.resolutionRatePct === null ? 'No cases' : `${w.resolutionRatePct}%`,
            ])} empty="No eligible cases to group by ward." />
        </CrmCard>
        <CrmCard title={`Case creation activity · last ${data.activity.periodDays} days`}>
          <p style={{ fontSize: 12 }}>Existing daily creation series, including records later marked duplicate or merged. This is not the all-time performance denominator.</p>
          <BarChart data={cases!.dailyCreated} color="#57534e" />
        </CrmCard>
      </>}
    </>}
  </div>;
}
