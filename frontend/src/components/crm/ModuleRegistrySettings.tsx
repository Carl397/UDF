'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { ModuleKey } from '../../lib/modules';
import { CrmCard, CrmTable } from './ui';
import type { ModuleRegistry } from '../../types';

/**
 * CRM Settings ▸ Module registry. National-admin only (mounted behind a
 * `role === 'national_admin'` guard in `/crm/settings`, and the API is gated on
 * `module:manage`).
 *
 * A role × module matrix of switches. Each module is a whole feature surface;
 * disabling it for a role strips every permission the module owns, so the
 * role's screens hide and its API calls return 403 — enforced server-side in
 * `effectivePermissions`, not just in this UI. A switch is rendered only for a
 * cell the role is *applicable* to (it holds at least one of the module's
 * permissions); the rest are dashes, so an administrator never sees a toggle for
 * a module a role could never hold.
 */

const ROLE_LABEL: Record<string, string> = {
  national_admin: 'National admin',
  regional_organizer: 'Regional org',
  local_coordinator: 'Coordinator',
  ward_councillor: 'Councillor',
  analyst: 'Analyst',
  member: 'Member',
};

/**
 * The modules a national admin MUST keep to reach this editor, mirroring the
 * server's `NATIONAL_ADMIN_LOCKOUT`: `admin` owns `module:manage` (this
 * endpoint's gate) and `overview` owns `overview:read` (the router-level gate on
 * all of `/api/crm`). The server rejects disabling either with 400
 * `module_lockout`; the UI disables the cell so the rejection is never reached.
 */
const LOCKOUT_ROLE = 'national_admin';
const LOCKOUT_MODULES: readonly string[] = [ModuleKey.ADMIN, ModuleKey.OVERVIEW];

function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

/** An accessible on/off switch rendered as a pill (no styled-jsx dynamics). */
function Switch({
  on,
  disabled,
  onChange,
  title,
}: {
  on: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={title}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!on)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        border: 'none',
        padding: 0,
        position: 'relative',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: on ? '#16a34a' : '#d6d3d1',
        opacity: disabled ? 0.55 : 1,
        transition: 'background 0.15s',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
          transition: 'left 0.15s',
        }}
      />
    </button>
  );
}

export default function ModuleRegistrySettings() {
  const [registry, setRegistry] = useState<ModuleRegistry | null>(null);
  // Local editable copy of the gate matrix, so a toggle is responsive before the
  // server confirms and can be reverted if it rejects the change.
  const [gates, setGates] = useState<Record<string, Record<string, boolean>>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const flash = (tone: 'ok' | 'err', text: string) => {
    setMsg({ tone, text });
    window.setTimeout(() => setMsg(null), 4000);
  };

  const load = useCallback(() => {
    setLoading(true);
    api
      .crmGetModules()
      .then((reg) => {
        setRegistry(reg);
        setGates(reg.gates);
      })
      .catch(() => flash('err', 'Could not load the module registry.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function toggle(role: string, key: string, next: boolean) {
    if (busy) return;
    const snapshot = gates;
    setBusy(true);
    // Optimistic: paint the switch immediately, revert on failure.
    setGates((g) => ({ ...g, [role]: { ...(g[role] ?? {}), [key]: next } }));
    try {
      await api.crmSetModuleGate(role, key, next);
      const label = registry?.modules.find((m) => m.key === key)?.label ?? key;
      flash('ok', `${label} ${next ? 'enabled' : 'disabled'} for ${roleLabel(role)}.`);
    } catch (e: any) {
      setGates(snapshot);
      flash('err', e?.message ?? 'Could not update the module gate.');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !registry) {
    return (
      <CrmCard title="Module Registry">
        <p style={{ color: '#64748b' }}>Loading module registry…</p>
      </CrmCard>
    );
  }

  const columns = ['Module', ...registry.roles.map(roleLabel)];
  const rows = registry.modules.map((m) => {
    const moduleCell = (
      <div key="m" style={{ minWidth: 220 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: '#1c1917' }}>{m.label}</div>
        {m.description && (
          <div style={{ fontSize: 12, color: '#8a817b', marginTop: 2 }}>{m.description}</div>
        )}
        <div style={{ fontSize: 11, color: '#a8a29e', marginTop: 4 }}>
          {m.permissions.length ? (
            <code>{m.permissions.join(' · ')}</code>
          ) : (
            <em>UI-only — rides on member:read</em>
          )}
        </div>
      </div>
    );

    const roleCells = registry.roles.map((role) => {
      const applicable = registry.applicable[role]?.includes(m.key) ?? false;
      if (!applicable) {
        return (
          <span
            key={role}
            style={{ color: '#d6d3d1', fontSize: 16 }}
            title={`${roleLabel(role)} holds none of this module's permissions`}
          >
            —
          </span>
        );
      }
      const on = gates[role]?.[m.key] ?? true;
      const lockout = role === LOCKOUT_ROLE && LOCKOUT_MODULES.includes(m.key);
      return (
        <Switch
          key={role}
          on={on}
          disabled={busy || lockout}
          onChange={(next) => toggle(role, m.key, next)}
          title={
            lockout
              ? 'Required to reach the module registry — cannot be disabled for national admin'
              : `${on ? 'Disable' : 'Enable'} ${m.label} for ${roleLabel(role)}`
          }
        />
      );
    });

    return [moduleCell, ...roleCells];
  });

  return (
    <>
      {msg && (
        <div
          style={{
            padding: 12,
            marginBottom: 20,
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            background: msg.tone === 'ok' ? '#f0fdf4' : '#fef2f2',
            border: `1px solid ${msg.tone === 'ok' ? '#bbf7d0' : '#fecaca'}`,
            color: msg.tone === 'ok' ? '#166534' : '#991b1b',
          }}
        >
          {msg.text}
        </div>
      )}

      <CrmCard title={`Module Registry · ${registry.modules.length} modules × ${registry.roles.length} roles`}>
        <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 16px', lineHeight: 1.6 }}>
          Disabling a module removes its permissions for that role — its screens hide and its API
          calls return <code>403</code>. The change is enforced server-side and takes effect on the
          role&apos;s next request, with no redeploy. A dash means the role holds none of the
          module&apos;s permissions, so there is nothing to toggle. The <code>admin</code> and{' '}
          <code>overview</code> modules cannot be disabled for national admin: they are required to
          reach this editor, and turning them off would lock every administrator out with no way back.
        </p>
        <CrmTable columns={columns} rows={rows} empty="No modules registered." />
      </CrmCard>
    </>
  );
}
