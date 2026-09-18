import { query } from '../../db/pool.js';
import { recordAudit } from '../../security/audit.js';
import { ApiError } from '../../http/errors.js';
import {
  MODULE_PERMISSIONS,
  ModuleKey,
  Role,
  modulesForRole,
  type Permission,
} from '../../auth/permissions.js';

/**
 * Module registry service — the read/write side of the per-role module gates.
 *
 * The gate table (`role_module_gates`, migration 016) records only NON-default
 * state authoritatively: a row with `enabled=FALSE` is the one thing that turns
 * a module off. A role's *applicable* modules are derived from the permission
 * matrix (`modulesForRole`), so an applicable module with no row is enabled by
 * default and can still be switched off later (the switch upserts a row).
 *
 * Enforcement is not here: `effectivePermissions` strips a disabled module's
 * permissions, and `authenticate` passes the disabled list in. This service only
 * answers "which modules are off/on for this role" and "flip one, with an audit
 * trail and a lockout guard".
 */

/** Actor context for the audited gate change. */
export interface GateActor {
  actorId: string | null;
  actorRole: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** role → the module keys it could hold, derived once from the permission matrix. */
const APPLICABLE: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.values(Role).map((role) => [role, new Set<string>(modulesForRole(role))]),
);

/**
 * The module state for a role in ONE query: which modules are switched off, and
 * which are on. `disabled` is the list `effectivePermissions` strips; `enabled`
 * is the applicable set minus the disabled, mirrored to the client. Only
 * `enabled=FALSE` rows count as disabled — an absent row is the enabled default.
 */
export async function moduleStateForRole(
  role: string,
): Promise<{ disabled: string[]; enabled: string[] }> {
  const res = await query<{ module_key: string; enabled: boolean }>(
    `SELECT module_key, enabled FROM role_module_gates WHERE role = $1`,
    [role],
  );
  const disabled = res.rows.filter((r) => !r.enabled).map((r) => r.module_key);
  const disabledSet = new Set(disabled);
  const enabled = modulesForRole(role as Role).filter((key) => !disabledSet.has(key));
  return { disabled, enabled };
}

/**
 * The module keys switched OFF for a role. Only `enabled=FALSE` rows count; an
 * absent row is the enabled default. Fed straight into `effectivePermissions`.
 */
export async function disabledModulesForRole(role: string): Promise<string[]> {
  return (await moduleStateForRole(role)).disabled;
}

/**
 * The module keys ON for a role: every applicable module (from the permission
 * matrix) that is not switched off. Mirrored to the client as `enabledModules`
 * so the UI-only surfaces (`id_cards`) and any "module disabled" empty-state can
 * consult it. Permission-backed modules are already enforced through the
 * stripped permission list; this is the human/UI-facing view.
 */
export async function enabledModulesForRole(role: string): Promise<string[]> {
  return (await moduleStateForRole(role)).enabled;
}

/**
 * Modules a national admin MUST keep to reach the registry editor itself, and so
 * can never be switched off for `national_admin`:
 *   • `admin`    owns `module:manage`, the permission this endpoint is gated on.
 *   • `overview` owns `overview:read`, the router-level gate on all of `/api/crm`.
 * Turning either off for the one role that can turn it back on would be a
 * permanent, unrecoverable lockout — there is no other path to the editor. The
 * route rejects the change with 400 `module_lockout`; the UI disables the cell.
 */
const NATIONAL_ADMIN_LOCKOUT: readonly string[] = [ModuleKey.ADMIN, ModuleKey.OVERVIEW];

function assertNotLockout(role: string, key: string, enabled: boolean): void {
  if (enabled) return; // re-enabling can never lock anyone out
  if (role === Role.NATIONAL_ADMIN && NATIONAL_ADMIN_LOCKOUT.includes(key)) {
    throw new ApiError(
      400,
      'module_lockout',
      `The "${key}" module cannot be disabled for national_admin: it is required to reach the module registry, and disabling it would lock every administrator out with no way back.`,
    );
  }
}

/**
 * Enable or disable one module for one role, upserting the gate row and writing
 * an audited `module.gate_change` entry. Rejects a national-admin lockout before
 * touching the DB. Returns the resulting enabled state.
 */
export async function setGate(
  role: string,
  key: string,
  enabled: boolean,
  actor: GateActor,
): Promise<{ role: string; moduleKey: string; enabled: boolean }> {
  assertNotLockout(role, key, enabled);

  // The module must exist in the registry (the FK would throw anyway, but a
  // clear 400 beats a 500 for a typo'd key from the client).
  const known = await query<{ key: string }>(`SELECT key FROM modules WHERE key = $1`, [key]);
  if (known.rowCount === 0) {
    throw new ApiError(400, 'unknown_module', `No such module: ${key}`);
  }

  await query(
    `INSERT INTO role_module_gates (role, module_key, enabled, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (role, module_key)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = now()`,
    [role, key, enabled, actor.actorId],
  );

  await recordAudit({
    action: 'module.gate_change',
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    targetType: 'role',
    targetId: role,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    metadata: { moduleKey: key, enabled },
  });

  return { role, moduleKey: key, enabled };
}

/** One registry row plus its owned permissions, as the CRM matrix needs it. */
export interface ModuleRegistryEntry {
  key: string;
  label: string;
  description: string | null;
  sort: number;
  /** The permissions this module owns (empty for the UI-only `id_cards`). */
  permissions: Permission[];
}

/**
 * The full registry with the per-role gate matrix, for the CRM editor.
 *
 * `gates[role][moduleKey]` is the effective enabled state (default true for an
 * applicable-but-unseeded cell), and `applicable[role]` lists the modules that
 * role could hold at all — the editor renders a switch only for those, so an
 * administrator never sees a toggle for a module a role has no permission for.
 */
export async function getRegistry(): Promise<{
  modules: ModuleRegistryEntry[];
  roles: string[];
  applicable: Record<string, string[]>;
  gates: Record<string, Record<string, boolean>>;
}> {
  const [moduleRows, gateRows] = await Promise.all([
    query<{ key: string; label: string; description: string | null; sort: number }>(
      `SELECT key, label, description, sort FROM modules ORDER BY sort, key`,
    ),
    query<{ role: string; module_key: string; enabled: boolean }>(
      `SELECT role, module_key, enabled FROM role_module_gates`,
    ),
  ]);

  const modules: ModuleRegistryEntry[] = moduleRows.rows.map((m) => ({
    key: m.key,
    label: m.label,
    description: m.description,
    sort: m.sort,
    permissions: [...(MODULE_PERMISSIONS[m.key as ModuleKey] ?? [])],
  }));

  const roles = Object.values(Role);
  const applicable: Record<string, string[]> = {};
  const gates: Record<string, Record<string, boolean>> = {};
  for (const role of roles) {
    const mods = [...(APPLICABLE.get(role) ?? [])];
    applicable[role] = mods;
    gates[role] = Object.fromEntries(mods.map((key) => [key, true])); // default enabled
  }
  for (const g of gateRows.rows) {
    // A stored row overrides the default, but only for a cell the role can hold;
    // a stale row for a non-applicable module is ignored so the matrix stays honest.
    const roleGates = gates[g.role];
    if (roleGates && APPLICABLE.get(g.role)?.has(g.module_key)) {
      roleGates[g.module_key] = g.enabled;
    }
  }

  return { modules, roles, applicable, gates };
}
