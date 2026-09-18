import { fileURLToPath } from 'node:url';
import { pool, query } from './pool.js';
import { migrate } from './migrate.js';
import { logger } from '../config/logger.js';
import { provisionMemberUser } from '../modules/onboarding/service.js';

/**
 * Backfill login accounts for EXISTING members (PRD-growth FR-P1, migration 020).
 *
 * Registration provisions new members automatically; this one-time script does
 * the same for members who joined before Phase B, so they can onboard too. It is
 * application-side (not a SQL UPDATE) because provisioning needs the envelope
 * crypto + blind index that only the app can run.
 *
 * Idempotent: a member already bound to a `users` row (via `users.member_id`) is
 * skipped. By default it does NOT email — it creates the account with
 * `must_change_password = TRUE` and the member then uses "Resend OTP" to sign in,
 * so a backfill never triggers a mass starter-pack blast. Pass --send to email
 * each newly provisioned member their OTP + starter pack.
 *
 * Lives in src/db/ (not scripts/) so it compiles into dist/db/provisionMembers.js
 * and is shippable to production, matching seedAdmin.js.
 *
 * Usage:
 *   npm run provision:members                     # dry run (report only)
 *   npm run provision:members -- --force          # provision accounts, no email
 *   npm run provision:members -- --force --send   # provision + email starter pack
 *   # production (after migrate): node dist/db/provisionMembers.js --force
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--force');
  const send = args.includes('--send');

  // Ensure the schema exists first (no-op if already migrated).
  await migrate();

  // Active or pending members with a resolvable email and no bound login yet.
  const { rows } = await query<{ id: string; public_code: string | null; status: string }>(
    `SELECT m.id, m.public_code, m.status
       FROM members m
      WHERE m.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.member_id = m.id)
      ORDER BY m.created_at`,
  );

  // eslint-disable-next-line no-console
  console.log(`Members lacking a login account: ${rows.length}`);
  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log('DRY RUN — no changes made. Re-run with --force to provision.');
    // eslint-disable-next-line no-console
    console.log('   (--force provisions without email; --force --send also emails the starter pack)');
    return;
  }

  let provisioned = 0;
  let emailed = 0;
  let skipped = 0;
  for (const m of rows) {
    try {
      const res = await provisionMemberUser(m.id, {}, { onlyIfMissing: true, send });
      if (res.provisioned) {
        provisioned++;
        if (res.otpSent) emailed++;
      } else {
        skipped++;
      }
    } catch (err) {
      skipped++;
      logger.error({ err, memberId: m.id }, 'provision failed for member');
    }
  }

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(`Provisioned: ${provisioned}  ·  Emailed OTP: ${emailed}  ·  Skipped: ${skipped}`);
}

// Run directly: `npm run provision:members` / `node dist/db/provisionMembers.js`
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main()
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, 'provision:members failed');
      // eslint-disable-next-line no-console
      console.error('❌ provision:members failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
