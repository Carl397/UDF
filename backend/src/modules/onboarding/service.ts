import { randomBytes, randomUUID } from 'node:crypto';
import { query } from '../../db/pool.js';
import { openRecord, sealRecord } from '../../security/encryption.js';
import { blindIndex } from '../../security/blindIndex.js';
import { hashPassword } from '../../security/password.js';
import { issueOtp, otpResendCooldownMs } from '../../security/otp.js';
import { sendEmail } from '../../security/mailer.js';
import { recordAudit } from '../../security/audit.js';
import { buildStarterPackEmail } from './starterPack.js';

/**
 * Member onboarding (PRD-growth FR-P1/P2 + FR-Q1).
 *
 * Registration creates a `members` row but no login. This service closes that
 * gap (PRD §3.1): it provisions a bound `users` account (role `member`,
 * `must_change_password = TRUE`, a random password the member never sees),
 * issues a 6-digit OTP, and emails it inside the starter pack. Login then
 * accepts the OTP *as* the first password (auth/service.ts) and forces a private
 * one (migration 013 mechanism, reused as-is).
 *
 * Everything here is IDEMPOTENT and BEST-EFFORT: a member is provisioned once
 * (guarded by `users.member_id` + `email_bidx`), and a mail/OTP failure never
 * throws back into registration — the member can request a resend (FR-P5).
 */

/** FR-P2: minimum gap between OTP re-issues. */
const RESEND_COOLDOWN_MS = 60_000;

interface Ctx {
  ip?: string | null;
  userAgent?: string | null;
  actorId?: string | null;
}

export interface ProvisionResult {
  provisioned: boolean;
  userId: string | null;
  otpSent: boolean;
  /** Why nothing happened (flag off, no member, no email, already done). */
  skipped?: string;
}

/** Read a feature flag; unknown keys fall back to `fallback`. */
async function isFlagEnabled(key: string, fallback: boolean): Promise<boolean> {
  const res = await query<{ enabled: boolean }>(`SELECT enabled FROM feature_flags WHERE key = $1`, [key]);
  const row = res.rows[0];
  return row ? row.enabled : fallback;
}

interface MemberFacts {
  id: string;
  membershipNo: string;
  publicCode: string;
  wardCode: string | null;
  regionCode: string | null;
  email: string;
  fullName: string;
}

async function loadMemberFacts(memberId: string): Promise<MemberFacts | null> {
  const res = await query<{
    id: string; membership_no: string | null; public_code: string | null;
    ward: string | null; region_code: string | null; sealed_pii: any;
  }>(
    `SELECT id, membership_no, public_code, ward, region_code, sealed_pii
       FROM members WHERE id = $1 AND deleted_at IS NULL`,
    [memberId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const opened = (await openRecord(row.id, row.sealed_pii)) as Record<string, string>;
  const email = opened.email;
  if (!email) return null;
  return {
    id: row.id,
    membershipNo: row.membership_no ?? row.public_code ?? 'UDF',
    publicCode: row.public_code ?? '',
    wardCode: row.ward,
    regionCode: row.region_code,
    email,
    fullName: opened.fullName ?? 'UDF Member',
  };
}

/**
 * Provision (once) the login account for a member, issue an onboarding OTP and
 * email the starter pack. Safe to call from registration, confirmation and the
 * backfill script alike.
 */
export async function provisionMemberUser(
  memberId: string,
  ctx: Ctx = {},
  opts: { onlyIfMissing?: boolean; send?: boolean } = {},
): Promise<ProvisionResult> {
  if (!(await isFlagEnabled('onboarding.otp', true))) {
    return { provisioned: false, userId: null, otpSent: false, skipped: 'flag_off' };
  }

  const facts = await loadMemberFacts(memberId);
  if (!facts) return { provisioned: false, userId: null, otpSent: false, skipped: 'no_member_or_email' };

  const emailBidx = blindIndex('email', facts.email);

  // Already bound to an account? Reuse it (idempotent) — no second OTP unless
  // the caller is an explicit resend.
  let userId: string | null = null;
  const linked = await query<{ id: string }>(`SELECT id FROM users WHERE member_id = $1 LIMIT 1`, [memberId]);
  userId = linked.rows[0]?.id ?? null;

  // Confirm-time provisioning is a BACKFILL for members who registered before
  // this feature (or while the flag was off): if an account already exists, do
  // not re-issue an OTP or re-send the starter pack (that would double-email).
  if (userId && opts.onlyIfMissing) {
    return { provisioned: false, userId, otpSent: false, skipped: 'already_provisioned' };
  }

  if (!userId) {
    // An account may already exist for this email (a staff user, or a member who
    // registered twice). Bind it to the member rather than colliding on bidx.
    const byEmail = await query<{ id: string; member_id: string | null }>(
      `SELECT id, member_id FROM users WHERE email_bidx = $1 LIMIT 1`,
      [emailBidx],
    );
    if (byEmail.rows[0]) {
      userId = byEmail.rows[0]!.id;
      if (!byEmail.rows[0]!.member_id) {
        await query(`UPDATE users SET member_id = $1 WHERE id = $2 AND member_id IS NULL`, [memberId, userId]);
      }
    }
  }

  let created = false;
  if (!userId) {
    const id = randomUUID();
    // A random password the member never sees: the account is unusable until the
    // OTP login + forced change. Re-seal the PII with the USER id as AAD context.
    const randomPassword = randomBytes(24).toString('base64url');
    const [passwordHash, sealed] = await Promise.all([
      hashPassword(randomPassword),
      sealRecord(id, { email: facts.email, fullName: facts.fullName }),
    ]);
    const regionCodes = facts.regionCode ? [facts.regionCode] : [];
    // Bare ON CONFLICT DO NOTHING covers BOTH unique keys (email_bidx, member_id)
    // so a concurrent provision can never error or duplicate.
    const ins = await query<{ id: string }>(
      `INSERT INTO users
         (id, email_bidx, password_hash, role, region_codes, ward_code, sealed_pii, must_change_password, member_id)
       VALUES ($1,$2,$3,'member',$4,$5,$6::jsonb,TRUE,$7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [id, emailBidx, passwordHash, regionCodes, facts.wardCode, JSON.stringify(sealed), memberId],
    );
    userId = ins.rows[0]?.id ?? null;
    created = Boolean(userId);
    if (!userId) {
      const again = await query<{ id: string }>(
        `SELECT id FROM users WHERE member_id = $1 OR email_bidx = $2 LIMIT 1`,
        [memberId, emailBidx],
      );
      userId = again.rows[0]?.id ?? null;
      if (userId) {
        await query(`UPDATE users SET member_id = $1 WHERE id = $2 AND member_id IS NULL`, [memberId, userId]);
      }
    }
  }
  if (!userId) return { provisioned: false, userId: null, otpSent: false, skipped: 'no_user' };

  // `send: false` (the backfill script's default) provisions the account but does
  // NOT issue/email an OTP — existing members then use "Resend OTP" to onboard,
  // so a one-time backfill never triggers a mass email blast.
  const send = opts.send ?? true;
  let otpSent = false;
  if (send) {
    const { code } = await issueOtp(userId, 'onboarding');
    if (await isFlagEnabled('onboarding.starterPack', true)) {
      const pack = await buildStarterPackEmail(
        { to: facts.email, fullName: facts.fullName, membershipNo: facts.membershipNo, publicCode: facts.publicCode, wardCode: facts.wardCode },
        code,
      );
      const res = await sendEmail({ to: facts.email, ...pack, template: 'starter_pack', userId });
      otpSent = res.status !== 'failed';
    }
  }

  await recordAudit({
    action: send ? 'auth.otp.issue' : 'user.provision',
    actorId: userId,
    actorRole: 'member',
    targetType: 'member',
    targetId: memberId,
    regionCode: facts.regionCode,
    metadata: { purpose: 'onboarding', provisioned: created, otpSent, emailed: send },
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  return { provisioned: true, userId, otpSent };
}

export interface ResendResult {
  /** Always true — the endpoint never reveals whether the account exists. */
  accepted: boolean;
  resent: boolean;
  cooldownMs?: number;
}

/**
 * FR-P5: re-issue the onboarding OTP and re-send the starter pack. Cooldown +
 * (route-level) rate limit. Deliberately enumeration-safe: an unknown email, a
 * staff account, or one that already changed its password all return the same
 * accepted/resent=false shape.
 */
export async function resendOnboardingOtp(email: string, ctx: Ctx = {}): Promise<ResendResult> {
  const res = await query<{ id: string; member_id: string | null; must_change_password: boolean }>(
    `SELECT id, member_id, must_change_password FROM users WHERE email_bidx = $1 LIMIT 1`,
    [blindIndex('email', email)],
  );
  const row = res.rows[0];
  if (!row || !row.member_id || !row.must_change_password) {
    return { accepted: true, resent: false };
  }

  const cooldown = await otpResendCooldownMs(row.id, 'onboarding', RESEND_COOLDOWN_MS);
  if (cooldown > 0) return { accepted: true, resent: false, cooldownMs: cooldown };

  const facts = await loadMemberFacts(row.member_id);
  if (!facts) return { accepted: true, resent: false };

  const { code } = await issueOtp(row.id, 'onboarding');
  const pack = await buildStarterPackEmail(
    { to: facts.email, fullName: facts.fullName, membershipNo: facts.membershipNo, publicCode: facts.publicCode, wardCode: facts.wardCode },
    code,
  );
  const sent = await sendEmail({ to: facts.email, ...pack, template: 'starter_pack_resend', userId: row.id });

  await recordAudit({
    action: 'auth.otp.resend',
    actorId: row.id,
    actorRole: 'member',
    targetType: 'member',
    targetId: row.member_id,
    regionCode: facts.regionCode,
    metadata: { purpose: 'onboarding', resent: sent.status !== 'failed' },
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  return { accepted: true, resent: sent.status !== 'failed' };
}
