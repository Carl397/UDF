import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import { hashPassword, verifyPassword, needsRehash } from '../../security/password.js';
import { verifyOtp } from '../../security/otp.js';
import { sealRecord } from '../../security/encryption.js';
import { blindIndex } from '../../security/blindIndex.js';
import { recordAudit } from '../../security/audit.js';
import {
  signAccessToken,
  generateRefreshToken,
  refreshExpiry,
} from '../../auth/tokens.js';
import { Role, effectivePermissions, type Permission } from '../../auth/permissions.js';
import { moduleStateForRole } from '../registry/service.js';
import { TERMS_VERSION } from '../public/content.js';

/**
 * Auth service: user provisioning + token issuance/rotation.
 * Refresh tokens are stored only as SHA-256 hashes so a DB leak cannot be
 * replayed. Access tokens are short-lived JWTs.
 */

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(200),
  role: z.nativeEnum(Role).default(Role.MEMBER),
  regionCodes: z.array(z.string().max(32)).default([]),
  wardCode: z.string().max(32).optional(),
  fullName: z.string().min(1).max(200),
});

export const changePasswordSchema = z.object({
  // May be EMPTY only for an OTP-onboarded member completing first-run setup —
  // they never chose a password (their one-time code was consumed at login), so
  // there is nothing to re-type. `changePassword` enforces that: an empty current
  // password is accepted solely for a `member` still behind the first-login gate
  // and rejected (as incorrect) for everyone else.
  currentPassword: z.string().max(200).default(''),
  newPassword: z.string().min(10).max(200),
});

interface UserRow {
  id: string;
  password_hash: string;
  role: string;
  region_codes: string[];
  ward_code: string | null;
  is_active: boolean;
  token_version: number;
  moderation_status: string;
  suspended_until: string | null;
  tc_version: string | null;
  tc_accepted_at: string | null;
  must_change_password: boolean;
  /** Bound member row (FR-P1); null for staff/admin who are not members. */
  member_id: string | null;
  permission_grants: string[] | null;
  permission_revokes: string[] | null;
}

/** Request context shared by login/refresh (ip, UA, and the mobile device id). */
export interface AuthCtx {
  ip?: string | null;
  userAgent?: string | null;
  deviceId?: string | null;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Is this device currently blocked? Keyed by the mobile `x-device-id`.
 * Exported so registration and the moderation surface share one source of truth.
 */
export async function isDeviceBanned(deviceId: string | null | undefined): Promise<boolean> {
  if (!deviceId) return false;
  const res = await query<{ banned: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM banned_devices WHERE device_id = $1 AND active) AS banned`,
    [deviceId],
  );
  return res.rows[0]?.banned ?? false;
}

export async function createUser(input: z.infer<typeof createUserSchema>): Promise<string> {
  const id = randomUUID();
  const [passwordHash, sealed] = await Promise.all([
    hashPassword(input.password),
    sealRecord(id, { email: input.email, fullName: input.fullName }),
  ]);

  const res = await query<{ id: string }>(
    `INSERT INTO users (id, email_bidx, password_hash, role, region_codes, ward_code, sealed_pii)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (email_bidx) DO NOTHING
     RETURNING id`,
    [
      id,
      blindIndex('email', input.email),
      passwordHash,
      input.role,
      input.regionCodes,
      input.wardCode ?? null,
      JSON.stringify(sealed),
    ],
  );
  if (res.rowCount === 0) throw ApiError.conflict('User already exists');
  return id;
}

async function findUserByEmail(email: string): Promise<UserRow | null> {
  const res = await query<UserRow>(
    `SELECT id, password_hash, role, region_codes, ward_code, is_active,
            token_version, moderation_status, suspended_until, tc_version, tc_accepted_at,
            must_change_password, member_id, permission_grants, permission_revokes
       FROM users WHERE email_bidx = $1 LIMIT 1`,
    [blindIndex('email', email)],
  );
  return res.rows[0] ?? null;
}

async function issueRefreshToken(
  userId: string,
  ip?: string | null,
  userAgent?: string | null,
): Promise<string> {
  const token = generateRefreshToken();
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, sha256(token), refreshExpiry(), ip ?? null, userAgent ?? null],
  );
  return token;
}

/**
 * Compute the session's module-filtered permissions and enabled-module list in a
 * single registry read. A module an administrator has switched off for this role
 * has its permissions stripped here, at the session boundary, so the client's
 * capability flags (`lib/caps.ts`) and the server's `requirePermission` agree
 * without either side knowing the module → permission map. `enabledModules`
 * rides along for the UI-only surfaces (`id_cards`) that own no permission.
 */
async function sessionPermissions(
  role: string,
  grants: string[] | null,
  revokes: string[] | null,
): Promise<{ permissions: Permission[]; enabledModules: string[] }> {
  const { disabled, enabled } = await moduleStateForRole(role);
  return {
    permissions: effectivePermissions(role as Role, grants, revokes, disabled),
    enabledModules: enabled,
  };
}

/**
 * The caller's effective permissions (role base ± per-user overrides) are sent
 * on login, refresh and password change alike, so the client can build its UI
 * capability flags from what the server will actually authorise rather than
 * from its own copy of the role matrix. Recomputing on *refresh* matters: an
 * administrator who changes someone's role or overrides does not have to wait
 * for that user to sign out and back in before the UI stops offering actions
 * that now 403. Computed by `effectivePermissions` in auth/permissions.ts.
 */

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  role: string;
  /** True once the user has accepted the currently-published Terms version. */
  tcAccepted: boolean;
  tcVersion: string | null;
  tcCurrentVersion: string;
  /** True when the account must set a new password before using the app. */
  mustChangePassword: boolean;
  /** The caller's effective permissions. See `effectivePermissions`. */
  permissions: Permission[];
  /**
   * The module keys enabled for the caller's role. Permission-backed modules are
   * already reflected in `permissions` (a disabled module's permissions are
   * stripped); this list exists for the UI-only surfaces that own no permission
   * (`id_cards`) and for an explicit "module disabled" empty-state.
   */
  enabledModules: string[];
}

/**
 * A rotated token pair. Deliberately narrower than `LoginResult`: refresh
 * re-sends no role, T&C state or password gate, because none of them can have
 * changed as a side effect of rotating a token — the client keeps what login
 * gave it. Permissions are the exception, since a role change by an
 * administrator is exactly the thing a refresh should pick up.
 */
export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  permissions: Permission[];
  /** Enabled module keys, recomputed like `permissions` — see `LoginResult`. */
  enabledModules: string[];
}

export async function login(
  input: z.infer<typeof loginSchema>,
  ctx: AuthCtx,
): Promise<LoginResult> {
  // A blocked device cannot sign in, regardless of whose credentials are used.
  if (await isDeviceBanned(ctx.deviceId)) {
    await recordAudit({
      action: 'auth.login_blocked',
      actorId: null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: 'device_banned', deviceId: ctx.deviceId },
    });
    throw new ApiError(403, 'device_banned', 'This device has been blocked from signing in.');
  }

  const user = await findUserByEmail(input.email);

  // Always run a hash verify to reduce user-enumeration timing signal.
  const passwordOk = user ? await verifyPassword(user.password_hash, input.password) : false;

  // FR-P3: a provisioned-but-not-yet-onboarded account (must_change_password)
  // signs in with the emailed OTP AS its first password. Tried only when the real
  // password did not match AND the account is still pre-change, so an established
  // password can never be bypassed with a stale code. verifyOtp consumes the code.
  let otpOk = false;
  if (user && !passwordOk && user.must_change_password) {
    const otp = await verifyOtp(user.id, 'onboarding', input.password);
    otpOk = otp.ok;
    await recordAudit({
      action: otp.ok ? 'auth.otp.verify' : 'auth.otp.fail',
      actorId: user.id,
      actorRole: user.role,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { purpose: 'onboarding', ...(otp.ok ? {} : { reason: otp.reason }) },
    });
  }

  const ok = passwordOk || otpOk;
  if (!user || !ok) {
    await recordAudit({
      action: 'auth.login_failed',
      actorId: user?.id ?? null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: !user ? 'unknown_user' : 'bad_credentials' },
    });
    throw ApiError.unauthorized('Invalid credentials');
  }

  // Credentials are proven, so revealing account status is not an enumeration
  // oracle. A ban (or admin deactivation) is permanent until reinstated; a
  // suspension is temporary and reports when it lifts.
  if (user.moderation_status === 'banned' || !user.is_active) {
    await recordAudit({
      action: 'auth.login_blocked',
      actorId: user.id,
      actorRole: user.role,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: 'banned' },
    });
    throw new ApiError(
      403,
      'account_banned',
      'This account has been banned. Contact support if you believe this is a mistake.',
    );
  }
  if (user.suspended_until && new Date(user.suspended_until).getTime() > Date.now()) {
    await recordAudit({
      action: 'auth.login_blocked',
      actorId: user.id,
      actorRole: user.role,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: 'suspended' },
    });
    throw new ApiError(403, 'account_suspended', 'This account is temporarily suspended.', {
      suspendedUntil: user.suspended_until,
    });
  }

  // Rehash only on a real password login: on an OTP login `input.password` is the
  // one-time code, which must never become the stored password hash — the forced
  // change that follows sets the real one.
  if (passwordOk && needsRehash(user.password_hash)) {
    const upgraded = await hashPassword(input.password);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [upgraded, user.id]);
  }

  // An OTP delivered to the member's own inbox proves control of it, so it also
  // completes membership confirmation for a still-pending recruit — the confirm
  // link and OTP onboarding are two doors to the same proof (and it keeps the
  // recruitment report's active/pending split honest for OTP-onboarded members).
  if (otpOk && user.member_id) {
    await query(
      `UPDATE members
          SET status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
              joined_at = COALESCE(joined_at, now())
        WHERE id = $1`,
      [user.member_id],
    );
  }

  const accessToken = signAccessToken(
    {
      sub: user.id,
      role: user.role as Role,
      regionCodes: user.region_codes,
      wardCode: user.ward_code ?? undefined,
      email: input.email,
    },
    user.token_version,
  );
  const refreshToken = await issueRefreshToken(user.id, ctx.ip, ctx.userAgent);

  await recordAudit({
    action: 'auth.login',
    actorId: user.id,
    actorRole: user.role,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  const access = await sessionPermissions(
    user.role,
    user.permission_grants,
    user.permission_revokes,
  );
  return {
    accessToken,
    refreshToken,
    role: user.role,
    tcAccepted: user.tc_version === TERMS_VERSION,
    tcVersion: user.tc_version,
    tcCurrentVersion: TERMS_VERSION,
    mustChangePassword: user.must_change_password,
    permissions: access.permissions,
    enabledModules: access.enabledModules,
  };
}

export async function refresh(
  token: string,
  ctx: AuthCtx,
): Promise<RefreshResult> {
  const res = await query<{ id: string; user_id: string; role: string; region_codes: string[]; ward_code: string | null; expires_at: string; revoked_at: string | null; is_active: boolean; moderation_status: string; suspended_until: string | null; token_version: number; permission_grants: string[] | null; permission_revokes: string[] | null }>(
    `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
            u.role, u.region_codes, u.ward_code, u.is_active,
            u.moderation_status, u.suspended_until, u.token_version,
            u.permission_grants, u.permission_revokes
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1 LIMIT 1`,
    [sha256(token)],
  );
  const row = res.rows[0];
  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
    throw ApiError.unauthorized('Invalid refresh token');
  }

  // Enforce moderation on the refresh path too, so a ban/suspend/device-ban
  // takes effect at the next rotation rather than when the access token lapses.
  if (await isDeviceBanned(ctx.deviceId)) {
    throw new ApiError(403, 'device_banned', 'This device has been blocked from signing in.');
  }
  if (!row.is_active || row.moderation_status === 'banned') {
    throw new ApiError(403, 'account_banned', 'This account is no longer active.');
  }
  if (row.suspended_until && new Date(row.suspended_until).getTime() > Date.now()) {
    throw new ApiError(403, 'account_suspended', 'This account is temporarily suspended.', {
      suspendedUntil: row.suspended_until,
    });
  }

  // Rotate: revoke the used token, issue a new pair (limits replay window).
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);

  // Role and region scope are carried over so a refreshed token grants exactly
  // what a fresh login would. The email claim is deliberately not: it is sealed
  // PII in `users.sealed_pii`, and re-decrypting it on every refresh would put a
  // hash-chained audit write on the auth hot path. The browser keeps the address
  // it signed in with instead.
  const accessToken = signAccessToken(
    {
      sub: row.user_id,
      role: row.role as Role,
      regionCodes: row.region_codes,
      wardCode: row.ward_code ?? undefined,
    },
    row.token_version,
  );
  const refreshToken = await issueRefreshToken(row.user_id, ctx.ip, ctx.userAgent);
  // Recomputed from the role + overrides as they stand NOW, not as they were at
  // login, so a role or permission change reaches the client's UI at rotation.
  const access = await sessionPermissions(
    row.role,
    row.permission_grants,
    row.permission_revokes,
  );
  return {
    accessToken,
    refreshToken,
    permissions: access.permissions,
    enabledModules: access.enabledModules,
  };
}

export async function logout(token: string): Promise<void> {
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
    sha256(token),
  ]);
}

/**
 * Record the user's acceptance of the currently-published Terms. Acceptance is
 * versioned, so bumping `TERMS_VERSION` asks everyone to re-accept on next login.
 */
export async function acceptTerms(
  userId: string,
  ctx: AuthCtx,
): Promise<{ tcVersion: string; tcAcceptedAt: string }> {
  const tcAcceptedAt = new Date().toISOString();
  await query('UPDATE users SET tc_version = $1, tc_accepted_at = $2 WHERE id = $3', [
    TERMS_VERSION,
    tcAcceptedAt,
    userId,
  ]);
  await recordAudit({
    action: 'auth.terms_accept',
    actorId: userId,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    metadata: { tcVersion: TERMS_VERSION },
  });
  return { tcVersion: TERMS_VERSION, tcAcceptedAt };
}

/**
 * Change the signed-in user's password.
 *
 * A password change is a real session boundary: after verifying the current
 * password we bump `token_version` (invalidating every access token minted
 * before now) and revoke all live refresh tokens, which logs out any *other*
 * session still holding the old password. The caller is handed a fresh
 * access+refresh pair so their own session continues seamlessly. Also clears the
 * `must_change_password` first-login gate.
 *
 * A wrong current password is a 400, not a 401: the request is authenticated,
 * so a 401 would wrongly read as "token expired" and trip the client's silent
 * refresh/retry loop.
 */
export async function changePassword(
  userId: string,
  input: z.infer<typeof changePasswordSchema>,
  ctx: AuthCtx,
): Promise<LoginResult> {
  const res = await query<UserRow>(
    `SELECT id, password_hash, role, region_codes, ward_code, is_active,
            token_version, moderation_status, suspended_until, tc_version,
            tc_accepted_at, must_change_password, permission_grants, permission_revokes
       FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const user = res.rows[0];
  if (!user || !user.is_active || user.moderation_status === 'banned') {
    throw ApiError.unauthorized();
  }

  // FR-P4: an OTP-onboarded member completing first-run setup never had a
  // password to re-type — their one-time code was consumed at login and the
  // stored hash is a throwaway they were never told. They proved control of their
  // own email inbox to obtain this session, so the current-password re-check is
  // waived for exactly that one transition, and only while the first-login gate
  // is still open (must_change_password) for a `member`. Every other account —
  // notably the seeded super-admin rotating a shared bootstrap password — must
  // still prove knowledge of the current password. The client hides the field for
  // this same case (role === 'member' behind the gate), so the two sides agree
  // without any new persisted flag.
  const otpOnboarding = user.must_change_password && user.role === Role.MEMBER;
  if (!otpOnboarding) {
    const ok = await verifyPassword(user.password_hash, input.currentPassword);
    if (!ok) {
      await recordAudit({
        action: 'auth.password_change_failed',
        actorId: userId,
        actorRole: user.role,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        metadata: { reason: 'bad_current_password' },
      });
      throw new ApiError(400, 'invalid_current_password', 'Current password is incorrect.');
    }
    if (input.newPassword === input.currentPassword) {
      throw new ApiError(400, 'password_reused', 'New password must differ from the current one.');
    }
  }

  const passwordHash = await hashPassword(input.newPassword);
  const bumped = await query<{ token_version: number }>(
    `UPDATE users
        SET password_hash = $2,
            must_change_password = FALSE,
            token_version = token_version + 1,
            updated_at = now()
      WHERE id = $1
      RETURNING token_version`,
    [userId, passwordHash],
  );
  const newTv = bumped.rows[0]?.token_version ?? user.token_version + 1;

  // Revoke every other live session; the fresh pair below is the only survivor
  // of the token_version bump.
  await query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );

  const accessToken = signAccessToken(
    {
      sub: user.id,
      role: user.role as Role,
      regionCodes: user.region_codes,
      wardCode: user.ward_code ?? undefined,
    },
    newTv,
  );
  const refreshToken = await issueRefreshToken(userId, ctx.ip, ctx.userAgent);

  await recordAudit({
    action: 'auth.password_change',
    actorId: userId,
    actorRole: user.role,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    ...(otpOnboarding ? { metadata: { via: 'otp_onboarding' } } : {}),
  });

  const access = await sessionPermissions(
    user.role,
    user.permission_grants,
    user.permission_revokes,
  );
  return {
    accessToken,
    refreshToken,
    role: user.role,
    tcAccepted: user.tc_version === TERMS_VERSION,
    tcVersion: user.tc_version,
    tcCurrentVersion: TERMS_VERSION,
    mustChangePassword: false,
    permissions: access.permissions,
    enabledModules: access.enabledModules,
  };
}
