'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmSmallButton, downloadCsv, fmtDateTime,
} from '../../../components/crm/ui';

/**
 * CRM Ratings — 1-5 scale feedback on councillor work, cases and projects.
 * Ratings ≤2 carry a mandatory improvement reason.
 */
export default function CrmRatings() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listRatings({ limit: '200' })
      .then((r: { items: any[] }) => setItems(r.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  const avg = items.length ? items.reduce((s, i) => s + Number(i.score ?? 0), 0) / items.length : 0;
  const low = items.filter((i) => Number(i.score) <= 2);

  const stars = (n: number) => '★'.repeat(Math.round(Number(n))) + '☆'.repeat(5 - Math.round(Number(n)));

  return (
    <div>
      <CrmPageHeader
        title="Ratings"
        subtitle="Member feedback on councillor work, cases and projects (1-5 scale)."
        actions={
          <CrmSmallButton
            onClick={() =>
              downloadCsv(
                'ratings',
                ['Target Type', 'Target', 'Score', 'Reason', 'Created'],
                items.map((i) => [i.targetType ?? '', i.targetId ?? '', i.score ?? '', i.reason ?? '', i.createdAt ?? '']),
              )
            }
          >
            Export CSV
          </CrmSmallButton>
        }
      />

      <CrmStatGrid
        stats={[
          { label: 'Total Ratings', value: items.length },
          { label: 'Average Score', value: avg.toFixed(2), tone: avg >= 3.5 ? 'success' : 'warn' },
          { label: 'Low Ratings (≤2)', value: low.length, tone: low.length ? 'danger' : 'default' },
        ]}
      />

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading ratings…</p>
      ) : (
        <CrmTable
          columns={['Score', 'Target', 'Target ID', 'Improvement Reason', 'Submitted']}
          rows={items.map((i) => [
            <span key="s" style={{ color: Number(i.score) <= 2 ? '#C8102E' : '#16a34a', fontWeight: 700 }}>
              {stars(i.score)} {i.score}
            </span>,
            i.targetType ?? '—',
            <code key="t">{(i.targetId ?? '—').slice(0, 8)}</code>,
            i.reason ? <em key="r" style={{ color: '#991b1b' }}>{i.reason}</em> : '—',
            fmtDateTime(i.createdAt),
          ])}
          empty="No ratings recorded yet."
        />
      )}
    </div>
  );
}
