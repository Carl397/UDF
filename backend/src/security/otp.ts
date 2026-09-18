import { randomInt } from 'node:crypto';
import { query } from '../db/pool.js';
import { hashPassword, verifyPassword } from './password.js';

/**
 * Email one-time PINs (PRD-growth FR-P2, PRD.md FR-H).
 *
 * A 6-digit code is the member's FIRST password: registration provisions an
 * account with `must_change_password = TRUE` and a random unusable password,
 * emails an OTP, and login accepts the OTP *as* the password (auth/service.ts)
 * before forcing a private one.
 *
 * At rest the code is an argon2id hash (the same primitive as passwords) — a
 * salted hash, so a DB leak cannot be replayed and an offline brute force of a
 * 6-digit space is made expensive. Online guessing is blunted twice over: a
 * per-code attempt cap (consumes/locks the row) and the login rate limiter.
 * Rows are consumed on success or lock, and `purgeExpiredOtps` reaps the rest,
 * so a code never outlives its short TTL by more than the sweep interval.
 */

export type OtpPurpose = 'onboarding' | 'login' | 'password_reset' | 'ward_change';

/** Code lifetime. Short: it is a first-password, not a session. */
export const OTP_TTL_MS = 10 * 60 * 1000;
/** Wrong-entry ceiling before the code is consumed (locked). */
export const OTP_MAX_ATTEMPTS = 5;

/** A cryptographically-random 6-digit code (zero-padded, uniform). */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export interface IssuedOtp {
  code: string;
  expiresAt: string;
}

/**
 * Issue a fresh code for (user, purpose), consuming any prior live one so only
 * the newest is verifiable. Returns the PLAINTEXT code once — the caller emails
 * it and nothing persists it in clear.
 */
export async function issueOtp(userId: string, purpose: OtpPurpose): Promise<IssuedOtp> {
  const code = generateOtp();
  const codeHash = await hashPassword(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await query(
    `UPDATE email_otps SET consumed_at = now()
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [userId, purpose],
  );
  await query(
    `INSERT INTO email_otps (user_id, purpose, code_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, purpose, codeHash, expiresAt.toISOString()],
  );
  return { code, expiresAt: expiresAt.toISOString() };
}

export type OtpResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'expired' | 'locked' | 'mismatch' };

/**
 * Verify a submitted code against the newest live OTP for (user, purpose).
 * Consumes the row on success; increments `attempts` on a miss and consumes
 * (locks) once the attempt ceiling is reached. Never reveals which of the
 * failure modes occurred to the caller's user — auth maps all to one message.
 */
export async function verifyOtp(
  userId: string,
  purpose: OtpPurpose,
  code: string,
): Promise<OtpResult> {
  const res = await query<{ id: string; code_hash: string; attempts: number; expires_at: string }>(
    `SELECT id, code_hash, attempts, expires_at
       FROM email_otps
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, purpose],
  );
  const row = res.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await query(`UPDATE email_otps SET consumed_at = now() WHERE id = $1`, [row.id]);
    return { ok: false, reason: 'expired' };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await query(`UPDATE email_otps SET consumed_at = now() WHERE id = $1`, [row.id]);
    return { ok: false, reason: 'locked' };
  }

  const match = await verifyPassword(row.code_hash, code.trim());
  if (match) {
    await query(`UPDATE email_otps SET consumed_at = now() WHERE id = $1`, [row.id]);
    return { ok: true };
  }
  await query(`UPDATE email_otps SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
  return { ok: false, reason: 'mismatch' };
}

/** True when the account has an unexpired, unconsumed code for this purpose. */
export async function hasLiveOtp(userId: string, purpose: OtpPurpose): Promise<boolean> {
  const res = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM email_otps
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()`,
    [userId, purpose],
  );
  return Number(res.rows[0]?.c ?? 0) > 0;
}

/** Milliseconds until a fresh code may be issued (resend cooldown), else 0. */
export async function otpResendCooldownMs(
  userId: string,
  purpose: OtpPurpose,
  cooldownMs: number,
): Promise<number> {
  const res = await query<{ created_at: string }>(
    `SELECT created_at FROM email_otps
      WHERE user_id = $1 AND purpose = $2
      ORDER BY created_at DESC LIMIT 1`,
    [userId, purpose],
  );
  const last = res.rows[0]?.created_at;
  if (!last) return 0;
  const elapsed = Date.now() - new Date(last).getTime();
  return Math.max(0, cooldownMs - elapsed);
}

/** Housekeeping: hard-delete consumed or expired rows (POPIA §7 — no lingering codes). */
export async function purgeExpiredOtps(): Promise<number> {
  const res = await query(
    `DELETE FROM email_otps WHERE consumed_at IS NOT NULL OR expires_at <= now()`,
  );
  return res.rowCount ?? 0;
}
