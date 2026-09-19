'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../../lib/auth';
import { api } from '../../../lib/api';
import { permissionLabel } from '../../../lib/caps';
import {
  CrmPageHeader, CrmCard, CrmBadge, CrmButton, CrmTable,
} from '../../../components/crm/ui';
import JobsAdminSettings from '../../../components/crm/JobsAdminSettings';
import ModuleRegistrySettings from '../../../components/crm/ModuleRegistrySettings';
import IdCardStudio from '../../../components/crm/IdCardStudio';
import type { MediaPolicy } from '../../../types';

/**
 * CRM Settings — security posture, active session, role/permission matrix
 * and audit-chain health for the desktop admin surface.
 */

function MediaPolicySettings() {
  const [policy, setPolicy] = useState<MediaPolicy | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.mediaPolicy().then((p) => { setPolicy(p); setError(''); }).catch(() => setError('Could not load media controls.'));
  useEffect(() => { void load(); }, []);
  const toggle = async (kind: keyof MediaPolicy) => {
    if (!policy || busy) return;
    setBusy(true); setError('');
    try { setPolicy(await api.setMediaPolicy({ ...policy, [kind]: !policy[kind] })); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save media controls.'); }
    finally { setBusy(false); }
  };
  return <CrmCard title="Photo, video, and voice controls">
    <p>Applies to new attachments across reports, cases, and patrols. Existing authorized attachments remain viewable. Text reporting stays enabled.</p>
    {error && <p role="alert">{error} <button onClick={load}>Retry</button></p>}
    {!policy && !error && <p>Loading media controls…</p>}
    {policy && <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
      {(['photo','video','voice'] as const).map((kind) => <label key={kind}>
        <input type="checkbox" checked={policy[kind]} disabled={busy} onChange={() => toggle(kind)} /> {kind} uploads
      </label>)}
    </div>}
  </CrmCard>;
}

const ROLES = [
  'national_admin', 'regional_organizer', 'local_coordinator',
  'ward_councillor', 'analyst', 'member',
];

const SECURITY_CONTROLS = [
  { control: 'Sealed PII encryption', detail: 'Email/phone/address encrypted at rest; decrypt requires member:pii_decrypt and writes an audit entry.', status: 'enforced' },
  { control: 'Hash-chained audit log', detail: 'Every privileged action is linked by prev_hash/entry_hash (SHA-256) for tamper evidence.', status: 'enforced' },
  { control: 'Role-based access control', detail: '39 permissions mapped across 6 roles; CRM surface requires overview:read.', status: 'enforced' },
  { control: 'JWT access + refresh rotation', detail: 'Short-lived access token with rotating refresh token; identity re-derived on swap.', status: 'enforced' },
  { control: 'Consent management', detail: 'Member consent captured and revocable; gated by consent:manage.', status: 'enforced' },
  { control: 'Argon2 password hashing', detail: 'Passwords hashed with Argon2id; plaintext never stored or logged.', status: 'enforced' },
];

export default function CrmSettings() {
  const { role, email, regionCodes, logout } = useAuth();
  const router = useRouter();
  const [perms, setPerms] = useState<Record<string, string[]>>({});
  const [loadingPerms, setLoadingPerms] = useState(true);
  const [audit, setAudit] = useState<{ ok: boolean; checked: number; brokenAtSeq?: number } | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    Promise.all(ROLES.map((r) => api.crmGetRolePermissions(r).catch(() => ({ role: r, permissions: [] as string[] }))))
      .then((results) => {
        const map: Record<string, string[]> = {};
        results.forEach((res) => { map[res.role] = res.permissions ?? []; });
        setPerms(map);
      })
      .finally(() => setLoadingPerms(false));
  }, []);

  const verifyChain = async () => {
    setChecking(true);
    try {
      const res = await api.verifyAudit();
      setAudit(res);
    } catch {
      setAudit({ ok: false, checked: 0 });
    } finally {
      setChecking(false);
    }
  };

  const doLogout = async () => {
    await logout();
    router.replace('/login');
  };

  const totalPerms = new Set(Object.values(perms).flat()).size;

  return (
    <div>
      <CrmPageHeader
        title="Settings"
        subtitle="Security posture, active session, roles and system integrity."
      />

      <CrmCard title="Active Session">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>Signed in as</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{email ?? '—'}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>Role</div>
            <div style={{ marginTop: 4 }}>{role ? <CrmBadge value={role} /> : '—'}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>Region scope</div>
            <div style={{ fontSize: 15 }}>{regionCodes?.length ? regionCodes.join(', ') : 'National'}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <CrmButton variant="danger" onClick={doLogout}>Sign Out</CrmButton>
          </div>
        </div>
      </CrmCard>

      <CrmCard title="Audit Chain Integrity">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <CrmButton variant="secondary" onClick={verifyChain} disabled={checking}>
            {checking ? 'Verifying…' : 'Run Integrity Check'}
          </CrmButton>
          {audit && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CrmBadge value={audit.ok ? 'verified' : 'sla_breach'} />
              <span style={{ fontSize: 14 }}>
                {audit.ok
                  ? `${audit.checked} entries verified — chain intact.`
                  : `Verification failed${audit.brokenAtSeq ? ` at seq #${audit.brokenAtSeq}` : ''}.`}
              </span>
            </span>
          )}
        </div>
      </CrmCard>

      <CrmCard title="Security Controls">
        <CrmTable
          columns={['Control', 'Detail', 'State']}
          rows={SECURITY_CONTROLS.map((c) => [
            <strong key="c">{c.control}</strong>,
            <span key="d" style={{ fontSize: 13, color: '#374151' }}>{c.detail}</span>,
            <CrmBadge key="s" value={c.status} />,
          ])}
        />
      </CrmCard>

      <CrmCard title={`Role & Permission Matrix${totalPerms ? ` · ${totalPerms} distinct permissions` : ''}`}>
        {loadingPerms ? (
          <p style={{ color: '#64748b' }}>Loading permissions…</p>
        ) : (
          <CrmTable
            columns={['Role', 'Permissions', 'Count']}
            rows={ROLES.map((r) => {
              const list = perms[r] ?? [];
              return [
                <CrmBadge key="r" value={r} />,
                <span key="p" style={{ fontSize: 12, color: '#374151' }}>
                  {list.length ? list.map(permissionLabel).join('; ') : '—'}
                </span>,
                <strong key="c">{list.length}</strong>,
              ];
            })}
            empty="No permission data available."
          />
        )}
      </CrmCard>

      {role === 'national_admin' && <JobsAdminSettings />}

      {role === 'national_admin' && <ModuleRegistrySettings />}
      {role === 'national_admin' && <MediaPolicySettings />}

      {role === 'national_admin' && <IdCardStudio />}

      <CrmCard title="Data & Privacy">
        <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.7 }}>
          <p style={{ margin: '0 0 8px' }}>
            <strong>Retention:</strong> Service-delivery cases and audit entries are retained indefinitely for
            accountability; personal data is minimised to what each role requires.
          </p>
          <p style={{ margin: '0 0 8px' }}>
            <strong>Export:</strong> Every CRM list view supports CSV export. Member exports containing sealed PII
            require <code>member:export</code> and are recorded in the audit log.
          </p>
          <p style={{ margin: 0 }}>
            <strong>Right to be forgotten:</strong> Member deletion is a soft-lapse by default; hard deletion is a
            privileged, audited action available from the Members page.
          </p>
        </div>
      </CrmCard>
    </div>
  );
}