'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../../../lib/api';
import {
  CrmBadge, CrmFilters, CrmModal, CrmPageHeader, CrmSmallButton, CrmStatGrid,
  CrmTable, downloadCsv, fmtDate,
} from '../../../components/crm/ui';
import type { LineageView, ReportRow, ReportView, TreeNode, TreeView } from '../../../types';

/**
 * CRM Recruitment — the ranked growth report and its genealogy drill-down
 * (PRD-growth FR-O6 / FR-O4 / FR-O5).
 *
 * The report ranks originators (ward councillors first) by the recruitment trees
 * they originate; "View tree" opens the branch (FR-O4) and any node can be
 * traced back to its first source (FR-O5).
 *
 * HARD PRIVACY RULE (AC-O2): this screen shows member PUBLIC CODES, tiers,
 * wards, join dates and aggregate counts only. No names, emails or phone numbers
 * are ever fetched or rendered. The one human name that can appear is a PUBLIC
 * ward-councillor `displayName` the transparency module already publishes — the
 * API never returns a sealed `fullName`, so there is nothing here to leak.
 */

/** Best public label for a node/row — councillor name, else the public code. */
function label(displayName: string | null, publicCode: string | null, id: string): string {
  return displayName ?? publicCode ?? `${id.slice(0, 8)}…`;
}

export default function CrmRecruitment() {
  const [report, setReport] = useState<ReportView | null>(null);
  const [loading, setLoading] = useState(true);
  const [ward, setWard] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Tree drill-down (FR-O4) + lineage trace (FR-O5) modal state.
  const [treeFor, setTreeFor] = useState<ReportRow | null>(null);
  const [tree, setTree] = useState<TreeView | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [depth, setDepth] = useState(8);
  const [lineage, setLineage] = useState<LineageView | null>(null);
  const [lineageLoading, setLineageLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .getRecruitmentReport({ ward: ward || undefined, limit: 200 })
      .then((r) => {
        setReport(r);
        setError(null);
      })
      .catch((e: { message?: string }) => {
        setReport(null);
        setError(e?.message ?? 'Could not load the recruitment report.');
      })
      .finally(() => setLoading(false));
  }, [ward]);

  useEffect(() => {
    load();
  }, [load]);

  // (Re)fetch the subtree whenever the opened originator or the depth cap changes.
  useEffect(() => {
    if (!treeFor) return;
    setTreeLoading(true);
    api
      .getRecruitmentTree({ root: treeFor.originatorId, depth })
      .then(setTree)
      .catch(() => setTree(null))
      .finally(() => setTreeLoading(false));
  }, [treeFor, depth]);

  function openTree(row: ReportRow) {
    setTreeFor(row);
    setTree(null);
    setLineage(null);
  }

  function traceToSource(memberId: string) {
    setLineageLoading(true);
    api
      .getRecruitmentLineage(memberId)
      .then(setLineage)
      .catch(() => setLineage(null))
      .finally(() => setLineageLoading(false));
  }

  function exportCsv() {
    if (!report) return;
    downloadCsv(
      'recruitment-report',
      ['Originator', 'Public Code', 'Ward', 'Type', 'Direct', 'Downline', 'Depth', 'Active', 'Pending', '+30d', '+90d'],
      report.rows.map((r) => [
        label(r.displayName, r.publicCode, r.originatorId),
        r.publicCode ?? '',
        r.ward ?? '',
        r.isCouncillor ? 'Councillor' : 'Member',
        r.direct,
        r.downline,
        r.treeDepth,
        r.activeRecruits,
        r.pendingRecruits,
        r.growth30d,
        r.growth90d,
      ]),
    );
  }

  const stats = report
    ? [
        { label: 'Originators', value: report.totals.originators },
        { label: 'Ward Councillors', value: report.totals.councillors, tone: 'success' as const },
        { label: 'Direct Recruits', value: report.totals.direct },
        { label: 'Total Downline', value: report.totals.downline, tone: 'warn' as const },
      ]
    : [];

  return (
    <div>
      <CrmPageHeader
        title="Recruitment"
        subtitle={`Who signed up whom — ranked originator trees${report ? ` · scope: ${report.scope}` : ''}.`}
        actions={<CrmSmallButton onClick={exportCsv} disabled={!report}>Export CSV</CrmSmallButton>}
      />

      <CrmFilters>
        <input
          type="text"
          value={ward}
          placeholder="Filter by ward code (e.g. CPT-W009)"
          onChange={(e) => setWard(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load();
          }}
        />
        <CrmSmallButton onClick={load}>Apply</CrmSmallButton>
        {ward && (
          <CrmSmallButton
            onClick={() => {
              setWard('');
            }}
          >
            Clear
          </CrmSmallButton>
        )}
      </CrmFilters>

      {error && (
        <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 20 }}>
          <p style={{ margin: 0, fontSize: 13, color: '#991b1b', fontWeight: 500 }}>{error}</p>
        </div>
      )}

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading recruitment report…</p>
      ) : report ? (
        <>
          <CrmStatGrid stats={stats} />

          <div style={{ padding: 16, background: '#f6f3f1', border: '1px solid #ece5e1', borderRadius: 8, marginBottom: 20 }}>
            <p style={{ margin: 0, fontSize: 13, color: '#57534e' }}>
              <strong>Privacy note:</strong> this report shows reference codes and aggregate counts only — never member
              names, emails or contact details. A ward councillor&apos;s public name may appear where they are a published
              leader. Select <strong>View tree</strong> to see how a branch grew, then trace any node back to its first
              source.
            </p>
          </div>

          <CrmTable
            columns={['Originator', 'Ward', 'Type', 'Direct', 'Downline', 'Depth', 'Active', 'Pending', '+30d', '+90d', '']}
            rows={report.rows.map((r) => [
              <span key="o" style={{ fontWeight: 600 }}>{label(r.displayName, r.publicCode, r.originatorId)}</span>,
              r.ward ? <code key="w">{r.ward}</code> : '—',
              r.isCouncillor ? <CrmBadge key="t" value="councillor" /> : <span key="t" style={{ color: '#8a817b' }}>member</span>,
              r.direct,
              <strong key="d">{r.downline}</strong>,
              r.treeDepth,
              r.activeRecruits,
              r.pendingRecruits,
              r.growth30d,
              r.growth90d,
              <CrmSmallButton key="v" onClick={() => openTree(r)}>View tree</CrmSmallButton>,
            ])}
            empty="No recruitment attributed yet — members registered without a resolvable referrer do not appear here."
          />
        </>
      ) : (
        !error && <p style={{ color: '#64748b' }}>Could not load the recruitment report.</p>
      )}

      {treeFor && (
        <CrmModal
          wide
          title={`Recruitment tree · ${label(treeFor.displayName, treeFor.publicCode, treeFor.originatorId)}`}
          onClose={() => setTreeFor(null)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 13, color: '#8a817b' }}>
              Depth cap{' '}
              <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} style={{ padding: '6px 8px' }}>
                {[4, 6, 8, 10, 12, 16].map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </label>
            {tree && (
              <span style={{ fontSize: 13, color: '#57534e' }}>
                {tree.totalNodes} member{tree.totalNodes === 1 ? '' : 's'} below · max depth {tree.maxDepth}
                {tree.truncated ? ' · truncated at cap' : ''}
              </span>
            )}
          </div>

          {treeLoading ? (
            <p style={{ color: '#64748b' }}>Loading tree…</p>
          ) : tree && tree.nodes.length ? (
            <div style={{ border: '1px solid #ece5e1', borderRadius: 8, padding: 12, maxHeight: '46vh', overflowY: 'auto' }}>
              {renderTree(tree.nodes, traceToSource)}
            </div>
          ) : (
            <p style={{ color: '#8a817b' }}>This originator has no downline within the depth cap.</p>
          )}

          {lineageLoading && <p style={{ color: '#64748b', marginTop: 16 }}>Tracing to source…</p>}
          {lineage && !lineageLoading && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>
                Traced to source ({lineage.depth} hop{lineage.depth === 1 ? '' : 's'})
              </h3>
              <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#57534e' }}>
                {lineage.chain.map((n) => (
                  <li key={n.memberId} style={{ marginBottom: 4 }}>
                    <strong>{label(n.displayName, n.publicCode, n.memberId)}</strong>
                    {n.ward ? <code style={{ marginLeft: 6 }}>{n.ward}</code> : null}
                    <span style={{ color: '#8a817b', marginLeft: 6 }}>· joined {fmtDate(n.joinedAt)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </CrmModal>
      )}
    </div>
  );
}

/**
 * Render the flat, depth-ordered node list as an indented tree (FR-O4 — the
 * "leaves" perspective). Children are nested under their `parentId`; each row
 * carries a Trace action that walks the node up to its first source (FR-O5).
 */
function renderTree(nodes: TreeNode[], onTrace: (memberId: string) => void): ReactNode {
  const byParent = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    if (n.parentId) {
      const list = byParent.get(n.parentId) ?? [];
      list.push(n);
      byParent.set(n.parentId, list);
    }
  }
  const roots = nodes.filter((n) => n.depth === 0);

  const walk = (node: TreeNode): ReactNode => {
    const kids = byParent.get(node.memberId) ?? [];
    return (
      <div key={node.memberId}>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0',
            borderBottom: '1px solid #f6f3f1', flexWrap: 'wrap',
          }}
        >
          <span style={{ fontWeight: node.depth === 0 ? 700 : 500, fontSize: 13 }}>
            {label(node.displayName, node.publicCode, node.memberId)}
          </span>
          <CrmBadge value={node.status} />
          <span style={{ fontSize: 11, color: '#8a817b', textTransform: 'uppercase', letterSpacing: 0.4 }}>{node.tier}</span>
          {node.ward ? <code style={{ fontSize: 11 }}>{node.ward}</code> : null}
          <span style={{ fontSize: 12, color: '#57534e', marginLeft: 'auto' }}>
            {node.directReferrals} direct · {node.downline} downline
          </span>
          <CrmSmallButton onClick={() => onTrace(node.memberId)}>Trace</CrmSmallButton>
        </div>
        {kids.length > 0 && (
          <div style={{ marginLeft: 16, paddingLeft: 12, borderLeft: '2px solid #f0e9e5' }}>{kids.map(walk)}</div>
        )}
      </div>
    );
  };

  return <div>{roots.map(walk)}</div>;
}
