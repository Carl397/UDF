'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, API_BASE, tokenStore } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { Perm } from '../../../lib/caps';
import { AVATAR_UPLOAD_MAX, IMPORT_MAX, formatBytes } from '../../../lib/uploadLimits';
import {
  CrmPageHeader, CrmCard, CrmTable, CrmBadge, CrmFilters, CrmPagination,
  CrmModal, CrmField, CrmButton, CrmSmallButton, downloadCsv, fmtDate,
} from '../../../components/crm/ui';

/**
 * CRM Users & Roles — system user (staff) management: provisioning, role
 * assignment, per-person permission overrides, profile photo/bio/title, region
 * scoping, CSV bulk import, activation and audited password resets.
 * Email is sealed at rest, so search is an exact-match lookup.
 */

const ROLES = ['national_admin', 'regional_organizer', 'local_coordinator', 'ward_councillor', 'analyst', 'member'];
const LIMIT = 20;

const labelize = (r: string) => r.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
const parseRegions = (s: string) => s.split(',').map((x: string) => x.trim()).filter(Boolean);

/**
 * The permission vocabulary, grouped for editing. The names come from `Perm`
 * (lib/caps.ts), which `scripts/check-caps.mjs` proves matches the server's
 * `backend/src/auth/permissions.ts` in both directions — a server-side rename
 * therefore fails the build instead of silently dropping a checkbox.
 */
const PERMISSION_GROUPS: { area: string; perms: string[] }[] = [
  {
    area: 'Members',
    perms: [Perm.MEMBER_READ, Perm.MEMBER_WRITE, Perm.MEMBER_DELETE, Perm.PII_DECRYPT, Perm.MEMBER_EXPORT, Perm.CONSENT_MANAGE],
  },
  {
    area: 'Service delivery',
    perms: [
      Perm.CASE_READ, Perm.CASE_LOG, Perm.CASE_UPDATE, Perm.CASE_CLOSE, Perm.CASE_ESCALATE,
      Perm.ENGAGEMENT_WRITE, Perm.BULLETIN_READ, Perm.BULLETIN_WRITE, Perm.PATROL_READ, Perm.PATROL_WRITE,
    ],
  },
  {
    area: 'Engagement',
    perms: [Perm.EVENT_WRITE, Perm.POST_WRITE, Perm.POST_MODERATE, Perm.NOTIFY_WRITE, Perm.APPOINT_WRITE],
  },
  {
    area: 'Participation',
    perms: [Perm.PARTICIPATION_WRITE, Perm.PARTICIPATION_COMMENT, Perm.RATING_WRITE, Perm.VERIFY_WRITE],
  },
  {
    area: 'Jobs',
    perms: [Perm.JOBS_INTEREST_WRITE, Perm.JOBS_DEMAND_READ, Perm.JOBS_OPPORTUNITY_WRITE, Perm.JOBS_ADMIN],
  },
  {
    area: 'Administration',
    perms: [Perm.OVERVIEW_READ, Perm.GEO_READ, Perm.AUDIT_READ, Perm.REPORT_GENERATE, Perm.ROLE_MANAGE, Perm.MODERATE_USERS],
  },
];

/** Readable names for the permissions whose raw string reads like a schema. */
const PERM_LABELS: Record<string, string> = {
  [Perm.PII_DECRYPT]: 'Decrypt sealed PII',
  [Perm.POST_MODERATE]: 'Take down posts',
  [Perm.APPOINT_WRITE]: 'Appoint to positions',
  [Perm.VERIFY_WRITE]: 'Verify party ID cards',
  [Perm.JOBS_INTEREST_WRITE]: 'Register job interest',
  [Perm.JOBS_DEMAND_READ]: 'Read ward work-demand',
  [Perm.JOBS_OPPORTUNITY_WRITE]: 'Post opportunities',
  [Perm.JOBS_ADMIN]: 'Jobs administration',
  [Perm.MODERATE_USERS]: 'Ban / suspend ladder',
};

const permLabel = (p: string) =>
  PERM_LABELS[p] ?? (p.split(':')[1] ?? p).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

interface UserShape {
  id: string;
  email: string | null;
  fullName: string | null;
  role: string;
  regionCodes: string[];
  wardCode: string | null;
  isActive: boolean;
  createdAt: string;
  permissionGrants: string[];
  permissionRevokes: string[];
  avatarMediaId: string | null;
  bio: string | null;
  title: string | null;
}

export default function CrmUsers() {
  const { permissions } = useAuth();
  const [users, setUsers] = useState<UserShape[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState({ role: '', search: '' });
  const [page, setPage] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editUser, setEditUser] = useState<UserShape | null>(null);
  const [rolePerms, setRolePerms] = useState<Record<string, string[]>>({});

  const load = async (p: number) => {
    setLoading(true);
    const params: Record<string, string> = { limit: LIMIT.toString(), offset: (p * LIMIT).toString() };
    if (filter.role) params.role = filter.role;
    if (filter.search) params.search = filter.search;
    try {
      const r = await api.crmListUsers(params);
      setUsers(r.items);
      setTotal(r.total);
    } catch {
      setUsers([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, page]);

  useEffect(() => {
    Promise.all(
      ROLES.map((role) => api.crmGetRolePermissions(role).catch(() => ({ role, permissions: [] as string[] }))),
    ).then((results) => {
      const perms: Record<string, string[]> = {};
      results.forEach((r) => { perms[r.role] = r.permissions; });
      setRolePerms(perms);
    });
  }, []);

  const exportCsv = () => {
    downloadCsv(
      'users',
      ['Email', 'Full Name', 'Title', 'Role', 'Ward', 'Region Scope', 'Added Permissions', 'Removed Permissions', 'Status', 'Created'],
      users.map((u) => [
        u.email ?? '', u.fullName ?? '', u.title ?? '', u.role, u.wardCode ?? '',
        u.regionCodes?.length ? u.regionCodes.join('; ') : 'National',
        (u.permissionGrants ?? []).join('; '), (u.permissionRevokes ?? []).join('; '),
        u.isActive ? 'active' : 'disabled', u.createdAt,
      ]),
    );
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this user? This cannot be undone.')) return;
    try {
      await api.crmDeleteUser(id);
      load(page);
    } catch {
      alert('Failed to delete user');
    }
  };

  const handleResetPassword = async (id: string) => {
    const newPassword = prompt('Enter new password (min 10 characters):');
    if (!newPassword) return;
    try {
      await api.crmResetPassword(id, newPassword);
      alert('Password reset — recorded in the audit log.');
    } catch {
      alert('Failed to reset password');
    }
  };

  return (
    <div>
      <CrmPageHeader
        title="Users & Roles"
        subtitle="Provision staff accounts, assign roles, tune permissions per person and publish councillor profiles. Every change is written to the tamper-evident audit log."
        actions={
          <>
            <CrmButton variant="secondary" onClick={exportCsv}>Export CSV</CrmButton>
            <CrmButton variant="secondary" onClick={() => setShowImport(true)}>Import CSV</CrmButton>
            <CrmButton onClick={() => setShowCreate(true)}>+ Create User</CrmButton>
          </>
        }
      />

      <CrmFilters>
        <input
          type="text"
          placeholder="Search by exact email…"
          value={filter.search}
          onChange={(e) => { setFilter({ ...filter, search: e.target.value }); setPage(0); }}
        />
        <select value={filter.role} onChange={(e) => { setFilter({ ...filter, role: e.target.value }); setPage(0); }}>
          <option value="">All Roles</option>
          {ROLES.map((r) => (<option key={r} value={r}>{labelize(r)}</option>))}
        </select>
      </CrmFilters>

      {loading ? (
        <p style={{ color: '#64748b' }}>Loading users…</p>
      ) : (
        <CrmTable
          columns={['Email', 'Name', 'Role', 'Access', 'Ward', 'Region Scope', 'Status', 'Created', '']}
          rows={users.map((u) => [
            u.email ?? '—',
            <span key="n" style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
              <AvatarThumb mediaId={u.avatarMediaId} name={u.fullName ?? u.email ?? '?'} />
              <span>
                <span style={{ display: 'block' }}>{u.fullName ?? '—'}</span>
                {u.title && (
                  <span style={{ display: 'block', fontSize: 11.5, color: '#8a817b' }}>{u.title}</span>
                )}
              </span>
            </span>,
            labelize(u.role),
            <OverrideBadge key="o" grants={u.permissionGrants ?? []} revokes={u.permissionRevokes ?? []} />,
            u.wardCode ?? '—',
            u.regionCodes?.length ? u.regionCodes.join(', ') : 'National',
            <CrmBadge key="s" value={u.isActive ? 'active' : 'inactive'} />,
            fmtDate(u.createdAt),
            <span key="a" style={{ whiteSpace: 'nowrap' }}>
              <CrmSmallButton onClick={() => setEditUser(u)}>Edit</CrmSmallButton>
              <CrmSmallButton onClick={() => handleResetPassword(u.id)}>Reset PW</CrmSmallButton>
              <CrmSmallButton danger onClick={() => handleDelete(u.id)}>Delete</CrmSmallButton>
            </span>,
          ])}
          empty="No users match the current filters."
        />
      )}

      <CrmPagination page={page} totalPages={Math.ceil(total / LIMIT)} total={total} onPage={setPage} />

      <CrmCard title="Role Permissions">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
          {ROLES.map((role) => (
            <div key={role} style={{ border: '1px solid #e5e5e5', borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{labelize(role)}</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#64748b' }}>
                {(rolePerms[role] ?? []).map((p) => (<li key={p}>{p}</li>))}
              </ul>
            </div>
          ))}
        </div>
      </CrmCard>

      {showCreate && (
        <CreateUserModal
          rolePerms={rolePerms}
          held={permissions}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); setPage(0); load(0); }}
        />
      )}
      {showImport && (
        <ImportUsersModal
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); setPage(0); load(0); }}
        />
      )}
      {editUser && (
        <EditUserModal
          user={editUser}
          rolePerms={rolePerms}
          held={permissions}
          onClose={() => setEditUser(null)}
          onSaved={() => { setEditUser(null); load(page); }}
        />
      )}
    </div>
  );
}

function CreateUserModal({ rolePerms, held, onClose, onCreated }: {
  rolePerms: Record<string, string[]>;
  held: readonly string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    email: '', password: '', role: 'member', fullName: '', regionCodes: '', wardCode: '',
    title: '', bio: '',
  });
  const [overrides, setOverrides] = useState({ grants: [] as string[], revokes: [] as string[] });
  const [avatarMediaId, setAvatarMediaId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!form.email || !form.password || !form.role) {
      alert('Email, password and role are required.');
      return;
    }
    setSaving(true);
    try {
      await api.crmCreateUser({
        email: form.email,
        password: form.password,
        role: form.role,
        fullName: form.fullName || undefined,
        regionCodes: parseRegions(form.regionCodes),
        wardCode: form.wardCode || null,
        permissionGrants: overrides.grants,
        permissionRevokes: overrides.revokes,
        avatarMediaId,
        bio: form.bio.trim() || null,
        title: form.title.trim() || null,
      });
      onCreated();
    } catch (e: any) {
      alert(e?.message ?? 'Failed to create user — the email may already exist.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <CrmModal title="Create User" onClose={onClose} wide>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 18px' }}>
        <CrmField label="Email">
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </CrmField>
        <CrmField label="Full Name">
          <input type="text" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
        </CrmField>
        <CrmField label="Password">
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Min 10 characters" />
        </CrmField>
        <CrmField label="Role">
          <select
            value={form.role}
            onChange={(e) => {
              // Switching role re-bases the permission set, so any tuning done
              // against the previous role is dropped rather than silently kept.
              setForm({ ...form, role: e.target.value });
              setOverrides({ grants: [], revokes: [] });
            }}
          >
            {ROLES.map((r) => (<option key={r} value={r}>{labelize(r)}</option>))}
          </select>
        </CrmField>
        <CrmField label="Region Codes (comma-separated, blank = national)">
          <input type="text" value={form.regionCodes} onChange={(e) => setForm({ ...form, regionCodes: e.target.value })} placeholder="e.g. CPT-SC1, CPT-SC2" />
        </CrmField>
        <CrmField label="Ward Code (optional)">
          <input type="text" value={form.wardCode} onChange={(e) => setForm({ ...form, wardCode: e.target.value })} placeholder="e.g. CPT-W001" />
        </CrmField>
      </div>

      <ProfileFields
        avatarMediaId={avatarMediaId}
        title={form.title}
        bio={form.bio}
        onAvatar={setAvatarMediaId}
        onTitle={(v) => setForm({ ...form, title: v })}
        onBio={(v) => setForm({ ...form, bio: v })}
      />

      <PermissionsEditor
        role={form.role}
        base={rolePerms[form.role] ?? []}
        grants={overrides.grants}
        revokes={overrides.revokes}
        held={held}
        onChange={(grants, revokes) => setOverrides({ grants, revokes })}
      />

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
        <CrmButton variant="secondary" onClick={onClose}>Cancel</CrmButton>
        <CrmButton onClick={submit} disabled={saving}>{saving ? 'Creating…' : 'Create'}</CrmButton>
      </div>
    </CrmModal>
  );
}

function EditUserModal({ user, rolePerms, held, onClose, onSaved }: {
  user: UserShape;
  rolePerms: Record<string, string[]>;
  held: readonly string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    email: user.email ?? '',
    role: user.role,
    wardCode: user.wardCode ?? '',
    regionCodes: (user.regionCodes ?? []).join(', '),
    isActive: user.isActive ?? true,
    title: user.title ?? '',
    bio: user.bio ?? '',
  });
  const [overrides, setOverrides] = useState({
    grants: [...(user.permissionGrants ?? [])],
    revokes: [...(user.permissionRevokes ?? [])],
  });
  const [avatarMediaId, setAvatarMediaId] = useState<string | null>(user.avatarMediaId ?? null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await api.crmUpdateUser(user.id, {
        email: form.email || undefined,
        role: form.role,
        wardCode: form.wardCode || null,
        regionCodes: parseRegions(form.regionCodes),
        isActive: form.isActive,
        permissionGrants: overrides.grants,
        permissionRevokes: overrides.revokes,
        avatarMediaId,
        bio: form.bio.trim() || null,
        title: form.title.trim() || null,
      });
      onSaved();
    } catch (e: any) {
      alert(e?.message ?? 'Failed to update user');
    } finally {
      setSaving(false);
    }
  };

  return (
    <CrmModal title={`Edit User — ${user.fullName ?? user.email ?? user.id}`} onClose={onClose} wide>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 18px' }}>
        <CrmField label="Email">
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </CrmField>
        <CrmField label="Role">
          <select
            value={form.role}
            onChange={(e) => {
              setForm({ ...form, role: e.target.value });
              setOverrides({ grants: [], revokes: [] });
            }}
          >
            {ROLES.map((r) => (<option key={r} value={r}>{labelize(r)}</option>))}
          </select>
        </CrmField>
        <CrmField label="Region Codes (comma-separated, blank = national)">
          <input type="text" value={form.regionCodes} onChange={(e) => setForm({ ...form, regionCodes: e.target.value })} placeholder="e.g. CPT-SC1, CPT-SC2" />
        </CrmField>
        <CrmField label="Ward Code">
          <input type="text" value={form.wardCode} onChange={(e) => setForm({ ...form, wardCode: e.target.value })} placeholder="e.g. CPT-W001" />
        </CrmField>
        <CrmField label="Status">
          <select value={form.isActive ? 'active' : 'disabled'} onChange={(e) => setForm({ ...form, isActive: e.target.value === 'active' })}>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </CrmField>
      </div>

      <ProfileFields
        avatarMediaId={avatarMediaId}
        title={form.title}
        bio={form.bio}
        onAvatar={setAvatarMediaId}
        onTitle={(v) => setForm({ ...form, title: v })}
        onBio={(v) => setForm({ ...form, bio: v })}
      />

      <PermissionsEditor
        role={form.role}
        base={rolePerms[form.role] ?? []}
        grants={overrides.grants}
        revokes={overrides.revokes}
        held={held}
        onChange={(grants, revokes) => setOverrides({ grants, revokes })}
      />

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
        <CrmButton variant="secondary" onClick={onClose}>Cancel</CrmButton>
        <CrmButton onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Save'}</CrmButton>
      </div>
    </CrmModal>
  );
}

// ── Per-person permission overrides ────────────────────────────────────────

/**
 * Checkbox grid over the whole permission vocabulary, pre-set to the selected
 * role's own permissions. Ticking something the role lacks records a GRANT;
 * unticking something the role has records a REVOKE; a box that merely restates
 * the role default is dropped, so the stored arrays stay minimal and the audit
 * diff stays readable.
 *
 * A permission the signed-in editor does not hold is disabled: the server
 * refuses to let an editor mint or remove access they lack (sanitizeOverrides
 * in crm/userService.ts), so the form must not offer it either.
 */
function PermissionsEditor({ role, base, grants, revokes, held, onChange }: {
  role: string;
  /** The role's own permission set — the reference point for the checkboxes. */
  base: string[];
  grants: string[];
  revokes: string[];
  /** The signed-in editor's effective permissions. */
  held: readonly string[];
  onChange: (grants: string[], revokes: string[]) => void;
}) {
  const baseSet = useMemo(() => new Set(base), [base]);
  const granted = useMemo(() => new Set(grants), [grants]);
  const revoked = useMemo(() => new Set(revokes), [revokes]);
  const heldSet = useMemo(() => new Set(held), [held]);

  const isChecked = (p: string) => (baseSet.has(p) ? !revoked.has(p) : granted.has(p));

  function toggle(p: string) {
    const next = !isChecked(p);
    const g = new Set(grants);
    const r = new Set(revokes);
    if (next) { g.add(p); r.delete(p); } else { g.delete(p); r.add(p); }
    // Keep only the real deviations from the role: a grant of something the
    // role already has, or a revoke of something it does not, is noise.
    onChange(
      [...g].filter((x) => !baseSet.has(x)),
      [...r].filter((x) => baseSet.has(x)),
    );
  }

  function setAll(next: boolean) {
    const all = PERMISSION_GROUPS.flatMap((g) => g.perms).filter((p) => heldSet.has(p));
    onChange(
      next ? all.filter((p) => !baseSet.has(p)) : [],
      next ? [] : [...baseSet].filter((p) => heldSet.has(p)),
    );
  }

  return (
    <div style={{ borderTop: '1px solid #ece5e1', marginTop: 6, paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Permissions</div>
          <div style={{ fontSize: 12, color: '#8a817b', marginTop: 2 }}>
            Pre-set to {labelize(role)}. Tick to add a permission this person needs beyond the
            role; untick to take one away. Changes apply on their next sign-in or token refresh,
            and are enforced server-side immediately.
          </div>
        </div>
        <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
          <CrmSmallButton onClick={() => setAll(true)}>Grant all you hold</CrmSmallButton>
          <CrmSmallButton onClick={() => setAll(false)}>Back to role</CrmSmallButton>
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, marginTop: 12 }}>
        {PERMISSION_GROUPS.map((group) => (
          <div key={group.area} style={{ border: '1px solid #ece5e1', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.6, color: '#8a817b', marginBottom: 6 }}>
              {group.area}
            </div>
            {group.perms.map((p) => {
              const fromRole = baseSet.has(p);
              const locked = !heldSet.has(p);
              const checked = isChecked(p);
              return (
                <label
                  key={p}
                  title={
                    locked
                      ? `You do not hold ${p}, so you cannot change it for someone else`
                      : fromRole
                        ? 'Included by the role'
                        : p
                  }
                  style={{
                    display: 'flex', alignItems: 'center', gap: 7, padding: '2px 0',
                    fontSize: 12.5, cursor: locked ? 'not-allowed' : 'pointer',
                    color: locked ? '#c4bbb6' : checked ? '#1c1917' : '#57534e',
                    fontWeight: checked && !fromRole ? 700 : 400,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={locked}
                    onChange={() => toggle(p)}
                    style={{ width: 14, height: 14, flex: 'none' }}
                  />
                  <span style={{ minWidth: 0 }}>{permLabel(p)}</span>
                  {fromRole && (
                    <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 800, color: '#8a817b', border: '1px solid #ece5e1', borderRadius: 4, padding: '0 3px' }}>
                      role
                    </span>
                  )}
                  {!fromRole && checked && (
                    <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 800, color: '#16a34a' }}>added</span>
                  )}
                  {fromRole && !checked && (
                    <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 800, color: '#dc2626' }}>removed</span>
                  )}
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Profile: photo, title/office, bio ──────────────────────────────────────

/**
 * Photo + title + bio for ANY role. For a ward_councillor the server mirrors
 * the photo and bio into the public `leaders` profile (crm/userService.ts
 * syncCouncillorLeader), so what is entered here is what residents see on the
 * public ward page.
 */
function ProfileFields({ avatarMediaId, title, bio, onAvatar, onTitle, onBio }: {
  avatarMediaId: string | null;
  title: string;
  bio: string;
  onAvatar: (id: string | null) => void;
  onTitle: (v: string) => void;
  onBio: (v: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | null | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file (JPEG, PNG or WebP).');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const stored = await api.crmUploadMedia(await shrinkImage(file));
      onAvatar(stored.id);
    } catch (e: any) {
      setError(e?.message ?? 'Upload failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div style={{ borderTop: '1px solid #ece5e1', marginTop: 6, paddingTop: 14 }}>
      <div style={{ fontSize: 14, fontWeight: 700 }}>Profile</div>
      <div style={{ fontSize: 12, color: '#8a817b', margin: '2px 0 12px' }}>
        Published on the public ward page for ward councillors; visible in the CRM for everyone else.
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <AvatarThumb mediaId={avatarMediaId} name={title || 'user'} size={72} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => void pick(e.target.files?.[0])}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <CrmSmallButton onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? 'Uploading…' : avatarMediaId ? 'Replace photo' : 'Upload photo'}
            </CrmSmallButton>
            {avatarMediaId && (
              <CrmSmallButton danger onClick={() => onAvatar(null)}>Remove</CrmSmallButton>
            )}
          </div>
          <p className="upload-limit">Photo: max {formatBytes(AVATAR_UPLOAD_MAX)} encoded after automatic compression.</p>
          {error && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>{error}</div>}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 18px', marginTop: 12 }}>
        <CrmField label="Title / office">
          <input
            type="text"
            value={title}
            onChange={(e) => onTitle(e.target.value)}
            placeholder="e.g. Ward 43 Councillor"
          />
        </CrmField>
        <div />
      </div>
      <CrmField label="Bio">
        <textarea
          rows={3}
          value={bio}
          onChange={(e) => onBio(e.target.value)}
          placeholder="Short public biography — what they do, what they are working on in the ward."
        />
      </CrmField>
    </div>
  );
}

/**
 * CRM avatar preview. `<img>` cannot send an Authorization header, so the asset
 * is fetched as a blob with the bearer token and rendered from an object URL
 * (same approach as WardTransparency's MediaThumb). Falls back to initials.
 */
function AvatarThumb({ mediaId, name, size = 34 }: { mediaId: string | null; name: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!mediaId) { setUrl(null); return; }
    let objectUrl: string | null = null;
    let cancelled = false;
    fetch(`${API_BASE}/crm/media/${mediaId}`, {
      headers: { Authorization: `Bearer ${tokenStore.access ?? ''}` },
    })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('media'))))
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (!cancelled) setUrl(null); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mediaId]);

  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', border: '1px solid #ece5e1', flex: 'none' }}
      />
    );
  }
  const initialsOf = name
    .replace(/[^A-Za-z ]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      style={{
        width: size, height: size, borderRadius: '50%', flex: 'none',
        background: '#fbecee', color: '#a00d24', border: '1px solid #f2d5d9',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: Math.round(size * 0.38), fontWeight: 800,
      }}
    >
      {initialsOf || '?'}
    </span>
  );
}

/** Access column: exactly the role's set, or tuned per person. */
function OverrideBadge({ grants, revokes }: { grants: string[]; revokes: string[] }) {
  if (!grants.length && !revokes.length) {
    return <span style={{ color: '#8a817b', fontSize: 12 }}>Role default</span>;
  }
  return (
    <span
      style={{ fontSize: 12, whiteSpace: 'nowrap' }}
      title={`Added: ${grants.join(', ') || '—'}\nRemoved: ${revokes.join(', ') || '—'}`}
    >
      {grants.length > 0 && <span style={{ color: '#16a34a', fontWeight: 700 }}>+{grants.length}</span>}
      {grants.length > 0 && revokes.length > 0 && <span style={{ color: '#8a817b' }}> / </span>}
      {revokes.length > 0 && <span style={{ color: '#dc2626', fontWeight: 700 }}>−{revokes.length}</span>}
      <span style={{ color: '#8a817b' }}> tuned</span>
    </span>
  );
}

// ── CSV bulk import (the ward-councillor list) ─────────────────────────────

const CSV_HEADERS = ['email', 'fullName', 'password', 'role', 'wardCode', 'regionCodes'];

interface ImportRow {
  email: string;
  fullName?: string;
  password?: string;
  role?: string;
  wardCode?: string;
  regionCodes?: string;
}

interface ImportResult {
  total: number;
  created: number;
  skipped: number;
  failed: number;
  results: { row: number; email: string; status: 'created' | 'skipped' | 'error'; message?: string }[];
}

/**
 * Minimal CSV reader: quoted fields, doubled quotes, CRLF and a BOM. No new
 * dependency for a format this small, and the file never leaves the browser
 * until the rows are posted.
 */
function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Map a parsed sheet onto import rows by header name (case-insensitive). */
function rowsFromCsv(text: string): { rows: ImportRow[]; error: string | null } {
  const table = parseCsv(text);
  if (table.length < 2) {
    return { rows: [], error: 'The file needs a header row and at least one data row.' };
  }
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const at = (r: string[], name: string) => {
    const i = header.indexOf(name);
    const v = i >= 0 ? (r[i] ?? '').trim() : '';
    return v || undefined;
  };
  if (!header.includes('email')) {
    return { rows: [], error: 'No "email" column in the header row.' };
  }
  const rows = table
    .slice(1)
    .map((r) => ({
      email: at(r, 'email') ?? '',
      fullName: at(r, 'fullname'),
      password: at(r, 'password'),
      role: at(r, 'role'),
      wardCode: at(r, 'wardcode'),
      regionCodes: at(r, 'regioncodes'),
    }))
    .filter((r) => r.email);
  if (rows.length === 0) {
    return { rows: [], error: 'No rows with an email address were found.' };
  }
  return { rows, error: null };
}

function ImportUsersModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [defaultRole, setDefaultRole] = useState('ward_councillor');
  const [defaultPassword, setDefaultPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function onFile(file: File | null | undefined) {
    if (!file) return;
    setParseError(null);
    setResult(null);
    setRows(null);
    setFileName('');
    try {
      if (file.size > IMPORT_MAX) {
        setParseError(`CSV exceeds ${formatBytes(IMPORT_MAX)}. Split it into smaller files.`);
        return;
      }
      const parsed = rowsFromCsv(await file.text());
      setRows(parsed.rows.length ? parsed.rows : null);
      setParseError(parsed.error);
      setFileName(parsed.rows.length ? file.name : '');
    } catch {
      setParseError('That file could not be read.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const downloadTemplate = () =>
    downloadCsv('councillor-import-template', CSV_HEADERS, [
      ['jane.doe@example.org', 'Jane Doe', '', 'ward_councillor', 'CPT-W001', 'CPT-SC1'],
      ['john.smith@example.org', 'John Smith', 'TheirOwnPassword1', 'ward_councillor', 'CPT-W002', 'CPT-SC1'],
    ]);

  const submit = async () => {
    if (!rows?.length) return;
    setBusy(true);
    try {
      const payload = rows.map((r) => ({ ...r, role: r.role || defaultRole }));
      const bytes = new TextEncoder().encode(JSON.stringify({ rows: payload, defaultPassword: defaultPassword.trim() || undefined })).byteLength;
      if (bytes > IMPORT_MAX) throw new Error(`Prepared import exceeds ${formatBytes(IMPORT_MAX)}. Split the CSV into smaller files.`);
      setResult(await api.crmImportUsers(payload, defaultPassword.trim() || undefined));
    } catch (e: any) {
      alert(e?.message ?? 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <CrmModal title="Import users from CSV" onClose={onClose} wide>
      {result ? (
        <>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            <CrmBadge value={`${result.created} created`} />
            <CrmBadge value={`${result.skipped} skipped`} />
            <CrmBadge value={`${result.failed} failed`} />
          </div>
          <CrmTable
            columns={['Row', 'Email', 'Result', 'Detail']}
            rows={result.results.map((r) => [
              r.row,
              r.email || '—',
              <span
                key="b"
                style={{
                  fontSize: 11,
                  fontWeight: 800,
                  textTransform: 'uppercase',
                  letterSpacing: 0.3,
                  color: r.status === 'created' ? '#166534' : r.status === 'skipped' ? '#92400e' : '#991b1b',
                }}
              >
                {r.status}
              </span>,
              <span key="m" style={{ fontSize: 12, color: '#57534e' }}>
                {r.status === 'created'
                  ? 'Account provisioned'
                  : r.status === 'skipped'
                    ? 'Already exists — left untouched'
                    : r.message ?? 'Failed'}
              </span>,
            ])}
            empty="No rows were processed."
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
            <CrmButton variant="secondary" onClick={onClose}>Close</CrmButton>
            <CrmButton onClick={onImported}>Done</CrmButton>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 13, color: '#57534e', margin: '0 0 14px' }}>
            Columns: <code>{CSV_HEADERS.join(', ')}</code>. Only <strong>email</strong> is required;
            a blank <code>password</code> uses the default below, and a blank <code>role</code> uses
            the role selected below. Rows are created one by one — a duplicate email or an unknown
            ward code only fails that row, not the batch. Every account is written to the audit log.
          </p>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <CrmButton variant="secondary" onClick={() => fileRef.current?.click()}>Choose CSV file</CrmButton>
            <CrmButton variant="secondary" onClick={downloadTemplate}>Download template</CrmButton>
            {fileName && <span style={{ fontSize: 13, color: '#16a34a', fontWeight: 600 }}>{fileName}</span>}
          </div>

          <p className="upload-limit">CSV: max {formatBytes(IMPORT_MAX)} per file and prepared import. Split larger imports into separate files.</p>
          {parseError && <div style={{ fontSize: 13, color: '#dc2626', marginTop: 10 }}>{parseError}</div>}

          {rows && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 18px', marginTop: 16 }}>
                <CrmField label="Role for rows without one">
                  <select value={defaultRole} onChange={(e) => setDefaultRole(e.target.value)}>
                    {ROLES.map((r) => (<option key={r} value={r}>{labelize(r)}</option>))}
                  </select>
                </CrmField>
                <CrmField label="Default password (min 10 characters)">
                  <input
                    type="text"
                    value={defaultPassword}
                    onChange={(e) => setDefaultPassword(e.target.value)}
                    placeholder="Used for rows with a blank password"
                  />
                </CrmField>
              </div>
              <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #ece5e1', borderRadius: 8 }}>
                <CrmTable
                  columns={['#', 'Email', 'Name', 'Role', 'Ward', 'Regions']}
                  rows={rows.slice(0, 200).map((r, i) => [
                    i + 1,
                    r.email,
                    r.fullName ?? '—',
                    labelize(r.role || defaultRole),
                    r.wardCode ?? '—',
                    r.regionCodes ?? '—',
                  ])}
                />
              </div>
              {rows.length > 200 && (
                <div style={{ fontSize: 12, color: '#8a817b', marginTop: 6 }}>
                  Showing the first 200 of {rows.length} rows — all of them will be imported.
                </div>
              )}
            </>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
            <CrmButton variant="secondary" onClick={onClose}>Cancel</CrmButton>
            <CrmButton onClick={submit} disabled={!rows?.length || busy}>
              {busy ? 'Importing…' : `Import ${rows?.length ?? 0} users`}
            </CrmButton>
          </div>
        </>
      )}
    </CrmModal>
  );
}

// ── Image handling for the avatar picker ───────────────────────────────────

/**
 * The API accepts a 256 kB JSON body, so a phone photo is downscaled in the
 * browser before it is base64-encoded. Steps try a sharp large avatar first and
 * only trade quality away if the payload is still too big.
 */
const AVATAR_STEPS: [number, number][] = [[512, 0.85], [512, 0.7], [384, 0.7], [320, 0.6], [256, 0.55]];
const AVATAR_BUDGET = AVATAR_UPLOAD_MAX; // base64 characters, comfortably inside 256 kB

async function shrinkImage(file: File): Promise<string> {
  const original = await readAsDataUrl(file);
  if (original.length <= AVATAR_BUDGET && /^data:image\/(jpeg|png|webp);/i.test(original)) {
    return original;
  }
  const img = await loadImage(original);
  for (const [maxEdge, quality] of AVATAR_STEPS) {
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) break;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL('image/jpeg', quality);
    if (out.length <= AVATAR_BUDGET) return out;
  }
  throw new Error('That photo could not be compressed enough — please choose a smaller image.');
}

function readAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ''));
    fr.onerror = () => reject(new Error('Could not read that file'));
    fr.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file is not a readable image'));
    img.src = src;
  });
}
