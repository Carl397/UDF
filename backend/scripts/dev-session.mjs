/**
 * DEV-ONLY verification helper: mint a browser session for a local user by
 * writing a real refresh-token row and signing a genuine access token, then
 * print the exact localStorage blob the frontend needs. Lets authenticated
 * browser acceptance run on the local stack without touching passwords.
 *
 * Usage: npm run dev -- --import tsx scripts/dev-session.mjs <userId>
 *   (run from the backend workspace so backend/.env resolves)
 *
 * Refuses to run against a production database.
 */
import { createHash } from 'node:crypto';
import { env } from '../src/config/env.ts';
import { pool, query } from '../src/db/pool.ts';
import { signAccessToken, generateRefreshToken, refreshExpiry } from '../src/auth/tokens.ts';
import { effectivePermissions, modulesForRole } from '../src/auth/permissions.ts';

if (env.isProduction || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.DATABASE_URL).hostname)) {
  throw new Error('dev-session refuses to run outside a local database');
}
const userId = process.argv[2];
if (!userId) {
  console.error('usage: dev-session.mjs <userId>');
  process.exit(1);
}

const u = (
  await query(
    `SELECT id, role, ward_code, region_codes, token_version, is_active, moderation_status,
            permission_grants, permission_revokes
       FROM users WHERE id = $1`,
    [userId],
  )
).rows[0];
if (!u || !u.is_active || u.moderation_status === 'banned') throw new Error('user not usable');

const refresh = generateRefreshToken();
await query(
  `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
   VALUES ($1,$2,$3,NULL,'dev-session')`,
  [u.id, createHash('sha256').update(refresh, 'utf8').digest(), refreshExpiry()],
);

const role = u.role;
const principal = {
  sub: u.id,
  role,
  regionCodes: u.region_codes ?? [],
  wardCode: u.ward_code ?? null,
  email: `${u.id.slice(0, 8)}@dev.local`,
  permissions: [...effectivePermissions(role, u.permission_grants, u.permission_revokes)],
};
const access = signAccessToken(principal, u.token_version);
const perms = [...effectivePermissions(role, u.permission_grants, u.permission_revokes)];

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      access_token: access,
      refresh_token: refresh,
      session_email: principal.email,
      tc_accepted_version: '1.0.0',
      tc_current_version: '1.0.0',
      session_permissions: JSON.stringify(perms),
      session_modules: JSON.stringify(modulesForRole(role)),
    },
    null,
    2,
  ),
);
await pool.end();
