import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import { Permission, Role } from '../../auth/permissions.js';
import { hashPassword } from '../../security/password.js';
import { sealRecord, openRecord, type SealedRecord } from '../../security/encryption.js';
import { blindIndex } from '../../security/blindIndex.js';
import { recordAudit } from '../../security/audit.js';

/**
 * CRM User Management service — CRUD for system users (staff), role
 * assignment and permission lookup.
 *
 * IMPORTANT: the `users` table stores no plaintext email. Email is sealed in
 * `sealed_pii` (envelope encryption) and looked up via the `email_bidx` blind
 * index. Region scope lives in `region_codes[]`; `ward_code` is an optional FK
 * to regions. There is no `last_login_at` column.
 */

interface UserRow {
  id: string;
  role: string;
  region_codes: string[];
  ward_code: string | null;
  ward_codes: string[];
  is_active: boolean;
  created_at: string;
  sealed_pii: SealedRecord | null;
  permission_grants: string[] | null;
  permission_revokes: string[] | null;
  avatar_media_id: string | null;
  member_id: string | null;
  bio: string | null;
  title: string | null;
}

export interface ActorCtx {
  actorId?: string | null;
  actorRole?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * The editor's own effective permissions. Used to enforce the no-escalation
   * rule: an administrator may only grant or revoke permissions they themselves
   * hold, so editing someone can never mint access the editor lacks.
   */
  permissions?: readonly string[];
}

export interface PublicUser {
  id: string;
  email: string | null;
  fullName: string | null;
  role: string;
  regionCodes: string[];
  wardCode: string | null;
  /** Full list of wards this councillor is publicly shown for; wardCode is the primary. */
  wardCodes: string[];
  isActive: boolean;
  createdAt: string;
  permissionGrants: string[];
  permissionRevokes: string[];
  avatarMediaId: string | null;
  bio: string | null;
  title: string | null;
}

const SELECT_COLS = `id, role, region_codes, ward_code, ward_codes, is_active, created_at, sealed_pii,
       permission_grants, permission_revokes, avatar_media_id, member_id, bio, title`;

/** Decrypt the sealed email/fullName for display (best-effort). */
async function reveal(row: UserRow): Promise<{ email: string | null; fullName: string | null }> {
  if (!row.sealed_pii) return { email: null, fullName: null };
  try {
    const opened = await openRecord(row.id, row.sealed_pii);
    return { email: opened.email ?? null, fullName: opened.fullName ?? null };
  } catch {
    return { email: null, fullName: null };
  }
}

function toPublic(row: UserRow, pii: { email: string | null; fullName: string | null }): PublicUser {
  return {
    id: row.id,
    email: pii.email,
    fullName: pii.fullName,
    role: row.role,
    regionCodes: row.region_codes ?? [],
    wardCode: row.ward_code,
    wardCodes: row.ward_codes?.length ? row.ward_codes : (row.ward_code ? [row.ward_code] : []),
    isActive: row.is_active,
    createdAt: row.created_at,
    permissionGrants: row.permission_grants ?? [],
    permissionRevokes: row.permission_revokes ?? [],
    avatarMediaId: row.avatar_media_id,
    bio: row.bio,
    title: row.title,
  };
}

export async function listUsers(filters: {
  role?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters.role) {
    conditions.push(`role = $${idx}`);
    params.push(filters.role);
    idx++;
  }
  // Email is sealed, so search is an exact-match lookup via the blind index.
  if (filters.search) {
    conditions.push(`email_bidx = $${idx}`);
    params.push(blindIndex('email', filters.search.trim().toLowerCase()));
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const [countRes, dataRes] = await Promise.all([
    query(`SELECT COUNT(*) as total FROM users ${where}`, params),
    query<UserRow>(
      `SELECT ${SELECT_COLS} FROM users ${where}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    ),
  ]);

  const items = await Promise.all(dataRes.rows.map(async (row) => toPublic(row, await reveal(row))));
  return { items, total: parseInt(countRes.rows[0].total, 10), limit, offset };
}

export async function getUser(id: string): Promise<PublicUser | null> {
  const res = await query<UserRow>(`SELECT ${SELECT_COLS} FROM users WHERE id = $1`, [id]);
  const row = res.rows[0];
  if (!row) return null;
  return toPublic(row, await reveal(row));
}

/** Known permission names, for validating supplied overrides. */
const PERMISSION_NAMES: readonly string[] = Object.values(Permission);

/**
 * Validate a supplied override list: drop unknown names (fail closed) and, when
 * an editor context is present, refuse any permission the editor does not
 * themselves hold — editing someone must never mint access the editor lacks.
 */
function sanitizeOverrides(values: readonly string[] | undefined, actor?: ActorCtx): string[] {
  const known = (values ?? []).filter((v) => PERMISSION_NAMES.includes(v));
  if (!actor?.permissions) return known;
  const held = new Set(actor.permissions);
  const over = known.filter((p) => !held.has(p));
  if (over.length > 0) {
    throw ApiError.forbidden(`Cannot modify permissions you do not hold: ${over.join(', ')}`);
  }
  return known;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/**
 * Normalize a councillor's public ward list: trim, drop empties, dedupe while
 * preserving order (first entry = primary ward). Falls back to the legacy
 * single wardCode when no list is supplied.
 */
function normalizeWards(wardCodes: readonly string[] | undefined, wardCode?: string | null): string[] {
  const list = wardCodes ?? (wardCode ? [wardCode] : []);
  return [...new Set(list.map((s) => String(s ?? '').trim()).filter(Boolean))];
}

/**
 * Mirror a ward_councillor's photo + bio into the public `leaders` profile so
 * residents see their councillor's face and bio on the ward/verify pages.
 * `leaders` has no natural unique key (only its id primary key), so guard on the
 * ward and refresh the existing published row in place rather than appending
 * duplicate leader rows (the D46 defect class called out in seedValidationCore).
 */
async function syncCouncillorLeader(userId: string): Promise<void> {
  await withTransaction(async (client) => {
    const run = client.query.bind(client) as typeof query;
    const row = (await run<UserRow>(`SELECT ${SELECT_COLS} FROM users WHERE id = $1 FOR UPDATE`, [userId])).rows[0];
    if (!row || !row.is_active || row.role !== Role.WARD_COUNCILLOR || !row.ward_code) {
      await run('UPDATE leaders SET is_public = false, updated_at = now() WHERE user_id = $1', [userId]);
      return;
    }
    const pii = await reveal(row);
    // Older accounts sometimes stored the email in fullName; never publish it.
    const fullName = pii.fullName?.trim() && pii.fullName !== pii.email && !pii.fullName.includes('@')
      ? pii.fullName : 'Ward councilor';
    const regionCode = row.region_codes?.[0] ?? row.ward_code;
    const wardCodes = row.ward_codes?.length ? row.ward_codes : [row.ward_code];
    await run(
      `INSERT INTO leaders (user_id, ward_code, ward_codes, region_code, full_name, bio, photo_id, member_id, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
       ON CONFLICT (user_id) DO UPDATE SET ward_code = EXCLUDED.ward_code,
         ward_codes = EXCLUDED.ward_codes,
         region_code = EXCLUDED.region_code, full_name = EXCLUDED.full_name,
         bio = EXCLUDED.bio, photo_id = EXCLUDED.photo_id, member_id = EXCLUDED.member_id,
         is_public = TRUE, updated_at = now()`,
      [userId, row.ward_code, wardCodes, regionCode, fullName, row.bio, row.avatar_media_id, row.member_id]);
  });
}

export async function createUser(
  data: {
    email: string;
    password: string;
    role: string;
    fullName?: string;
    regionCodes?: string[];
    wardCode?: string | null;
    /** Full ward list for a councillor's public link; wardCode (primary) is derived from its first entry. */
    wardCodes?: string[];
    permissionGrants?: string[];
    permissionRevokes?: string[];
    avatarMediaId?: string | null;
    bio?: string | null;
    title?: string | null;
  },
  actor?: ActorCtx,
): Promise<PublicUser> {
  const id = randomUUID();
  const email = data.email.trim().toLowerCase();
  const wardList = normalizeWards(data.wardCodes, data.wardCode);
  const primaryWard = wardList[0] ?? null;
  const grants = sanitizeOverrides(data.permissionGrants, actor);
  const revokes = sanitizeOverrides(data.permissionRevokes, actor);
  const [passwordHash, sealed] = await Promise.all([
    hashPassword(data.password),
    sealRecord(id, { email, fullName: data.fullName?.trim() || email }),
  ]);

  const res = await query<{ id: string }>(
    `INSERT INTO users (id, email_bidx, password_hash, role, region_codes, ward_code, ward_codes, sealed_pii,
                        permission_grants, permission_revokes, avatar_media_id, bio, title)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)
     ON CONFLICT (email_bidx) DO NOTHING
     RETURNING id`,
    [
      id,
      blindIndex('email', email),
      passwordHash,
      data.role,
      data.regionCodes ?? [],
      primaryWard,
      wardList,
      JSON.stringify(sealed),
      grants,
      revokes,
      data.avatarMediaId ?? null,
      data.bio ?? null,
      data.title ?? null,
    ],
  );
  if (res.rowCount === 0) throw ApiError.conflict('User already exists');

  await recordAudit({
    action: 'role.change',
    actorId: actor?.actorId ?? null,
    actorRole: actor?.actorRole ?? null,
    targetType: 'user',
    targetId: id,
    ip: actor?.ip ?? null,
    userAgent: actor?.userAgent ?? null,
    metadata: { op: 'create', role: data.role, permissionGrants: grants, permissionRevokes: revokes },
  });

  await syncCouncillorLeader(id);
  return (await getUser(id))!;
}

export async function updateUser(
  id: string,
  data: {
    email?: string;
    role?: string;
    wardCode?: string | null;
    /** Full ward list; wardCode (primary) is re-derived from its first entry. */
    wardCodes?: string[];
    regionCodes?: string[];
    isActive?: boolean;
    permissionGrants?: string[];
    permissionRevokes?: string[];
    avatarMediaId?: string | null;
    bio?: string | null;
    title?: string | null;
  },
  actor?: ActorCtx,
): Promise<PublicUser | null> {
  const existing = await query<UserRow>(`SELECT ${SELECT_COLS} FROM users WHERE id = $1`, [id]);
  const row = existing.rows[0];
  if (!row) return null;

  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (data.role !== undefined) { sets.push(`role = $${idx++}`); params.push(data.role); }
  if (data.wardCode !== undefined || data.wardCodes !== undefined) {
    const list = normalizeWards(data.wardCodes, data.wardCode);
    sets.push(`ward_code = $${idx++}`); params.push(list[0] ?? null);
    sets.push(`ward_codes = $${idx++}`); params.push(list);
  }
  if (data.regionCodes !== undefined) { sets.push(`region_codes = $${idx++}`); params.push(data.regionCodes); }
  if (data.isActive !== undefined) { sets.push(`is_active = $${idx++}`); params.push(data.isActive); }
  if (data.avatarMediaId !== undefined) { sets.push(`avatar_media_id = $${idx++}`); params.push(data.avatarMediaId); }
  if (data.bio !== undefined) { sets.push(`bio = $${idx++}`); params.push(data.bio); }
  if (data.title !== undefined) { sets.push(`title = $${idx++}`); params.push(data.title); }

  // Permission overrides replace the stored arrays wholesale. A change bumps
  // token_version so the target's live sessions re-refresh and pick up the new
  // capability list (server-side enforcement is already live via authenticate).
  let overridesChanged = false;
  let grants = row.permission_grants ?? [];
  let revokes = row.permission_revokes ?? [];
  if (data.permissionGrants !== undefined || data.permissionRevokes !== undefined) {
    grants = sanitizeOverrides(data.permissionGrants ?? [], actor);
    revokes = sanitizeOverrides(data.permissionRevokes ?? [], actor);
    overridesChanged =
      !sameSet(grants, row.permission_grants ?? []) ||
      !sameSet(revokes, row.permission_revokes ?? []);
    sets.push(`permission_grants = $${idx++}`); params.push(grants);
    sets.push(`permission_revokes = $${idx++}`); params.push(revokes);
    if (overridesChanged) { sets.push(`token_version = token_version + 1`); }
  }

  if (data.email !== undefined) {
    const email = data.email.trim().toLowerCase();
    // Merge with any other sealed fields (e.g. fullName) before re-sealing.
    const current = row.sealed_pii ? await reveal(row) : { email: null, fullName: null };
    const sealed = await sealRecord(id, {
      email,
      fullName: current.fullName ?? email,
    });
    sets.push(`email_bidx = $${idx++}`); params.push(blindIndex('email', email));
    sets.push(`sealed_pii = $${idx++}::jsonb`); params.push(JSON.stringify(sealed));
  }

  if (sets.length > 0) {
    params.push(id);
    await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`, params);
  }

  await recordAudit({
    action: 'role.change',
    actorId: actor?.actorId ?? null,
    actorRole: actor?.actorRole ?? null,
    targetType: 'user',
    targetId: id,
    ip: actor?.ip ?? null,
    userAgent: actor?.userAgent ?? null,
    metadata: {
      op: 'update',
      role: data.role,
      isActive: data.isActive,
      emailChanged: data.email !== undefined,
      permissionsChanged: overridesChanged,
      permissionGrants: overridesChanged ? grants : undefined,
      permissionRevokes: overridesChanged ? revokes : undefined,
    },
  });

  await syncCouncillorLeader(id);
  return getUser(id);
}

export async function deleteUser(id: string, actor?: ActorCtx): Promise<{ success: boolean }> {
  await query(`DELETE FROM users WHERE id = $1`, [id]);
  await recordAudit({
    action: 'role.change',
    actorId: actor?.actorId ?? null,
    actorRole: actor?.actorRole ?? null,
    targetType: 'user',
    targetId: id,
    ip: actor?.ip ?? null,
    userAgent: actor?.userAgent ?? null,
    metadata: { op: 'delete' },
  });
  return { success: true };
}

export async function resetPassword(id: string, newPassword: string, actor?: ActorCtx): Promise<{ success: boolean }> {
  const passwordHash = await hashPassword(newPassword);
  const res = await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, id]);
  if (res.rowCount === 0) throw ApiError.notFound('User not found');
  await recordAudit({
    action: 'role.change',
    actorId: actor?.actorId ?? null,
    actorRole: actor?.actorRole ?? null,
    targetType: 'user',
    targetId: id,
    ip: actor?.ip ?? null,
    userAgent: actor?.userAgent ?? null,
    metadata: { op: 'reset_password' },
  });
  return { success: true };
}

export async function getRolePermissions(role: string) {
  const { ROLE_PERMISSIONS } = await import('../../auth/permissions.js');
  return ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS] ?? [];
}
