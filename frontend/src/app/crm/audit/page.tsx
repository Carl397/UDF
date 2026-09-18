'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import {
  CrmPageHeader, CrmStatGrid, CrmTable, CrmBadge, CrmModal, CrmCard,
  CrmButton, CrmSmallButton, CrmFilters, CrmPagination, downloadCsv, fmtDateTime,
} from '../../../components/crm/ui';

/**
 * CRM Audit Log — tamper-evident, hash-chained audit trail viewer.
 * Filters by action and actor role; verify chain integrity on demand.
 */

interface AuditRow {
  seq: number;
  id: string;
  prev_hash: string;
  entry_hash: string;
  action: string;
  actor_id: string | null;
  actor_role: string | null;
  target_type: string | null;
  target_id: string | null;
  region_code: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

const ACTIONS = [
  'member.create', 'member.update', 'member.verify',
  'service_request.create', 'service_request.update', 'service_request.close',
  'auth.login', 'auth.logout', 'role.change', 'post.takedown', 'bulletin.publish',
];

export default function CrmAudit() {
  const [items, setItems] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [action, setAction] = useState('');
  const [actorRole, setActorRole] = useState('');
  const [detail, setDetail] = useState<AuditRow | null>(null);
  const [verifyState, setVerifyState] = useState<{ checking: boolean; result?: { ok: boolean; checked: number; brokenAtSeq?: number } }>({ checking: false });
  const limit = 50;

  const load = () => {
    setLoading(true);
    const params: Record<string, string> = { limit: limit.toString(), offset: (page * limit).toString() };
    if (action) params.action = action;
    if (actorRole) params.actorRole = actorRole;
    api
      .crmAudit(params)
      .then((r: { items: AuditRow[]; total: number }) => {
        setItems(r.items ?? []);
        setTotal(r.total ?? 0);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [page, action, actorRole]);

  const verifyChain = async () => {
    setVerifyState({ checking: true });
    try {
      const res = await api.verifyAudit();
      setVerifyState({ checking: false, result: res });
    } catch {
      setVerifyState({ checking: false, result: { ok: false, checked: 0 } });
    }
  };

  const totalPages = Math.ceil(total / limit);
  const distinctActions = new Set(items.map((i) => i.action)).size;

  return (
    <div>
      <CrmPageHeader
        title="Audit Log"
        subtitle="Tamper-evident, hash-chained record of every privileged action."
        actions={
          <CrmButton variant="secondary" onClick={verifyChain} disabled={verifyState.checking}>
            {verifyState.checking ? 'Verifying…' : 'Verify Chain Integrity'}
          </CrmButton>
        }
      />

      {verifyState.result && (
        <CrmCard>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CrmBadge value={verifyState.result.ok ? 'verified' : 'sla_breach'} />
            <span style={{ fontSize: 14 }}>
              {verifyState.result.ok
                ? `Audit chain is intact — ${verifyState.result.checked} entries verified, every hash matches its predecessor.`
                : `Chain verification failed${verifyState.result.brokenAtSeq ? ` at seq #${verifyState.result.brokenAtSeq}` : ''}. The log may have been tampered with.`}
            </span>
          </div>
        </CrmCard>
      )}

      <CrmStatGrid
        stats={[
          { label: 'Total Entries', value: total.toLocaleString() },
          { label: 'On This Page', value: items.length },
          { label: 'Distinct Actions', value: distinctActions },
        ]}
      />

      <CrmFilters>
        <select value={action} onChange={(e) => { setAction(e.target.value); setPage(0); }}>
          <option value="">All actions</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select value={actorRole} onChange={(e) => { setActorRole(e.target.value); setPage(0); }}>
          <option value="">All roles</option>
          <option value="national_admin">national_admin</option>
          <option value="regional_organizer">regional_organizer</option>
          <option value="local_coordinator">local_coordinator</option>
          <option value="ward_councillor">ward_councillor</option>
          <option value="member">member</option>
        </select>
        <CrmSmallButton
          onClick={() =>
            downloadCsv(
              'audit-log',
              ['Seq', 'Action', 'Actor Role', 'Target', 'Region', 'IP', 'Created', 'Entry Hash'],
              items.map((i) => [i.seq, i.action, i.actor_role ?? '', `${i.target_type ?? ''}:${i.target_id ?? ''}`, i.region_code ?? '', i.ip ?? '', i.created_at ?? '', i.entry_hash ?? '']),
            )
          }
        >
          Export CSV
        </CrmSmallButton>
      </CrmFilters>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading audit log…</p>
      ) : (
        <CrmTable
          columns={['Seq', 'Action', 'Actor', 'Target', 'Region', 'When', '']}
          rows={items.map((i) => [
            <span key="s" style={{ fontFamily: 'monospace', color: '#64748b' }}>#{i.seq}</span>,
            <CrmBadge key="a" value={i.action} />,
            <span key="ac" style={{ fontSize: 13 }}>{i.actor_role ?? 'system'}{i.ip && <><br /><span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{i.ip}</span></>}</span>,
            <span key="t" style={{ fontSize: 13 }}>{i.target_type ? `${i.target_type}` : '—'}{i.target_id && <><br /><span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{i.target_id.slice(0, 8)}</span></>}</span>,
            i.region_code ?? '—',
            <span key="w" style={{ fontSize: 13 }}>{fmtDateTime(i.created_at)}</span>,
            <CrmSmallButton key="v" onClick={() => setDetail(i)}>Inspect</CrmSmallButton>,
          ])}
          empty="No audit entries match these filters."
        />
      )}

      <CrmPagination page={page} totalPages={totalPages} total={total} onPage={setPage} />

      {detail && (
        <CrmModal title={`Audit Entry #${detail.seq}`} onClose={() => setDetail(null)} wide>
          <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, fontSize: 14, marginBottom: 16 }}>
            <strong>Action</strong><span><CrmBadge value={detail.action} /></span>
            <strong>Actor role</strong><span>{detail.actor_role ?? 'system'}</span>
            <strong>Actor ID</strong><span style={{ fontFamily: 'monospace' }}>{detail.actor_id ?? '—'}</span>
            <strong>Target</strong><span>{detail.target_type ?? '—'} {detail.target_id ? `· ${detail.target_id}` : ''}</span>
            <strong>Region</strong><span>{detail.region_code ?? '—'}</span>
            <strong>IP</strong><span style={{ fontFamily: 'monospace' }}>{detail.ip ?? '—'}</span>
            <strong>User agent</strong><span style={{ fontSize: 12, color: '#64748b' }}>{detail.user_agent ?? '—'}</span>
            <strong>Created</strong><span>{fmtDateTime(detail.created_at)}</span>
          </div>
          <CrmCard title="Hash Chain">
            <div style={{ fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>
              <div style={{ marginBottom: 6 }}><span style={{ color: '#64748b' }}>prev_hash:</span> {detail.prev_hash}</div>
              <div><span style={{ color: '#64748b' }}>entry_hash:</span> {detail.entry_hash}</div>
            </div>
          </CrmCard>
          {detail.metadata && (
            <CrmCard title="Metadata">
              <pre style={{ fontSize: 12, background: '#f9f9f9', padding: 12, borderRadius: 6, overflow: 'auto', margin: 0 }}>
                {JSON.stringify(detail.metadata, null, 2)}
              </pre>
            </CrmCard>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <CrmSmallButton onClick={() => setDetail(null)}>Close</CrmSmallButton>
          </div>
        </CrmModal>
      )}
    </div>
  );
}
