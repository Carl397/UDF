'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import Link from 'next/link';
import ActivityDashboard from '../../components/crm/ActivityDashboard';
import type { DashboardActivity } from '../../types';

/**
 * CRM Dashboard — high-level metrics, escalation queue, recent activity.
 * Desktop-first, dense data display.
 */

export default function CrmDashboard() {
  const [stats, setStats] = useState({
    activeMembers: 0,
    openCases: 0,
    openPetitions: 0,
    openParticipations: 0,
  });
  const [escalations, setEscalations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [escalationError, setEscalationError] = useState('');
  const [activity, setActivity] = useState<DashboardActivity | null>(null);

  useEffect(() => {
    Promise.all([
      api.crmDashboard(),
      api.crmEscalations().catch(() => { setEscalationError('Escalations unavailable'); return null; }),
    ])
      .then(([dashboard, escalations]) => {
        setStats(dashboard);
        setActivity(dashboard.activity);
        setEscalations(escalations?.items ?? []);
      })
      .catch(() => setError('Dashboard data could not be loaded. No totals are available.'))
      .finally(() => setLoading(false));
  }, []);

  if (error) return <div role="alert">{error} <button onClick={() => window.location.reload()}>Retry</button></div>;
  return (
    <div className="crm-dashboard">
      <div className="crm-metrics">
        <MetricCard label="Active Members" value={stats.activeMembers} href="/crm/members" loading={loading} />
        <MetricCard label="Open Cases" value={stats.openCases} href="/crm/engagements" loading={loading} />
        <MetricCard label="Open Petitions" value={stats.openPetitions} href="/crm/petitions" loading={loading} />
        <MetricCard label="Participations" value={stats.openParticipations} href="/crm/participations" loading={loading} />
      </div>

      <div className="crm-section">
        <h2>Escalations</h2>
        {escalationError ? <p role="alert">{escalationError}</p> : loading ? <p>Loading…</p> : escalations.length === 0 ? (
          <div className="crm-empty">
            <p>No SLA breaches or overdue cases.</p>
            <Link href="/crm/escalations" className="crm-link">
              View escalations →
            </Link>
          </div>
        ) : (
          <div>
            <p>{escalations.length} case{escalations.length !== 1 ? 's' : ''} require attention.</p>
            <Link href="/crm/escalations" className="crm-link">
              View escalations →
            </Link>
          </div>
        )}
      </div>

      {activity && <ActivityDashboard activity={activity} />}

      <style jsx>{`
        .crm-dashboard {
          max-width: 1200px;
        }
        .crm-metrics {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 20px;
          margin-bottom: 32px;
        }
        .crm-section {
          background: #fff;
          border: 1px solid #ece5e1;
          border-radius: 8px;
          padding: 24px;
          margin-bottom: 24px;
        }
        .crm-section h2 {
          font-size: 16px;
          font-weight: 600;
          color: #1c1917;
          margin: 0 0 16px;
        }
        .crm-empty {
          color: #8a817b;
          font-size: 14px;
        }
        :global(.crm-link) {
          color: #c8102e;
          text-decoration: none;
          font-weight: 500;
          margin-left: 8px;
        }
        :global(.crm-link:hover) {
          text-decoration: underline;
        }
      `}</style>
    </div>
  );
}

function MetricCard({ label, value, href, loading }: { label: string; value: number; href: string; loading: boolean }) {
  return (
    <Link href={href} className="crm-metric">
      <div className="crm-metric-value">{loading ? '—' : value.toLocaleString()}</div>
      <div className="crm-metric-label">{label}</div>
      <style jsx>{`
        :global(.crm-metric) {
          background: #fff;
          border: 1px solid #ece5e1;
          border-radius: 8px;
          padding: 24px;
          text-decoration: none;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        :global(.crm-metric:hover) {
          border-color: #c8102e;
          box-shadow: 0 2px 8px rgba(200, 16, 46, 0.08);
        }
        .crm-metric-value {
          font-size: 32px;
          font-weight: 700;
          color: #1c1917;
          margin-bottom: 8px;
        }
        .crm-metric-label {
          font-size: 13px;
          color: #8a817b;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
      `}</style>
    </Link>
  );
}
