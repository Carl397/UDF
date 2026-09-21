#!/usr/bin/env node
/**
 * Seed the UDF LGE2026 ward councillors into the CRM as `ward_councillor` accounts.
 *
 * Input is the same table used for the mailboxes:
 *   deploy/scripts/councillor-mailboxes.txt   localpart <TAB> certified name <TAB> Ward N, ...
 * One account per person (duplicates already removed), linked to EVERY ward slot
 * the IEC certified list prints against that name.
 *
 * The script has a second job it grows into: `linkCouncillorMembers()` below gives
 * every councillor the `members` row the accountability model is keyed on, which
 * is what makes "rate your councillor" open at all. It runs for every councillor
 * account, whoever created it, and is idempotent.
 *
 * Why a script against the app instead of SQL: `users` stores no plaintext email.
 * It is sealed in `sealed_pii` (envelope encryption) and indexed by an HMAC
 * `email_bidx`, and passwords are argon2id. `ward_code` is an FK and the public
 * councillor profile in `leaders` is a mirror kept in step by
 * `syncCouncillorLeader()`. So we import the deployed `createUser` from
 * /opt/udf/backend/dist and let production code do every write. The member link
 * needs the same care: the name lives in sealed PII, so it is opened and re-sealed
 * through the production crypto rather than copied in the clear.
 *
 * Dry-run by default. Nothing is written unless SEED_APPLY=yes.
 *
 *   cd /opt/udf/backend && set -a && . /etc/udf/udf-api.env && . /etc/udf/secrets.env && set +a
 *   CRM_GENERIC_PASSWORD='…' node /root/udf-deploy/seed-councillors.mjs          # plan
 *   CRM_GENERIC_PASSWORD='…' SEED_APPLY=yes node /root/udf-deploy/seed-councillors.mjs
 *
 * Idempotent: an existing account (same email blind index) is reported and left
 * untouched, never overwritten.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DIST = process.env.BACKEND_DIST || '/opt/udf/backend/dist';
const INPUT = process.env.COUNCILLOR_INPUT || '/root/udf-deploy/councillor-mailboxes.txt';
const DOMAIN = process.env.MAIL_DOMAIN || 'udf-party.co.za';
const BIO = process.env.COUNCILLOR_BIO || 'Evidence-based. Practical. Community-driven.';
const APPLY = process.env.SEED_APPLY === 'yes';
const PASSWORD = process.env.CRM_GENERIC_PASSWORD || '';

const { query, pool, withTransaction } = await import(pathToFileURL(`${DIST}/db/pool.js`).href);
const { createUser } = await import(pathToFileURL(`${DIST}/modules/crm/userService.js`).href);
const { Role } = await import(pathToFileURL(`${DIST}/auth/permissions.js`).href);
const { blindIndex } = await import(pathToFileURL(`${DIST}/security/blindIndex.js`).href);
const { openRecord, sealRecord } = await import(pathToFileURL(`${DIST}/security/encryption.js`).href);
const { TERMS_VERSION } = await import(pathToFileURL(`${DIST}/modules/public/content.js`).href);

if (!PASSWORD || PASSWORD.length < 12) {
  console.error('Refusing to run: CRM_GENERIC_PASSWORD must be set and >= 12 characters.');
  await pool.end();
  process.exit(1);
}

/** "Ward 2, Ward 117" -> [2, 117]; ward N is region code CPT-W0NN (zero-padded to 3). */
function wardCodes(field) {
  const nums = [...field.matchAll(/\d+/g)].map((m) => Number(m[0]));
  if (!nums.length) throw new Error(`no ward numbers in "${field}"`);
  return [...new Set(nums)].sort((a, b) => a - b).map((n) => `CPT-W${String(n).padStart(3, '0')}`);
}

// ── input ────────────────────────────────────────────────────────────────────
const people = readFileSync(INPUT, 'utf8')
  .split('\n')
  .map((line) => line.replace(/\r$/, ''))
  .filter((line) => line.trim() && !line.startsWith('#'))
  .map((line) => {
    const [localpart, fullName, wards] = line.split('\t');
    if (!localpart || !fullName || !wards) throw new Error(`bad input line: ${line}`);
    return { email: `${localpart.trim().toLowerCase()}@${DOMAIN}`, fullName: fullName.trim(), wards };
  })
  .map((p) => ({ ...p, wardCodes: wardCodes(p.wards) }));

const dupEmails = people.map((p) => p.email).filter((e, i, a) => a.indexOf(e) !== i);
if (dupEmails.length) throw new Error(`duplicate emails in input: ${dupEmails.join(', ')}`);

// ── ward -> macro region (ward -> subcouncil -> region), same convention as staff ──
const chain = await query(`
  SELECT w.code AS ward, w.parent_code AS subcouncil, s.parent_code AS above
    FROM regions w JOIN regions s ON s.code = w.parent_code
   WHERE w.level = 'ward'`);
const macroRegionByWard = new Map();
for (const row of chain.rows) {
  // Direct parent is usually a subcouncil whose parent is one of the 5 regions.
  // Wards 117/118 sit under CPT with no subcouncil layer, so they keep CPT.
  macroRegionByWard.set(row.ward, row.above ?? row.subcouncil);
}
const regionCodes = new Set(
  (await query(`SELECT code FROM regions WHERE level = 'region'`)).rows.map((r) => r.code),
);

// ── the plan ─────────────────────────────────────────────────────────────────
const plans = people.map((p) => {
  const primary = p.wardCodes[0];
  const region = macroRegionByWard.get(primary);
  if (!region) throw new Error(`no region for ward ${primary} (${p.fullName})`);
  if (!regionCodes.has(region)) console.log(`  note: ${primary} maps to ${region}, not a macro region`);
  return {
    email: p.email,
    password: PASSWORD,
    role: Role.WARD_COUNCILLOR,
    fullName: p.fullName,
    wardCode: primary,
    wardCodes: p.wardCodes,
    // Same convention as the existing staff accounts: scoped to the region the
    // primary ward sits in. Ward access itself comes from ward_code(s), and
    // isNationalScope() is false for ward_councillor, so this widens nothing.
    regionCodes: [region],
    bio: BIO,
  };
});

// The certified list is authoritative: no "incumbent priority" pass here. See
// the note at the bottom of this file.

// ── councillor member rows ───────────────────────────────────────────────────
/**
 * Give every councillor account the `members` row the accountability model is
 * keyed on.
 *
 * This is not cosmetic: `councillor_scorecards.councillor_member_id`,
 * `patrols.councillor_member_id` and `service_requests.councillor_member_id` are
 * all `REFERENCES members(id)`, and `scorecards.eligibility()` refuses to open a
 * month's card for a member whose councillor has no member row — it reports
 * `vacant_seat`, "Your ward has no active councillor to rate right now". With no
 * member rows in existence, not one member in the metro could rate a councillor,
 * which is the whole point of the feature.
 *
 * Deliberately NOT built with `registerMember()`: that flow demands an email,
 * mints a confirm link, provisions a login, stamps T&C acceptance and writes a
 * consent row — none of which happened here. These are members by election, not
 * by signup, so the row carries exactly what is true of them:
 *   • tier `candidate` — the taxonomy's own granted-by-appointment tier, never
 *     self-selected, which also keeps them out of the "supporters" counts a
 *     `voter` tier would land in;
 *   • the certified NAME only, re-sealed with the production crypto. No email,
 *     so no `email_bidx` and no second copy of the mailbox we already hold on
 *     the user account. `loadMemberFacts()` bails on an email-less row, so these
 *     members can never be picked up by OTP provisioning or the starter pack;
 *   • no `membership_no` and no `public_code`: no ID card, no public /v/ page
 *     for someone who never registered;
 *   • no `member_consents` row and no `tc_*` stamp — we hold no consent or
 *     acceptance record for them, and writing one would be fabricating the very
 *     thing those columns are evidence of;
 *   • no `location`: a home address is not in the certified list, and a
 *     coordinates-free row simply does not appear on the point/heat layers
 *     instead of appearing in a place we invented.
 *
 * `leaders.member_id` is refreshed in the same transaction because
 * `syncCouncillorLeader()` (which normally mirrors it) only runs when a profile
 * is saved from the CRM. Existing links are never touched, so a re-run is a
 * no-op and a councillor who later self-registers keeps their own row.
 */
async function linkCouncillorMembers({ apply }) {
  const targets = (
    await query(
      `SELECT u.id, u.ward_code, u.region_codes, u.sealed_pii, l.full_name AS leader_name
         FROM users u
         LEFT JOIN leaders l ON l.user_id = u.id
        WHERE u.role = $1 AND u.member_id IS NULL
        ORDER BY u.ward_code NULLS LAST, u.id`,
      [Role.WARD_COUNCILLOR],
    )
  ).rows;

  console.log(`\n  councillor member rows: ${targets.length} councillor account(s) have no members row`);
  if (!targets.length) return;

  // `region_code` and `ward` are plain columns on `members` (`ward` has no FK at
  // all), so an invalid region would be silently stored and then silently
  // invisible on every regional roll-up. Checked against `regions` here.
  const knownRegions = new Set((await query(`SELECT code FROM regions`)).rows.map((r) => r.code));

  let linked = 0;
  let skipped = 0;
  for (const t of targets) {
    let name = null;
    try {
      if (t.sealed_pii) name = (await openRecord(t.id, t.sealed_pii)).fullName ?? null;
    } catch {
      name = null;
    }
    // The published leader row carries the same name, mirrored from the same
    // sealed PII when the profile was saved. Fall back to it rather than
    // abandoning the link; a row is still missing its name only if both are empty.
    if (!name) name = t.leader_name?.trim() || null;
    if (!name) {
      skipped += 1;
      console.log(`  ! ${t.id}  no recoverable name — left unlinked, fix the account and re-run`);
      continue;
    }

    const region =
      [t.region_codes?.[0], macroRegionByWard.get(t.ward_code)].find((c) => c && knownRegions.has(c)) ?? null;

    if (!apply) {
      console.log(
        `  ~ ${(t.ward_code ?? 'no ward').padEnd(10)} ${name.padEnd(33)}` +
          ` → members(candidate/active, region ${region ?? 'none'}), users.member_id, leaders.member_id`,
      );
      linked += 1;
      continue;
    }

    const memberId = randomUUID();
    const sealed = await sealRecord(memberId, { fullName: name });
    await withTransaction(async (client) => {
      const run = client.query.bind(client);
      await run(
        `INSERT INTO members
           (id, tier, status, region_code, ward, heat_weight, sealed_pii, tags)
         VALUES ($1, 'candidate', 'active', $2, $3, 1, $4::jsonb, $5)`,
        [
          memberId,
          region,
          t.ward_code,
          JSON.stringify(sealed),
          ['councillor', ...(t.ward_code ? [`ward:${t.ward_code}`] : [])],
        ],
      );
      // `member_id` is UNIQUE on users, so the guard is load-bearing: if this
      // account was linked in the meantime (a CRM edit, a self-registration),
      // re-pointing it would orphan the member row it already has.
      const upd = await run(
        `UPDATE users SET member_id = $2 WHERE id = $1 AND member_id IS NULL`,
        [t.id, memberId],
      );
      if (!upd.rowCount) throw new Error(`user ${t.id} was linked by someone else mid-run`);
      await run(
        `UPDATE leaders SET member_id = $2, updated_at = now()
          WHERE user_id = $1 AND member_id IS DISTINCT FROM $2`,
        [t.id, memberId],
      );
    });
    linked += 1;
    console.log(`  + ${(t.ward_code ?? 'no ward').padEnd(10)} ${name.padEnd(33)} ${memberId}`);
  }

  console.log(`  ${apply ? 'linked' : 'would link'} ${linked}, skipped ${skipped}`);
}

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — ${plans.length} councillor accounts`);
console.log(`bio: "${BIO}"`);
for (const p of plans) {
  console.log(
    `  ${p.email.padEnd(34)} ${p.fullName.padEnd(33)} primary ${p.wardCode} (${p.regionCodes[0]})` +
      `  wards=${p.wardCodes.length}`,
  );
}
const totalWards = plans.reduce((n, p) => n + p.wardCodes.length, 0);
console.log(`  ${totalWards} ward slots in total`);
if (!APPLY) {
  await linkCouncillorMembers({ apply: false });
  console.log('\nNo writes performed. Re-run with SEED_APPLY=yes.\n');
  await pool.end();
  process.exit(0);
}

// ── create ───────────────────────────────────────────────────────────────────
let created = 0;
let skipped = 0;
const ids = [];
for (const p of plans) {
  try {
    // Look the account up by blind index first: a re-run must not pay for 25
    // argon2 hashes just to be told the row already exists.
    const existing = await query(`SELECT id FROM users WHERE email_bidx = $1`, [
      blindIndex('email', p.email),
    ]);
    if (existing.rowCount) {
      skipped += 1;
      console.log(`  = ${p.email}  (already exists, untouched)`);
      continue;
    }
    const user = await createUser(p);
    // createUser() cannot set these; a provisioned account must not ship a
    // shared password as its permanent one, and must not stall on the T&C wall.
    await query(
      `UPDATE users SET must_change_password = TRUE, tc_version = $2, tc_accepted_at = COALESCE(tc_accepted_at, now()),
                        updated_at = now()
        WHERE id = $1`,
      [user.id, TERMS_VERSION],
    );
    ids.push({ email: p.email, id: user.id });
    created += 1;
    console.log(`  + ${p.email}  ${user.id}`);
  } catch (err) {
    if (err?.status === 409) {
      skipped += 1;
      console.log(`  = ${p.email}  (already exists, untouched)`);
      continue;
    }
    console.error(`  ! ${p.email}  ${err?.message ?? err}`);
    throw err;
  }
}

// ── councillor member rows (also covers accounts this script did not create) ─
await linkCouncillorMembers({ apply: true });

// ── homepage roster bio (ward_candidates) ────────────────────────────────────
// Same copy, so the marketing roster and the in-app councillor profile agree.
const matched = (
  await query(`SELECT full_name FROM ward_candidates WHERE trim(full_name) = ANY($1::text[])`, [
    plans.map((p) => p.fullName),
  ])
).rows.map((r) => r.full_name);
const roster = await query(
  `UPDATE ward_candidates SET bio = $2, updated_at = now()
    WHERE trim(full_name) = ANY($1::text[]) AND bio <> $2
    RETURNING full_name`,
  [plans.map((p) => p.fullName), BIO],
);
console.log(`  ward_candidates: ${matched.length}/${plans.length} roster rows hold this name, bio set on ${roster.rowCount}`);
const unmatched = plans.map((p) => p.fullName).filter((n) => !matched.includes(n));

// ── the certified list is authoritative ─────────────────────────────────────
// councillorForWard() resolves a ward to ONE public leader row, and a
// user-less demo row can win a ward the certified list assigns to somebody
// else. This script used to re-assert pre-existing public councillor rows so an
// incumbent kept priority. That is removed on purpose: the IEC certified list
// wins. Where the certified name is not the person the party wants publishing
// that ward, change the account's role in the CRM - demoting it to `member`
// makes syncCouncillorLeader() un-publish its leader row, which is what
// resolved the CPT-W092 conflict (2026-09-21).

// ── verify ────────────────────────────────────────────────────────────────────
const summary = await query(`
  SELECT count(*)::int AS accounts,
         count(*) FILTER (WHERE must_change_password)::int AS must_change,
         count(*) FILTER (WHERE member_id IS NOT NULL)::int AS member_linked,
         coalesce(sum(array_length(ward_codes, 1)), 0)::int AS ward_slots
    FROM users WHERE role = $1`, [Role.WARD_COUNCILLOR]);
const leaders = await query(`
  SELECT count(*)::int AS public_leaders,
         count(*) FILTER (WHERE l.bio = $1)::int AS bioed,
         count(*) FILTER (WHERE l.member_id IS NOT NULL)::int AS member_linked
    FROM leaders l JOIN users u ON u.id = l.user_id
   WHERE u.role = $2 AND l.is_public`, [BIO, Role.WARD_COUNCILLOR]);
console.log('\n  users  :', summary.rows[0]);
console.log('  leaders:', leaders.rows[0]);
if (unmatched.length) console.log(`\n  NOTE: no ward_candidates row matched ${unmatched.length} name(s).`);
console.log('');
await pool.end();
