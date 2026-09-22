'use client';

import { useEffect, useState } from 'react';
import { api, dataReadError } from '../../../lib/api';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmSmallButton, downloadCsv, fmtDateTime,
} from '../../../components/crm/ui';

/**
 * CRM Escalations — SLA breaches, stuck cases and overdue work queue.
 */
export default function CrmEscalations() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ attempt: number; data: Awaited<ReturnType<typeof api.crmEscalations>> | null; error: string | null }>({
    attempt: -1, data: null, error: null,
  });
  const load = () => setAttempt((n) => n + 1);
  useEffect(() => {
    let active = true;
    api.crmEscalations().then((data) => {
      if (active) setState({ attempt, data, error: null });
    }).catch((error: unknown) => {
      if (active) setState({ attempt, data: null, error: dataReadError(error) });
    });
    return () => { active = false; };
  }, [attempt]);
  const data = state.attempt === attempt ? state.data : null;
  const error = state.attempt === attempt ? state.error : null;
  const loading = !data && !error;

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
            disabled={!data}
            onClick={() => data &&
              downloadCsv(
                'escalations',
                ['Ref', 'Title', 'Ward', 'Status', 'Reason', 'SLA Due', 'Created'],
                data.items.map((i) => [i.refNo ?? '', i.title ?? '', i.wardCode ?? '', i.status ?? '', i.escalationReason ?? '', i.slaDueAt ?? '', i.createdAt ?? '']),
              )
            }
          >
            Export CSV
          </CrmSmallButton>
        }
      />

      <CrmSmallButton disabled={loading} onClick={load}>{error ? 'Retry' : 'Refresh'}</CrmSmallButton>
      {data && <CrmStatGrid
        stats={[
          { label: 'SLA Breaches', value: data.items.filter((i) => i.escalationReason === 'sla_breach').length, tone: 'danger' },
          { label: 'Stuck >30 Days', value: data.items.filter((i) => i.escalationReason === 'stuck').length, tone: 'warn' },
          { label: 'Overdue', value: data.items.filter((i) => i.escalationReason === 'overdue').length, tone: 'warn' },
          { label: 'Total Queue', value: data.total },
        ]}
      />}

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading escalations…</p>
      ) : error ? <p role="alert">{error}</p> : data && (
        <CrmTable
          columns={['Ref No', 'Title', 'Ward', 'Status', 'Reason', 'SLA Due', 'Age', 'Actions']}
          rows={data.items.map((i) => [
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
          empty="No cases match this escalation queue in your authorized scope."
        />
      )}
    </div>
  );
}
