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

/**
 * What the councillor column says for a ward no councillor account references.
 * One constant so the table, the CSV export and the "nothing assigned" count can
 * never drift into three different wordings of the same fact.
 */
const NO_CANDIDATE = 'No UDF candidate at LGE2026';

interface WardRow {
  code: string;
  name: string;
  members: number;
  cases: number;
  open: number;
  resolved: number;
  councillor: string;
  /**
   * False when no councillor account references this ward at all. After LGE2026
   * that means UDF stood no candidate here, which is a fact about the election,
   * not an admin task — unlike a linked account that is merely disabled or not
   * yet published. Collapsing the two is what made this screen shout
   * "Unassigned" about wards that were never ours to contest.
   */
  linked: boolean;
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

      // A councillor is linked to EVERY ward they cover, not just their primary.
      // `ward_codes` is the multi-ward list (migration 051); reading only
      // `wardCode` here listed each councillor once and left three-quarters of
      // the metro's wards claiming to have nobody assigned.
      const councillorByWard = new Map<string, { label: string; active: boolean }>();
      const contestedWards = new Set<string>();
      (councillors.items ?? []).forEach((u: any) => {
        const codes: string[] = u.wardCodes?.length
          ? u.wardCodes
          : u.wardCode
            ? [u.wardCode]
            : [];
        const active = u.isActive !== false;
        const label = `${u.fullName || u.email || 'Councillor'}${active ? '' : ' (account disabled)'}`;
        for (const code of codes) {
          contestedWards.add(code);
          const seen = councillorByWard.get(code);
          // An active account wins the cell; a disabled one only shows where
          // nothing better exists for that ward.
          if (!seen || (active && !seen.active)) councillorByWard.set(code, { label, active });
        }
      });

      const wardRows: WardRow[] = (geo.features ?? []).map((f: any) => {
        const code = f.properties?.code ?? f.id ?? 'UNKNOWN';
        const name = f.properties?.name ?? code;
        const cs = caseStats.get(code) ?? { total: 0, open: 0, resolved: 0 };
        const linked = contestedWards.has(code);
        return {
          code,
          name,
          members: memberCounts.get(code) ?? 0,
          cases: cs.total,
          open: cs.open,
          resolved: cs.resolved,
          councillor: councillorByWard.get(code)?.label ?? NO_CANDIDATE,
          linked,
        };
      });

      wardRows.sort((a, b) => b.cases - a.cases);
      setRows(wardRows);
    }).finally(() => setLoading(false));
  }, []);

  const totalMembers = rows.reduce((s, r) => s + r.members, 0);
  const totalCases = rows.reduce((s, r) => s + r.cases, 0);
  // Not "wards needing an admin" — wards UDF never contested. Both LGE2026
  // exceptions (Wards 61 and 66) are here, and the certified result cannot be
  // edited, so this tile is a footnote about the election rather than a warning.
  const uncontested = rows.filter((r) => !r.linked).length;

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
          { label: 'Wards UDF Did Not Contest', value: uncontested },
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
            r.linked
              ? r.councillor
              : <span style={{ color: '#64748b' }} title="The certified LGE2026 candidate list has no UDF candidate for this ward.">{NO_CANDIDATE}</span>,
          ])}
          empty="No ward boundaries loaded."
        />
      )}
    </div>
  );
}
