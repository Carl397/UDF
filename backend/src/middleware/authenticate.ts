import type { RequestHandler } from 'express';
import { verifyAccessToken } from '../auth/tokens.js';
import { effectivePermissions, modulesForRole, type Role } from '../auth/permissions.js';
import { query } from '../db/pool.js';
import { ApiError } from '../http/errors.js';
import { recordPresence } from '../modules/platform/presence.js';

/**
 * Verify the Bearer access token and attach the Principal to the request.
 * Missing/invalid/expired tokens all yield 401 with a generic message
 * (no oracle about which check failed).
 *
 * A signature check alone is stateless, so a banned or suspended user would
 * keep access until their short-lived JWT expired. To enforce moderation
 * immediately we re-read the user's live status and `token_version` (one
 * indexed lookup by primary key) and reject if the account is inactive,
 * banned, currently suspended, or the token was minted before a revocation.
 *
 * The same lookup also reads the per-user permission overrides so the
 * principal carries its LIVE effective permission set — an admin's grant or
 * revoke is enforced on the very next request, with no stale-token window.
 *
 * The role's disabled modules are folded into that same single query (a
 * correlated subquery over `role_module_gates`) rather than a second round-trip,
 * so `effectivePermissions` can strip a switched-off module's permissions and
 * the principal can carry its `enabledModules` — both live, on the hot path,
 * for the cost of one extra aggregate in a lookup that already runs.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw ApiError.unauthorized();
    }
    const token = header.slice('Bearer '.length).trim();
    const claims = verifyAccessToken(token);

    const res = await query<{
      is_active: boolean;
      role: Role;
      region_codes: string[];
      ward_code: string | null;
      token_version: number;
      moderation_status: string;
      suspended_until: string | null;
      permission_grants: string[] | null;
      permission_revokes: string[] | null;
      disabled_modules: string[] | null;
    }>(
      `SELECT is_active, role, region_codes, ward_code, token_version, moderation_status, suspended_until,
              permission_grants, permission_revokes,
              COALESCE((SELECT array_agg(g.module_key)
                          FROM role_module_gates g
                         WHERE g.role = users.role AND g.enabled = FALSE), '{}') AS disabled_modules
         FROM users WHERE id = $1 LIMIT 1`,
      [claims.sub],
    );
    const u = res.rows[0];
    if (!u || !u.is_active || u.moderation_status === 'banned') {
      throw ApiError.unauthorized();
    }
    if (u.suspended_until && new Date(u.suspended_until).getTime() > Date.now()) {
      throw ApiError.unauthorized();
    }
    // Tokens minted before a revocation (ban/suspend/reinstate/password reset)
    // carry a stale version. Absent `tv` means a pre-existing token: allow it
    // to ride out its short TTL rather than force-logout every live session.
    if (claims.tv != null && claims.tv < u.token_version) {
      throw ApiError.unauthorized();
    }

    const disabledModules = u.disabled_modules ?? [];
    const disabledSet = new Set(disabledModules);
    // Ward changes take effect on the next request, including requests carrying
    // an otherwise-valid token minted before the change. Old scope must not
    // retain access to the previous ward's restricted detail.
    req.principal = {
      sub: claims.sub,
      role: u.role,
      regionCodes: u.region_codes,
      wardCode: u.ward_code ?? undefined,
      email: claims.email,
      permissions: effectivePermissions(
        u.role,
        u.permission_grants,
        u.permission_revokes,
        disabledModules,
      ),
      enabledModules: modulesForRole(u.role).filter(
        (key) => !disabledSet.has(key),
      ),
    };
    // Presence: a request from a live session marks that session seen (the
    // SuperAdmin "users live now" tile reads this). Throttled + fire-and-forget
    // inside recordPresence, so it adds no meaningful latency and cannot fail
    // the request.
    const deviceId = req.get('x-device-id');
    recordPresence(
      claims.sub,
      req.ip ?? null,
      typeof deviceId === 'string' && deviceId.length > 0 ? deviceId.slice(0, 128) : null,
    );
    next();
  } catch {
    next(ApiError.unauthorized());
  }
};

/**
 * Attach a Principal when a valid Bearer token is present, but NEVER reject.
 *
 * For surfaces that anonymous visitors may read, where a signed-in caller is
 * additionally entitled to see more (unpublished or internal content), and for
 * endpoints that must succeed without a session but should still be attributable
 * when one is offered — `POST /auth/logout` records an `auth.logout` audit entry
 * only if it knows who signed out.
 *
 * This is deliberately the ONE implementation. A private copy in
 * `modules/posts/routes.ts` built the principal without `wardCode`, so a ward
 * councillor arriving at an optional-auth route was scoped by their SUBCOUNCIL
 * instead of their ward and could see unpublished content from neighbouring
 * wards. Every field `authenticate` attaches must be attached here too.
 *
 * Only the token signature is verified — not the user's live status. Nothing is
 * being granted on the strength of this middleware alone: routes that authorise
 * still run `authenticate` or check the principal explicitly.
 */
export const optionalAuthenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const claims = verifyAccessToken(header.slice('Bearer '.length).trim());
      req.principal = {
        sub: claims.sub,
        role: claims.role,
        regionCodes: claims.regionCodes,
        wardCode: claims.wardCode,
        email: claims.email,
      };
    } catch {
      /* absent, malformed or expired: treat as anonymous */
    }
  }
  next();
};
