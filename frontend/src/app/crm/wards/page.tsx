'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmSmallButton, downloadCsv,
} from '../../../components/crm/ui';

/**
 * CRM Wards — ward directory with live scorecards: member counts,
 * case volumes, resolution rates and councillor assignments.
 */

interface WardRow {
  code: string;
  name: string;
  members: number;
  cases: number;
  open: number;
  resolved: number;
  councillor: string;
}

export default function CrmWards() {
  const [rows, setRows] = useState<WardRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.geoBoundaries('ward').catch(() => ({ features: [] as any[] })),
      api.crmMembers({ limit: '500' }).catch(() => ({ items: [] as any[] })),
      api.crmEngagements({ limit: '500' }).catch(() => ({ items: [] as any[] })),
      api.crmListUsers({ role: 'ward_councillor', limit: '100' }).catch(() => ({ items: [] as any[] })),
    ]).then(([geo, members, cases, councillors]) => {
      const memberCounts = new Map<string, number>();
      (members.items ?? []).forEach((m: any) => {
        const w = m.ward ?? 'UNASSIGNED';
        memberCounts.set(w, (memberCounts.get(w) ?? 0) + 1);
      });

      const caseStats = new Map<string, { total: number; open: number; resolved: number }>();
      (cases.items ?? []).forEach((c: any) => {
        const w = c.wardCode ?? 'UNASSIGNED';
        const s = caseStats.get(w) ?? { total: 0, open: 0, resolved: 0 };
        s.total += 1;
        if (['resolved', 'verified', 'closed'].includes(c.status)) s.resolved += 1;
        else s.open += 1;
        caseStats.set(w, s);
      });

      const councillorByWard = new Map<string, string>();
      (councillors.items ?? []).forEach((u: any) => {
        if (u.wardCode) councillorByWard.set(u.wardCode, u.email);
      });

      const wardRows: WardRow[] = (geo.features ?? []).map((f: any) => {
        const code = f.properties?.code ?? f.id ?? 'UNKNOWN';
        const name = f.properties?.name ?? code;
        const cs = caseStats.get(code) ?? { total: 0, open: 0, resolved: 0 };
        return {
          code,
          name,
          members: memberCounts.get(code) ?? 0,
          cases: cs.total,
          open: cs.open,
          resolved: cs.resolved,
          councillor: councillorByWard.get(code) ?? 'Unassigned',
        };
      });

      wardRows.sort((a, b) => b.cases - a.cases);
      setRows(wardRows);
    }).finally(() => setLoading(false));
  }, []);

  const totalMembers = rows.reduce((s, r) => s + r.members, 0);
  const totalCases = rows.reduce((s, r) => s + r.cases, 0);
  const unassigned = rows.filter((r) => r.councillor === 'Unassigned').length;

  return (
    <div>
      <CrmPageHeader
        title="Wards"
        subtitle="Ward directory with live scorecards and councillor assignments."
        actions={
          <CrmSmallButton
            onClick={() =>
              downloadCsv(
                'ward-scorecards',
                ['Ward Code', 'Ward', 'Members', 'Cases', 'Open', 'Resolved', 'Councillor'],
                rows.map((r) => [r.code, r.name, r.members, r.cases, r.open, r.resolved, r.councillor]),
              )
            }
          >
            Export Scorecards
          </CrmSmallButton>
        }
      />

      <CrmStatGrid
        stats={[
          { label: 'Wards', value: rows.length },
          { label: 'Members Mapped', value: totalMembers },
          { label: 'Cases Logged', value: totalCases },
          { label: 'Wards Without Councillor', value: unassigned, tone: unassigned ? 'warn' : 'success' },
        ]}
      />

      {loading ? (
        <p style={{ color: '#64748b' }}>Computing ward scorecards…</p>
      ) : (
        <CrmTable
          columns={['Ward', 'Members', 'Cases', 'Open', 'Resolved', 'Resolution Rate', 'Councillor']}
          rows={rows.map((r) => [
            <span key="w"><strong>{r.name}</strong> <code style={{ marginLeft: 6 }}>{r.code}</code></span>,
            r.members,
            r.cases,
            r.open,
            r.resolved,
            r.cases ? `${Math.round((r.resolved / r.cases) * 100)}%` : '—',
            r.councillor === 'Unassigned'
              ? <span style={{ color: '#d97706' }}>Unassigned</span>
              : r.councillor,
          ])}
          empty="No ward boundaries loaded."
        />
      )}
    </div>
  );
}
