'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmSmallButton, downloadCsv, fmtDateTime,
} from '../../../components/crm/ui';

/**
 * CRM Escalations — SLA breaches, stuck cases and overdue work queue.
 */
export default function CrmEscalations() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api
      .crmEscalations()
      .then((r: { items: any[] }) => setItems(r.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const counts = {
    sla_breach: items.filter((i) => i.escalationReason === 'sla_breach').length,
    stuck: items.filter((i) => i.escalationReason === 'stuck').length,
    overdue: items.filter((i) => i.escalationReason === 'overdue').length,
  };

  const escalate = async (id: string) => {
    try {
      await api.updateServiceRequest(id, { status: 'triaged' });
      load();
    } catch {
      alert('Failed to action case.');
    }
  };

  return (
    <div>
      <CrmPageHeader
        title="Escalations"
        subtitle="Cases breaching SLA, stuck in progress, or overdue for action."
        actions={
          <CrmSmallButton
            onClick={() =>
              downloadCsv(
                'escalations',
                ['Ref', 'Title', 'Ward', 'Status', 'Reason', 'SLA Due', 'Created'],
                items.map((i) => [i.refNo ?? '', i.title ?? '', i.wardCode ?? '', i.status ?? '', i.escalationReason ?? '', i.slaDueAt ?? '', i.createdAt ?? '']),
              )
            }
          >
            Export CSV
          </CrmSmallButton>
        }
      />

      <CrmStatGrid
        stats={[
          { label: 'SLA Breaches', value: counts.sla_breach, tone: 'danger' },
          { label: 'Stuck >30 Days', value: counts.stuck, tone: 'warn' },
          { label: 'Overdue', value: counts.overdue, tone: 'warn' },
          { label: 'Total Queue', value: items.length },
        ]}
      />

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading escalations…</p>
      ) : (
        <CrmTable
          columns={['Ref No', 'Title', 'Ward', 'Status', 'Reason', 'SLA Due', 'Age', 'Actions']}
          rows={items.map((i) => [
            <code key="r">{i.refNo ?? '—'}</code>,
            i.title ?? '—',
            i.wardCode ?? '—',
            <CrmBadge key="s" value={i.status} />,
            <CrmBadge key="e" value={i.escalationReason} />,
            fmtDateTime(i.slaDueAt),
            `${Math.floor((Date.now() - new Date(i.createdAt).getTime()) / 86400000)}d`,
            <span key="a">
              <CrmSmallButton onClick={() => escalate(i.id)}>Re-triage</CrmSmallButton>
            </span>,
          ])}
          empty="No escalations — all cases are within SLA."
        />
      )}
    </div>
  );
}
