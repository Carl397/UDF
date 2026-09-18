'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmSmallButton, downloadCsv, fmtDateTime,
} from '../../../components/crm/ui';

/**
 * CRM Verifications — workmanship confirmations submitted by members
 * after a case is resolved (evidence over assertion).
 */
export default function CrmVerifications() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listVerifications({ limit: '200' })
      .then((r: { items: any[] }) => setItems(r.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  const approved = items.filter((i) => i.result === 'approved' || i.result === 'pass').length;
  const failed = items.filter((i) => i.result === 'failed' || i.result === 'reject').length;

  return (
    <div>
      <CrmPageHeader
        title="Verifications"
        subtitle="Member-submitted workmanship checks on closed service cases."
        actions={
          <CrmSmallButton
            onClick={() =>
              downloadCsv(
                'verifications',
                ['Case', 'Verifier', 'Result', 'Notes', 'Created'],
                items.map((i) => [i.serviceRequestId ?? '', i.verifierMemberId ?? '', i.result ?? '', i.notes ?? '', i.createdAt ?? '']),
              )
            }
          >
            Export CSV
          </CrmSmallButton>
        }
      />

      <CrmStatGrid
        stats={[
          { label: 'Total Verifications', value: items.length },
          { label: 'Passed', value: approved, tone: 'success' },
          { label: 'Failed', value: failed, tone: 'danger' },
          { label: 'Pending Review', value: items.length - approved - failed, tone: 'warn' },
        ]}
      />

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading verifications…</p>
      ) : (
        <CrmTable
          columns={['Case ID', 'Verifier (Member)', 'Result', 'Notes', 'Submitted']}
          rows={items.map((i) => [
            <code key="c">{(i.serviceRequestId ?? '—').slice(0, 8)}</code>,
            <code key="v">{(i.verifierMemberId ?? '—').slice(0, 8)}</code>,
            <CrmBadge key="r" value={i.result ?? 'pending'} />,
            i.notes ?? '—',
            fmtDateTime(i.createdAt),
          ])}
          empty="No verifications recorded yet."
        />
      )}
    </div>
  );
}
