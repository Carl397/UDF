'use client';

import { useEffect, useState } from 'react';
import { api, ApiClientError } from '../../../lib/api';
import {
  CrmPageHeader, CrmCard, CrmTable, CrmBadge, CrmFilters, CrmPagination,
  CrmModal, CrmField, CrmButton, CrmSmallButton, fmtDate, fmtDateTime,
} from '../../../components/crm/ui';
import type {
  ModerationUser, ModerationProfile, BannedDevice, ModerationActionType,
} from '../../../types';

/**
 * CRM Moderation — the enforcement back-office for the ban/suspend ladder,
 * Terms & Conditions status and device bans (Phase 4).
 *
 * National-admin only (MODERATE_USERS). Every action requires a reason and is
 * written to `moderation_actions` and the hash-chained audit log; suspend/ban
 * also revoke live sessions and bump `token_version` so enforcement is
 * immediate rather than waiting out the access-token TTL.
 */

const ROLES = ['national_admin', 'regional_organizer', 'local_coordinator', 'ward_councillor', 'analyst', 'member'];
const STATUSES = ['active', 'warned', 'suspended', 'banned'];
const LIMIT = 20;

const labelize = (r: string) => r.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

interface ActionTarget {
  kind: 'user' | 'device';
  id: string;
  action: ModerationActionType;
  label: string;
}

const ACTION_BLURB: Record<ModerationActionType, string> = {
  warn: 'Records a formal warning. The account keeps working; the warning is visible to moderators and written to the audit log.',
  suspend: 'Immediately signs the user out (live sessions revoked) and blocks login until the suspension ends.',
  ban: 'Disables the account, revokes all sessions and blocks login. Reversible only by reinstating.',
  reinstate: 'Restores the account to active and lifts any suspension or ban.',
  device_ban: 'Blocks login and registration from this device id.',
  device_unban: 'Lifts the ban on this device id.',
};

/** Effective badge value: a disabled-but-not-banned account reads as inactive. */
function statusOf(u: ModerationUser): string {
  return u.moderationStatus === 'active' && !u.isActive ? 'inactive' : u.moderationStatus;
}

export default function CrmModeration() {
  const [users, setUsers] = useState<ModerationUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState({ search: '', status: '', role: '' });
  const [page, setPage] = useState(0);

  const [devices, setDevices] = useState<BannedDevice[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionTarget | null>(null);
  const [banDevice, setBanDevice] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const load = async (p: number) => {
    setLoading(true);
    const params: Record<string, string | number> = { limit: LIMIT, offset: p * LIMIT };
    if (filter.role) params.role = filter.role;
    if (filter.status) params.status = filter.status;
    if (filter.search) params.search = filter.search;
    try {
      const r = await api.moderationUsers(params);
      setUsers(r.items);
      setTotal(r.total);
      setDenied(false);
    } catch (e) {
      setUsers([]);
      setTotal(0);
      if (e instanceof ApiClientError && e.status === 403) setDenied(true);
    } finally {
      setLoading(false);
    }
  };

  const loadDevices = async () => {
    try {
      const r = await api.moderationDevices();
      setDevices(r.items);
    } catch {
      setDevices([]);
    }
  };

  useEffect(() => {
    load(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, page]);

  useEffect(() => {
    loadDevices();
  }, [refreshToken]);

  const afterAction = () => {
    setAction(null);
    load(page);
    setRefreshToken((t) => t + 1);
  };

  const userAction = (u: ModerationUser, a: ModerationActionType): ActionTarget => ({
    kind: 'user',
    id: u.id,
    action: a,
    label: `${labelize(a)} · ${u.email ?? u.fullName ?? u.id.slice(0, 8)}`,
  });

  return (
    <div>
      <CrmPageHeader
        title="Moderation"
        subtitle="Enforce the warn / suspend / ban ladder, review Terms acceptance and audit history, and manage device bans. Every action needs a reason and is tamper-evidently logged."
        actions={<CrmButton variant="danger" onClick={() => setBanDevice(true)}>Ban a device</CrmButton>}
      />

      {denied ? (
        <CrmCard title="Access restricted">
          <p style={{ color: '#8a817b', margin: 0 }}>
            Moderation requires the <strong>MODERATE_USERS</strong> permission (national admin).
            Your role does not grant it, so this surface is read-only-blocked.
          </p>
        </CrmCard>
      ) : (
        <>
          <CrmFilters>
            <input
              type="text"
              placeholder="Search by exact email…"
              value={filter.search}
              onChange={(e) => { setFilter({ ...filter, search: e.target.value }); setPage(0); }}
            />
            <select value={filter.status} onChange={(e) => { setFilter({ ...filter, status: e.target.value }); setPage(0); }}>
              <option value="">All Statuses</option>
              {STATUSES.map((s) => (<option key={s} value={s}>{labelize(s)}</option>))}
            </select>
            <select value={filter.role} onChange={(e) => { setFilter({ ...filter, role: e.target.value }); setPage(0); }}>
              <option value="">All Roles</option>
              {ROLES.map((r) => (<option key={r} value={r}>{labelize(r)}</option>))}
            </select>
          </CrmFilters>

          {loading ? (
            <p style={{ color: '#64748b' }}>Loading accounts…</p>
          ) : (
            <CrmTable
              columns={['Member', 'Role', 'Status', 'Terms', 'Suspended until', '']}
              rows={users.map((u) => {
                const st = statusOf(u);
                const locked = st === 'banned' || st === 'suspended' || !u.isActive;
                return [
                  <span key="m">
                    <div style={{ fontWeight: 600 }}>{u.email ?? '—'}</div>
                    {u.fullName && <div style={{ fontSize: 12, color: '#8a817b' }}>{u.fullName}</div>}
                  </span>,
                  labelize(u.role),
                  <CrmBadge key="s" value={st} />,
                  u.tcVersion
                    ? <span key="tc"><CrmBadge value="accepted" /> <span style={{ fontSize: 12, color: '#8a817b' }}>v{u.tcVersion} · {fmtDate(u.tcAcceptedAt)}</span></span>
                    : <span key="tc" style={{ color: '#8a817b', fontSize: 13 }}>Not accepted</span>,
                  u.suspendedUntil ? fmtDate(u.suspendedUntil) : '—',
                  <span key="a" style={{ whiteSpace: 'nowrap' }}>
                    <CrmSmallButton onClick={() => setProfileId(u.id)}>View</CrmSmallButton>
                    {locked ? (
                      <CrmSmallButton onClick={() => setAction(userAction(u, 'reinstate'))}>Reinstate</CrmSmallButton>
                    ) : (
                      <>
                        <CrmSmallButton onClick={() => setAction(userAction(u, 'warn'))}>Warn</CrmSmallButton>
                        <CrmSmallButton onClick={() => setAction(userAction(u, 'suspend'))}>Suspend</CrmSmallButton>
                        <CrmSmallButton danger onClick={() => setAction(userAction(u, 'ban'))}>Ban</CrmSmallButton>
                      </>
                    )}
                  </span>,
                ];
              })}
              empty="No accounts match the current filters."
            />
          )}

          <CrmPagination page={page} totalPages={Math.ceil(total / LIMIT)} total={total} onPage={setPage} />

          <CrmCard title="Banned devices">
            {devices.length === 0 ? (
              <p style={{ color: '#8a817b', margin: 0, fontSize: 14 }}>
                No devices have been banned yet. A device ban blocks login and registration from a
                mobile install, keyed by its stable <code>x-device-id</code>.
              </p>
            ) : (
              <CrmTable
                columns={['Device id', 'Reason', 'State', 'Banned by', 'Updated', '']}
                rows={devices.map((d) => [
                  <code key="id" style={{ fontSize: 12 }}>{d.deviceId}</code>,
                  d.reason,
                  <CrmBadge key="st" value={d.active ? 'banned' : 'inactive'} />,
                  d.bannedBy ? d.bannedBy.slice(0, 8) : '—',
                  fmtDateTime(d.updatedAt),
                  d.active
                    ? <CrmSmallButton key="a" onClick={() => setAction({ kind: 'device', id: d.deviceId, action: 'device_unban', label: `Lift device ban · ${d.deviceId.slice(0, 12)}` })}>Lift ban</CrmSmallButton>
                    : <span key="a" style={{ color: '#8a817b', fontSize: 13 }}>—</span>,
                ])}
              />
            )}
          </CrmCard>
        </>
      )}

      {profileId && (
        <ProfileModal
          id={profileId}
          refreshToken={refreshToken}
          onClose={() => setProfileId(null)}
          onAction={setAction}
        />
      )}
      {action && <ActionModal target={action} onClose={() => setAction(null)} onApplied={afterAction} />}
      {banDevice && (
        <BanDeviceModal
          onClose={() => setBanDevice(false)}
          onApplied={() => { setBanDevice(false); setRefreshToken((t) => t + 1); }}
        />
      )}
    </div>
  );
}

/* ── Profile: status + T&C + moderation history + audit trail ─────── */
function ProfileModal({
  id,
  refreshToken,
  onClose,
  onAction,
}: {
  id: string;
  refreshToken: number;
  onClose: () => void;
  onAction: (t: ActionTarget) => void;
}) {
  const [profile, setProfile] = useState<ModerationProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .moderationProfile(id)
      .then((p) => { if (alive) setProfile(p); })
      .catch((e: any) => { if (alive) setErr(e?.message ?? 'Could not load the profile'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [id, refreshToken]);

  const u = profile?.user;
  const act = (a: ModerationActionType) =>
    u && onAction({ kind: 'user', id: u.id, action: a, label: `${labelize(a)} · ${u.email ?? u.id.slice(0, 8)}` });
  const locked = u ? (u.moderationStatus === 'banned' || u.moderationStatus === 'suspended' || !u.isActive) : false;

  return (
    <CrmModal title="Moderation profile" onClose={onClose} wide>
      {loading && <p style={{ color: '#64748b' }}>Loading profile…</p>}
      {err && <p style={{ color: '#c8102e' }}>{err}</p>}
      {u && (
        <>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{u.email ?? '—'}</div>
            <div style={{ fontSize: 13, color: '#8a817b' }}>
              {u.fullName ?? 'No name'} · {labelize(u.role)}
              {u.wardCode ? ` · Ward ${u.wardCode}` : ''}
              {u.regionCodes?.length ? ` · ${u.regionCodes.join(', ')}` : ' · National'}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 18 }}>
            <Fact label="Status"><CrmBadge value={statusOf(u)} /></Fact>
            <Fact label="Account">{u.isActive ? 'Enabled' : 'Disabled'}</Fact>
            <Fact label="Suspended until">{u.suspendedUntil ? fmtDateTime(u.suspendedUntil) : '—'}</Fact>
            <Fact label="Terms accepted">
              {u.tcVersion ? `v${u.tcVersion} · ${fmtDate(u.tcAcceptedAt)}` : 'Not accepted'}
            </Fact>
            <Fact label="Joined">{fmtDate(u.createdAt)}</Fact>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 22 }}>
            {locked ? (
              <CrmButton variant="secondary" onClick={() => act('reinstate')}>Reinstate</CrmButton>
            ) : (
              <>
                <CrmButton variant="secondary" onClick={() => act('warn')}>Warn</CrmButton>
                <CrmButton variant="secondary" onClick={() => act('suspend')}>Suspend</CrmButton>
                <CrmButton variant="danger" onClick={() => act('ban')}>Ban</CrmButton>
              </>
            )}
          </div>

          <h3 style={sectionHead}>Moderation history</h3>
          <CrmTable
            columns={['Action', 'Reason', 'By', 'Expires', 'When']}
            rows={(profile?.actions ?? []).map((a) => [
              <CrmBadge key="a" value={a.action} />,
              a.reason,
              a.actorRole ? labelize(a.actorRole) : '—',
              a.expiresAt ? fmtDate(a.expiresAt) : '—',
              fmtDateTime(a.createdAt),
            ])}
            empty="No moderation actions recorded for this account."
          />

          <h3 style={{ ...sectionHead, marginTop: 22 }}>Audit trail</h3>
          <CrmTable
            columns={['Seq', 'Action', 'Target', 'By', 'When']}
            rows={(profile?.audit ?? []).map((r) => [
              r.seq,
              r.action,
              r.targetType ? `${r.targetType}` : '—',
              r.actorRole ? labelize(r.actorRole) : '—',
              fmtDateTime(r.createdAt),
            ])}
            empty="No audit entries reference this account."
          />
        </>
      )}
    </CrmModal>
  );
}

const sectionHead: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#8a817b',
  margin: '0 0 10px',
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid #ece5e1', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: '#8a817b', marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{children}</div>
    </div>
  );
}

/* ── Apply one action (reason required; suspend needs a length) ───── */
function ActionModal({
  target,
  onClose,
  onApplied,
}: {
  target: ActionTarget;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(7);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isSuspend = target.action === 'suspend';
  const danger = target.action === 'ban' || target.action === 'suspend' || target.action === 'device_ban';

  const submit = async () => {
    if (reason.trim().length < 5) {
      setErr('Give a reason of at least 5 characters — it is written to the audit log.');
      return;
    }
    if (isSuspend && (!days || days < 1 || days > 3650)) {
      setErr('Suspension length must be between 1 and 3650 days.');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await api.applyModerationAction({
        ...(target.kind === 'user' ? { userId: target.id } : { deviceId: target.id }),
        action: target.action,
        reason: reason.trim(),
        ...(isSuspend ? { durationDays: days } : {}),
      });
      onApplied();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not apply the action');
    } finally {
      setSaving(false);
    }
  };

  return (
    <CrmModal title={target.label} onClose={onClose}>
      <p style={{ fontSize: 13, color: '#57534e', lineHeight: 1.55, margin: '0 0 16px' }}>
        {ACTION_BLURB[target.action]}
      </p>
      <CrmField label="Reason (recorded in the tamper-evident audit log)">
        <textarea
          rows={3}
          value={reason}
          maxLength={1000}
          placeholder="Repeated abusive submissions after two warnings…"
          onChange={(e) => setReason(e.target.value)}
        />
      </CrmField>
      {isSuspend && (
        <CrmField label="Suspension length (days)">
          <input
            type="number"
            min={1}
            max={3650}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          />
        </CrmField>
      )}
      {err && <div style={{ color: '#c8102e', fontSize: 13, marginBottom: 12 }}>{err}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 8 }}>
        <CrmButton variant="secondary" onClick={onClose}>Cancel</CrmButton>
        <CrmButton variant={danger ? 'danger' : 'primary'} onClick={submit} disabled={saving}>
          {saving ? 'Applying…' : `Apply ${labelize(target.action)}`}
        </CrmButton>
      </div>
    </CrmModal>
  );
}

/* ── Ban a device by id ─────────────────────────────────────────── */
function BanDeviceModal({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const [deviceId, setDeviceId] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (deviceId.trim().length < 4) { setErr('Enter the device id.'); return; }
    if (reason.trim().length < 5) { setErr('Give a reason of at least 5 characters.'); return; }
    setSaving(true);
    setErr(null);
    try {
      await api.applyModerationAction({
        deviceId: deviceId.trim(),
        action: 'device_ban',
        reason: reason.trim(),
      });
      onApplied();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not ban the device');
    } finally {
      setSaving(false);
    }
  };

  return (
    <CrmModal title="Ban a device" onClose={onClose}>
      <p style={{ fontSize: 13, color: '#57534e', lineHeight: 1.55, margin: '0 0 16px' }}>
        {ACTION_BLURB.device_ban} The id is the mobile install&apos;s stable <code>x-device-id</code>.
      </p>
      <CrmField label="Device id">
        <input
          type="text"
          value={deviceId}
          maxLength={128}
          placeholder="e.g. 6f1c…-android"
          onChange={(e) => setDeviceId(e.target.value)}
        />
      </CrmField>
      <CrmField label="Reason (recorded in the audit log)">
        <textarea
          rows={3}
          value={reason}
          maxLength={1000}
          placeholder="Automated abuse from a single install…"
          onChange={(e) => setReason(e.target.value)}
        />
      </CrmField>
      {err && <div style={{ color: '#c8102e', fontSize: 13, marginBottom: 12 }}>{err}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 8 }}>
        <CrmButton variant="secondary" onClick={onClose}>Cancel</CrmButton>
        <CrmButton variant="danger" onClick={submit} disabled={saving}>{saving ? 'Banning…' : 'Ban device'}</CrmButton>
      </div>
    </CrmModal>
  );
}
