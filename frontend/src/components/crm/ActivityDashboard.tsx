'use client';

import Link from 'next/link';
import type { DashboardActivity } from '../../types';

function Bars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p>No recorded activity.</p>;
  return <div>{rows.map((r) => <div key={r.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(100px, 1fr) 2fr 48px', gap: 10, alignItems: 'center', marginBottom: 8 }}>
    <span style={{ fontSize: 13 }}>{r.label.replace(/_/g, ' ')}</span>
    <div style={{ background: '#eee', borderRadius: 4 }}><div style={{ height: 14, width: `${r.value / max * 100}%`, background: '#c8102e', borderRadius: 4 }} /></div>
    <span style={{ textAlign: 'right' }}>{r.value.toLocaleString()}</span>
  </div>)}</div>;
}
export default function ActivityDashboard({ activity }: { activity: DashboardActivity }) {
  const paths = { reports: '/crm/resident-reports', cases: '/crm/engagements', patrols: '/crm/patrols' };
  return <section aria-label="Reports, cases, and patrol activity">
    <p>Current status totals · updated {new Date(activity.asOf).toLocaleString()} · {activity.timezone}</p>
    <p>Resident reports, service cases, and patrols are separate records. Totals must not be added together as unique issues.</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
      {(['reports','cases','patrols'] as const).map((key) => {
        const data = activity.modules[key];
        if (!data) return null;
        return <article key={key} style={{ background: '#fff', border: '1px solid #ece5e1', borderRadius: 8, padding: 20 }}>
          <h2 style={{ textTransform: 'capitalize' }}><Link href={paths[key]}>{key}</Link> · {data.total.toLocaleString()}</h2>
          <h3>Current status</h3><Bars rows={data.byStatus.map((r) => ({ ...r, label: key === 'reports' && r.label === 'resolved' ? 'Awaiting confirmation' : key === 'reports' && r.label === 'closed' ? 'Completed' : r.label }))} />
          {key === 'reports' && <>
            <p>Overdue follow-ups: <strong>{data.overdue}</strong> · Unassigned: <strong>{data.unassigned}</strong></p>
            <p>Median acknowledgment: {data.medianAcknowledgeHours == null ? 'Unknown' : `${data.medianAcknowledgeHours.toFixed(1)} hours`} ({data.acknowledgedSample} known timestamps)</p>
          </>}
          {key === 'patrols' && <>
            <p>Completed in 30 days: <strong>{data.completed30d}</strong></p>
            <p>Recorded distance: {data.distanceM30d == null ? 'Unknown' : `${(data.distanceM30d / 1000).toFixed(2)} km`} · {data.unknownDistance30d} completed patrols without distance</p>
            <p>Outstanding stop follow-ups: <strong>{data.outstandingStops}</strong></p>
          </>}
          <h3>{key === 'patrols' ? 'Patrol mode' : 'Category'}</h3><Bars rows={data.byCategory} />
          <details><summary>Created per day · last 30 days</summary><Bars rows={data.dailyCreated} /></details>
          <details><summary>Ward totals</summary><Bars rows={data.byWard} /></details>
          <h3>Recently updated</h3>
          {data.recent.length ? <ul>{data.recent.map((item) => <li key={item.id}>
            {item.wardCode || 'Unassigned'} · {item.status.replace(/_/g, ' ')} · {new Date(item.updatedAt).toLocaleDateString()}
          </li>)}</ul> : <p>No recorded activity.</p>}
        </article>;
      })}
    </div>
  </section>;
}
