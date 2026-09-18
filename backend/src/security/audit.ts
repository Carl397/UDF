import { createHash, randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { logger } from '../config/logger.js';

/**
 * Append-only, tamper-evident audit log.
 *
 * Each entry stores the hash of the previous entry, forming a hash chain.
 * Altering or deleting any historical row breaks the chain and is detectable
 * via {@link verifyChain}. This gives non-repudiation for sensitive actions
 * (PII access, exports, permission changes) without a WORM store.
 */

export type AuditAction =
  | 'member.create'
  | 'member.read'
  | 'member.update'
  | 'member.delete'
  | 'member.pii.decrypt'
  | 'member.export'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'consent.update'
  | 'role.grant'
  | 'role.revoke';

export interface AuditEntryInput {
  action: AuditAction | string;
  actorId?: string | null;
  actorRole?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  regionCode?: string | null;
  /** Non-sensitive metadata only. Never put plaintext PII here. */
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Normalize the payload to a FIXED key set with explicit nulls. Both the write
 * path and the verify path MUST produce byte-identical JSON, so optional input
 * keys are coerced to null here rather than being omitted/undefined.
 */
function normalizePayload(p: AuditEntryInput) {
  return {
    action: p.action,
    actorId: p.actorId ?? null,
    actorRole: p.actorRole ?? null,
    targetType: p.targetType ?? null,
    targetId: p.targetId ?? null,
    regionCode: p.regionCode ?? null,
    metadata: p.metadata ?? null,
    ip: p.ip ?? null,
    userAgent: p.userAgent ?? null,
  };
}

/** Deterministic canonicalization so the hash is reproducible. */
function canonical(entry: {
  id: string;
  prevHash: string;
  createdAt: string;
  payload: AuditEntryInput;
}): string {
  return JSON.stringify({
    id: entry.id,
    prevHash: entry.prevHash,
    createdAt: entry.createdAt,
    payload: normalizePayload(entry.payload),
  });
}

const GENESIS_HASH = '0'.repeat(64);

/**
 * Append an audit entry inside a transaction that also reads the last hash,
 * so concurrent writers cannot fork the chain.
 */
export async function recordAudit(input: AuditEntryInput): Promise<void> {
  try {
    await withTransaction(async (client) => {
      const last = await client.query<{ entry_hash: string }>(
        'SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1 FOR UPDATE',
      );
      const prevHash = last.rows[0]?.entry_hash ?? GENESIS_HASH;
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const payload = input;
      const entryHash = sha256(canonical({ id, prevHash, createdAt, payload }));

      await client.query(
        `INSERT INTO audit_log
           (id, prev_hash, entry_hash, action, actor_id, actor_role,
            target_type, target_id, region_code, metadata, ip, user_agent, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          prevHash,
          entryHash,
          payload.action,
          payload.actorId ?? null,
          payload.actorRole ?? null,
          payload.targetType ?? null,
          payload.targetId ?? null,
          payload.regionCode ?? null,
          payload.metadata ? JSON.stringify(payload.metadata) : null,
          payload.ip ?? null,
          payload.userAgent ?? null,
          createdAt,
        ],
      );
    });
  } catch (err) {
    // Audit failures must be loud but should not silently corrupt state.
    logger.error({ err }, 'Failed to write audit entry');
    throw err;
  }
}

/** Recompute the chain and report the first broken link (if any). */
export async function verifyChain(): Promise<{
  ok: boolean;
  brokenAtSeq?: number;
  checked: number;
}> {
  const res = await query<{
    seq: number;
    id: string;
    prev_hash: string;
    entry_hash: string;
    created_at: string;
    action: string;
    actor_id: string | null;
    actor_role: string | null;
    target_type: string | null;
    target_id: string | null;
    region_code: string | null;
    metadata: Record<string, unknown> | null;
    ip: string | null;
    user_agent: string | null;
  }>('SELECT * FROM audit_log ORDER BY seq ASC');

  let expectedPrev = GENESIS_HASH;
  for (const row of res.rows) {
    const payload: AuditEntryInput = {
      action: row.action,
      actorId: row.actor_id,
      actorRole: row.actor_role,
      targetType: row.target_type,
      targetId: row.target_id,
      regionCode: row.region_code,
      metadata: row.metadata ?? undefined,
      ip: row.ip,
      userAgent: row.user_agent,
    };
    const recomputed = sha256(
      canonical({
        id: row.id,
        prevHash: row.prev_hash,
        createdAt: new Date(row.created_at).toISOString(),
        payload,
      }),
    );
    if (row.prev_hash !== expectedPrev || recomputed !== row.entry_hash) {
      return { ok: false, brokenAtSeq: row.seq, checked: res.rowCount ?? 0 };
    }
    expectedPrev = row.entry_hash;
  }
  return { ok: true, checked: res.rowCount ?? 0 };
}
