'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { CrmPageHeader, CrmStatGrid, CrmTable, CrmSmallButton, downloadCsv } from '../../../components/crm/ui';
import type { JobDemand } from '../../../types';

/**
 * CRM Work Demand — aggregate ward work-demand dashboard (PRD-jobs FR-L).
 * HARD RULE: no names, emails or personal data ever shown to staff.
 */
export default function CrmWorkDemand() {
  const [demand, setDemand] = useState<JobDemand | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.listJobDemand().then(setDemand).catch(() => setDemand(null)).finally(() => setLoading(false));
  }, []);

  const max = demand ? Math.max(1, ...demand.byWorkType.map((b) => b.count)) : 1;
  const maxTrend = demand ? Math.max(1, ...demand.trend.map((t) => t.count)) : 1;

  const stats: Array<{ label: string; value: string | number; tone?: 'default' | 'danger' | 'success' | 'warn' }> = demand
    ? [
        { label: 'People Looking', value: demand.total },
        { label: 'Available Now', value: demand.availableNow, tone: demand.availableNow > 0 ? 'success' : 'default' },
        { label: 'Work Types', value: demand.byWorkType.length },
        { label: 'Scope', value: demand.scope === 'all' ? 'All wards' : `${demand.scope.length} wards` },
      ]
    : [];

  function exportCsv() {
    if (!demand) return;
    downloadCsv(
      'work-demand',
      ['Work Type', 'Count'],
      demand.byWorkType.map((b) => [b.label, b.count]),
    );
  }

  return (
    <div>
      <CrmPageHeader
        title="Work Demand"
        subtitle="Aggregate ward work-demand — no personal data is ever shown to staff."
        actions={<CrmSmallButton onClick={exportCsv}>Export CSV</CrmSmallButton>}
      />

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading demand data…</p>
      ) : demand ? (
        <>
          <CrmStatGrid stats={stats} />

          <div style={{ marginBottom: 20, padding: 20, background: '#fff', border: '1px solid #ece5e1', borderRadius: 8 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>By type of work</h3>
            {demand.byWorkType.length === 0 ? (
              <p style={{ color: '#8a817b', fontSize: 14 }}>No active interests registered yet.</p>
            ) : (
              demand.byWorkType.map((b) => (
                <div key={b.code} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={{ width: 160, fontSize: 13, color: '#57534e' }}>{b.label}</span>
                  <div style={{ flex: 1, height: 8, background: '#f6f3f1', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${(b.count / max) * 100}%`, background: '#c8102e', borderRadius: 4 }} />
                  </div>
                  <span style={{ width: 30, textAlign: 'right', fontWeight: 600, fontSize: 13 }}>{b.count}</span>
                </div>
              ))
            )}
          </div>

          {demand.trend.length > 1 && (
            <div style={{ marginBottom: 20, padding: 20, background: '#fff', border: '1px solid #ece5e1', borderRadius: 8 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>30-day trend</h3>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 60 }}>
                {demand.trend.map((t) => (
                  <div
                    key={t.day}
                    title={`${t.day}: ${t.count}`}
                    style={{
                      flex: 1,
                      height: `${(t.count / maxTrend) * 100}%`,
                      minHeight: 3,
                      background: '#c8102e',
                      borderRadius: 3,
                      opacity: 0.8,
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 20 }}>
            <p style={{ margin: 0, fontSize: 13, color: '#991b1b', fontWeight: 500 }}>
              <strong>Privacy note:</strong> This dashboard shows aggregate counts only. No member names, emails or contact details are ever exposed to staff. Share these counts with project companies entering the ward to brief them on available labour.
            </p>
          </div>

          <CrmTable
            columns={['Work Type', 'Count']}
            rows={demand.byWorkType.map((b) => [b.label, b.count])}
            empty="No active interests registered yet."
          />
        </>
      ) : (
        <p style={{ color: '#64748b' }}>Could not load demand data.</p>
      )}
    </div>
  );
}
