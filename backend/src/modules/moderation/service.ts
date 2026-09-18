import { query, withTransaction } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import { openRecord, type SealedRecord } from '../../security/encryption.js';
import { blindIndex } from '../../security/blindIndex.js';
import { recordAudit } from '../../security/audit.js';
import type { ApplyActionInput, ListUsersQuery } from './schemas.js';

/**
 * Moderation service — the enforcement back-office for the ban/suspend ladder
 * and device bans.
 *
 * Design notes:
 * - Account actions mutate `users` and, for suspend/ban, immediately revoke all
 *   refresh tokens AND bump `token_version` so already-issued access tokens are
 *   rejected by `authenticate` before their natural expiry.
 * - Every action is written to `moderation_actions` (queryable history) and to
 *   the hash-chained `audit_log` (tamper-evident, non-repudiation).
 * - Email/fullName are sealed; we reveal them best-effort for the moderator UI
 *   exactly like the CRM user surface (MODERATE_USERS is national-admin only).
 */

export interface ActorCtx {
  actorId?: string | null;
  actorRole?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

interface ModUserRow {
  id: string;
  role: string;
  region_codes: string[];
  ward_code: string | null;
  is_active: boolean;
  moderation_status: string;
  suspended_until: string | null;
  token_version: number;
  tc_version: string | null;
  tc_accepted_at: string | null;
  created_at: string;
  sealed_pii: SealedRecord | null;
}

export interface ModerationUser {
  id: string;
  email: string | null;
  fullName: string | null;
  role: string;
  regionCodes: string[];
  wardCode: string | null;
  isActive: boolean;
  moderationStatus: string;
  suspendedUntil: string | null;
  tcVersion: string | null;
  tcAcceptedAt: string | null;
  createdAt: string;
}

const SELECT_COLS = `id, role, region_codes, ward_code, is_active, moderation_status,
  suspended_until, token_version, tc_version, tc_accepted_at, created_at, sealed_pii`;

async function reveal(row: ModUserRow): Promise<{ email: string | null; fullName: string | null }> {
  if (!row.sealed_pii) return { email: null, fullName: null };
  try {
    const opened = await openRecord(row.id, row.sealed_pii);
    return { email: opened.email ?? null, fullName: opened.fullName ?? null };
  } catch {
    return { email: null, fullName: null };
  }
}

function toPublic(row: ModUserRow, pii: { email: string | null; fullName: string | null }): ModerationUser {
  return {
    id: row.id,
    email: pii.email,
    fullName: pii.fullName,
    role: row.role,
    regionCodes: row.region_codes ?? [],
    wardCode: row.ward_code,
    isActive: row.is_active,
    moderationStatus: row.moderation_status,
    suspendedUntil: row.suspended_until,
    tcVersion: row.tc_version,
    tcAcceptedAt: row.tc_accepted_at,
    createdAt: row.created_at,
  };
}

/** Paginated list of accounts for the moderation queue. */
export async function listUsers(filters: ListUsersQuery) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters.role) {
    conditions.push(`role = $${idx++}`);
    params.push(filters.role);
  }
  if (filters.status) {
    conditions.push(`moderation_status = $${idx++}`);
    params.push(filters.status);
  }
  // Email is sealed → exact-match lookup via the blind index (same as CRM).
  if (filters.search) {
    conditions.push(`email_bidx = $${idx++}`);
    params.push(blindIndex('email', filters.search.trim().toLowerCase()));
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit;
  const offset = filters.offset;

  const [countRes, dataRes] = await Promise.all([
    query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM users ${where}`, params),
    query<ModUserRow>(
      `SELECT ${SELECT_COLS} FROM users ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    ),
  ]);

  const items = await Promise.all(dataRes.rows.map(async (row) => toPublic(row, await reveal(row))));
  return { items, total: parseInt(countRes.rows[0]?.total ?? '0', 10), limit, offset };
}

export interface ModerationActionRow {
  id: string;
  action: string;
  reason: string;
  expiresAt: string | null;
  actorId: string | null;
  actorRole: string | null;
  deviceId: string | null;
  createdAt: string;
}

export interface AuditRow {
  seq: number;
  action: string;
  actorId: string | null;
  actorRole: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** Full moderation profile for one account: status + T&C + history + audit. */
export async function getProfile(userId: string) {
  const res = await query<ModUserRow>(`SELECT ${SELECT_COLS} FROM users WHERE id = $1`, [userId]);
  const row = res.rows[0];
  if (!row) throw ApiError.notFound('User not found');

  const [actionsRes, auditRes] = await Promise.all([
    query<{
      id: string; action: string; reason: string; expires_at: string | null;
      actor_id: string | null; actor_role: string | null; device_id: string | null; created_at: string;
    }>(
      `SELECT id, action, reason, expires_at, actor_id, actor_role, device_id, created_at
         FROM moderation_actions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [userId],
    ),
    query<{
      seq: number; action: string; actor_id: string | null; actor_role: string | null;
      target_type: string | null; target_id: string | null; metadata: Record<string, unknown> | null; created_at: string;
    }>(
      `SELECT seq, action, actor_id, actor_role, target_type, target_id, metadata, created_at
         FROM audit_log
        WHERE actor_id = $1::uuid OR target_id = $1::text
        ORDER BY seq DESC
        LIMIT 100`,
      [userId],
    ),
  ]);

  const actions: ModerationActionRow[] = actionsRes.rows.map((a) => ({
    id: a.id,
    action: a.action,
    reason: a.reason,
    expiresAt: a.expires_at,
    actorId: a.actor_id,
    actorRole: a.actor_role,
    deviceId: a.device_id,
    createdAt: a.created_at,
  }));
  const audit: AuditRow[] = auditRes.rows.map((r) => ({
    seq: r.seq,
    action: r.action,
    actorId: r.actor_id,
    actorRole: r.actor_role,
    targetType: r.target_type,
    targetId: r.target_id,
    metadata: r.metadata,
    createdAt: r.created_at,
  }));

  return { user: toPublic(row, await reveal(row)), actions, audit };
}

export interface BannedDevice {
  deviceId: string;
  reason: string;
  active: boolean;
  bannedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Currently (and previously) banned devices, newest first. */
export async function listDevices(limit = 100, offset = 0): Promise<{ items: BannedDevice[]; limit: number; offset: number }> {
  const res = await query<{
    device_id: string; reason: string; active: boolean; banned_by: string | null;
    created_at: string; updated_at: string;
  }>(
    `SELECT device_id, reason, active, banned_by, created_at, updated_at
       FROM banned_devices
      ORDER BY updated_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return {
    items: res.rows.map((d) => ({
      deviceId: d.device_id,
      reason: d.reason,
      active: d.active,
      bannedBy: d.banned_by,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    })),
    limit,
    offset,
  };
}

/** Revoke every live session for a user: refresh tokens + access-token version. */
async function revokeSessions(client: import('pg').PoolClient, userId: string): Promise<void> {
  await client.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

async function insertAction(
  client: import('pg').PoolClient,
  row: {
    userId: string | null;
    deviceId: string | null;
    action: string;
    reason: string;
    expiresAt: Date | null;
    actor: ActorCtx;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO moderation_actions (user_id, device_id, action, reason, expires_at, actor_id, actor_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      row.userId,
      row.deviceId,
      row.action,
      row.reason,
      row.expiresAt,
      row.actor.actorId ?? null,
      row.actor.actorRole ?? null,
    ],
  );
}

export interface ApplyActionResult {
  action: string;
  userId?: string;
  deviceId?: string;
  moderationStatus?: string;
  isActive?: boolean;
  suspendedUntil?: string | null;
}

/**
 * Apply one moderation action atomically. Account actions run in a transaction
 * that also revokes sessions (suspend/ban) so enforcement is immediate.
 */
export async function applyAction(input: ApplyActionInput, actor: ActorCtx): Promise<ApplyActionResult> {
  const reason = input.reason.trim();

  // ── Device actions ──────────────────────────────────────────────────────
  if (input.action === 'device_ban' || input.action === 'device_unban') {
    const deviceId = input.deviceId!;
    const active = input.action === 'device_ban';
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO banned_devices (device_id, reason, banned_by, active)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (device_id) DO UPDATE
           SET reason = EXCLUDED.reason,
               banned_by = EXCLUDED.banned_by,
               active = EXCLUDED.active,
               updated_at = now()`,
        [deviceId, reason, actor.actorId ?? null, active],
      );
      await insertAction(client, {
        userId: null, deviceId, action: input.action, reason, expiresAt: null, actor,
      });
    });
    await recordAudit({
      action: `moderation.${input.action}`,
      actorId: actor.actorId ?? null,
      actorRole: actor.actorRole ?? null,
      targetType: 'device',
      targetId: deviceId,
      metadata: { reason },
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
    });
    return { action: input.action, deviceId };
  }

  // ── Account actions ─────────────────────────────────────────────────────
  const userId = input.userId!;
  const check = await query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [userId]);
  if (check.rowCount === 0) throw ApiError.notFound('User not found');

  let suspendedUntil: Date | null = null;
  if (input.action === 'suspend') {
    suspendedUntil = new Date(Date.now() + (input.durationDays! * 24 * 60 * 60 * 1000));
  }

  await withTransaction(async (client) => {
    switch (input.action) {
      case 'warn':
        // A warning never escalates over a stronger state (suspended/banned).
        await client.query(
          `UPDATE users SET moderation_status = 'warned'
            WHERE id = $1 AND moderation_status IN ('active','warned')`,
          [userId],
        );
        break;
      case 'suspend':
        await client.query(
          `UPDATE users
              SET moderation_status = 'suspended',
                  suspended_until = $2,
                  token_version = token_version + 1
            WHERE id = $1`,
          [userId, suspendedUntil],
        );
        await revokeSessions(client, userId);
        break;
      case 'ban':
        await client.query(
          `UPDATE users
              SET is_active = FALSE,
                  moderation_status = 'banned',
                  suspended_until = NULL,
                  token_version = token_version + 1
            WHERE id = $1`,
          [userId],
        );
        await revokeSessions(client, userId);
        break;
      case 'reinstate':
        await client.query(
          `UPDATE users
              SET is_active = TRUE,
                  moderation_status = 'active',
                  suspended_until = NULL,
                  token_version = token_version + 1
            WHERE id = $1`,
          [userId],
        );
        break;
      default:
        throw ApiError.badRequest(`Unsupported action: ${input.action}`);
    }
    await insertAction(client, {
      userId, deviceId: null, action: input.action, reason, expiresAt: suspendedUntil, actor,
    });
  });

  await recordAudit({
    action: `moderation.${input.action}`,
    actorId: actor.actorId ?? null,
    actorRole: actor.actorRole ?? null,
    targetType: 'user',
    targetId: userId,
    metadata: { reason, durationDays: input.durationDays ?? null },
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });

  const after = await query<ModUserRow>(`SELECT ${SELECT_COLS} FROM users WHERE id = $1`, [userId]);
  const u = after.rows[0]!;
  return {
    action: input.action,
    userId,
    moderationStatus: u.moderation_status,
    isActive: u.is_active,
    suspendedUntil: u.suspended_until,
  };
}
