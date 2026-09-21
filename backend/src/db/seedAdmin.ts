import { fileURLToPath } from 'node:url';
import { pool, query } from './pool.js';
import { migrate } from './migrate.js';
import { logger } from '../config/logger.js';
import { createUser } from '../modules/auth/service.js';
import { blindIndex } from '../security/blindIndex.js';
import { Role } from '../auth/permissions.js';
import { TERMS_VERSION } from '../modules/public/content.js';

/**
 * Seeds the initial super-admin (national_admin) account for a fresh production
 * database — the bootstrap login that can then create every other staff account
 * through the CRM.
 *
 * Credentials are read from the ENVIRONMENT, never hardcoded, so no secret ever
 * lands in the repo or a shell-history-visible command line:
 *
 *   SUPERADMIN_EMAIL         (required)  login email (stored sealed + blind-indexed)
 *   SUPERADMIN_PASSWORD      (required)  min 10 chars (argon2id-hashed)
 *   SUPERADMIN_NAME          (optional)  default "National Administrator"
 *   SUPERADMIN_ROLE          (optional)  default "national_admin". Set to
 *                                         "superadmin" for the platform owner —
 *                                         a strict superset that also unlocks the
 *                                         ops surface (platform/analytics/content).
 *   SUPERADMIN_REGION_CODES  (optional)  comma-separated; empty => national scope
 *   SUPERADMIN_WARD_CODE     (optional)  ward scope for a ward-level admin
 *
 * Idempotent: if the account already exists (matched by the blind-indexed email)
 * it is kept — the password is NOT changed — but its role, active flag,
 * moderation state, and T&C acceptance are (re)asserted so it can sign in and is
 * never gated by the in-app Terms & Conditions prompt.
 *
 * The account is always flagged `must_change_password`: the bootstrap password
 * is operator-supplied (and therefore known/shared), so the app forces a private
 * password on first login before granting access.
 *
 * Run with: npm run seed:admin      (after npm run migrate)
 */

const VALID_ROLES = Object.values(Role) as string[];

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    // eslint-disable-next-line no-console
    console.error(
      `❌ ${name} is required. Provide it via the environment (do not hardcode secrets).`,
    );
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const email = requiredEnv('SUPERADMIN_EMAIL').toLowerCase();
  const password = requiredEnv('SUPERADMIN_PASSWORD');
  const fullName = process.env.SUPERADMIN_NAME?.trim() || 'National Administrator';
  const role = (process.env.SUPERADMIN_ROLE?.trim() || Role.NATIONAL_ADMIN) as Role;
  const regionCodes = (process.env.SUPERADMIN_REGION_CODES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const wardCode = process.env.SUPERADMIN_WARD_CODE?.trim() || undefined;

  if (password.length < 10) {
    // eslint-disable-next-line no-console
    console.error('❌ SUPERADMIN_PASSWORD must be at least 10 characters.');
    process.exit(1);
  }
  if (!VALID_ROLES.includes(role)) {
    // eslint-disable-next-line no-console
    console.error(`❌ SUPERADMIN_ROLE must be one of: ${VALID_ROLES.join(', ')}.`);
    process.exit(1);
  }

  // Ensure the schema exists first (no-op if already migrated).
  await migrate();

  // Look up by blind index — the email itself is sealed, so equality search uses
  // the deterministic HMAC index (same key the app uses at login).
  const existing = await query<{ id: string }>(
    'SELECT id FROM users WHERE email_bidx = $1',
    [blindIndex('email', email)],
  );

  let id: string;
  let created = false;
  if (existing.rows[0]) {
    id = existing.rows[0].id;
    logger.info(
      { email },
      'super-admin already exists — asserting role/active/T&C (password left unchanged)',
    );
  } else {
    id = await createUser({ email, password, role, regionCodes, wardCode, fullName });
    created = true;
    logger.info({ email, role }, 'created super-admin user');
  }

  // Assert a usable, un-gated super-admin regardless of create-vs-existing.
  await query(
    `UPDATE users
        SET role = $2,
            region_codes = $3,
            ward_code = $4,
            is_active = TRUE,
            moderation_status = 'active',
            suspended_until = NULL,
            tc_version = $5,
            tc_accepted_at = COALESCE(tc_accepted_at, now()),
            must_change_password = TRUE,
            updated_at = now()
      WHERE id = $1`,
    [id, role, regionCodes, wardCode ?? null, TERMS_VERSION],
  );

  // eslint-disable-next-line no-console
  console.log(
    `✅ Super-admin ${created ? 'created' : 'updated'}: ${email} — ` +
      `role=${role}, scope=${regionCodes.length ? regionCodes.join('|') : 'national'}, ` +
      `T&C=${TERMS_VERSION} (pre-accepted), must_change_password=TRUE (forced on first login).`,
  );
}

// Run directly: `npm run seed:admin`
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main()
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, 'seed:admin failed');
      // eslint-disable-next-line no-console
      console.error('❌ seed:admin failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
