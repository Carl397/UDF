import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { effectivePermissions, isNationalAdmin, Permission, type Principal, type Role } from '../../auth/permissions.js';
import { principalSeesWard, STAFF_ROLES } from '../../auth/scope.js';
import { ApiError } from '../../http/errors.js';
import { openRecord } from '../../security/encryption.js';
import { recordAudit } from '../../security/audit.js';

export const staffSelect = `SELECT u.id, u.role, u.ward_code, u.region_codes, u.is_active,
  u.moderation_status, u.suspended_until, u.permission_grants, u.permission_revokes,
  COALESCE((SELECT array_agg(g.module_key) FROM role_module_gates g WHERE g.role=u.role AND NOT g.enabled), '{}') AS disabled_modules
  FROM users u`;

export function staffPrincipal(u: Record<string, any>): Principal | null {
  if (!u.is_active || ['banned','suspended'].includes(u.moderation_status) ||
      (u.suspended_until && new Date(u.suspended_until).getTime() > Date.now()) || !STAFF_ROLES.has(u.role)) return null;
  return { sub: u.id, role: u.role as Role, wardCode: u.ward_code, regionCodes: u.region_codes,
    permissions: effectivePermissions(u.role, u.permission_grants, u.permission_revokes, u.disabled_modules) };
}

export async function liveReportStaff(p: Principal, write = false, client?: PoolClient): Promise<Principal> {
  const run = client ? client.query.bind(client) : query;
  const row = (await run(`${staffSelect} WHERE u.id=$1`, [p.sub])).rows[0];
  const live = row && staffPrincipal(row);
  if (!live || !p.permissions?.includes(Permission.REPORT_READ) || !live.permissions?.includes(Permission.REPORT_READ) ||
      (write && (!p.permissions?.includes(Permission.REPORT_WRITE) || !live.permissions?.includes(Permission.REPORT_WRITE)))) {
    throw ApiError.forbidden('Report staff access is required');
  }
  return live;
}

export async function authorizeReportStaff(id: string, p: Principal, write = false, client?: PoolClient) {
  const principal = await liveReportStaff(p, write, client);
  const run = client ? client.query.bind(client) : query;
  const report = (await run(`SELECT id, ward_code, status FROM resident_reports WHERE id=$1${client ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!report) throw ApiError.notFound('Report not found');
  if (!isNationalAdmin(principal.role) && (!report.ward_code || !await principalSeesWard(principal, report.ward_code))) {
    throw ApiError.forbidden('Report is outside your territory');
  }
  return { principal, report };
}

export async function eligibleStaff(ward: string | null, ids?: string[], client?: PoolClient): Promise<Principal[]> {
  const run = client ? client.query.bind(client) : query;
  const rows = (await run(`${staffSelect} WHERE u.role = ANY($1::text[])${ids ? ' AND u.id = ANY($2::uuid[])' : ''}`,
    ids ? [[...STAFF_ROLES], ids] : [[...STAFF_ROLES]])).rows;
  const result: Principal[] = [];
  for (const row of rows) {
    const p = staffPrincipal(row);
    if (p?.permissions?.includes(Permission.REPORT_READ) && p.permissions.includes(Permission.REPORT_WRITE) &&
        (isNationalAdmin(p.role) || (ward && await principalSeesWard(p, ward)))) result.push(p);
  }
  return result;
}

/** Minimal operational identities, disclosed only after report/territory authorization. */
export async function staffNames(ids: Array<string | null | undefined>, actor: Principal): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (!unique.length) return {};
  const { rows } = await query(`SELECT u.id, u.role, u.sealed_pii, l.full_name FROM users u
    LEFT JOIN leaders l ON l.user_id=u.id WHERE u.id=ANY($1::uuid[])`, [unique]);
  const names: Record<string, string> = {};
  let decrypted = false;
  for (const row of rows) {
    if (!STAFF_ROLES.has(row.role)) { names[row.id] = 'Report participant'; continue; }
    const pii = !row.full_name && row.sealed_pii ? await openRecord(row.id, row.sealed_pii) : null;
    decrypted ||= !!pii;
    names[row.id] = row.full_name || pii?.fullName || `${row.role.replace(/_/g, ' ')} (${row.id.slice(0, 8)})`;
  }
  if (decrypted) await recordAudit({ action: 'transparency.staff_names.read', actorId: actor.sub, actorRole: actor.role,
    metadata: { count: rows.length } });
  return names;
}
