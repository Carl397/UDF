import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pool, query } from './pool.js';
import { logger } from '../config/logger.js';
import { createUser } from '../modules/auth/service.js';
import { createMember } from '../modules/members/service.js';
import { Role } from '../auth/permissions.js';
import { blindIndex } from '../security/blindIndex.js';
import { TERMS_VERSION } from '../modules/public/content.js';

/**
 * Validation-campaign fixtures — Mitchell's Plain, City of Cape Town.
 *
 * Seeds one account per role plus a deliberately OUT-OF-SCOPE control account,
 * and a full spread of business records (cases, patrols, bulletins, projects,
 * events, petitions, participations, ratings, verifications, engagement
 * requests, resident reports, jobs) so that:
 *
 *   • region/ward scoping is MEASURABLE (in-scope rows must appear,
 *     out-of-scope rows must not), and
 *   • sealed PII non-disclosure is MEASURABLE (real SA-format emails, phones
 *     and street addresses are sealed, so a leak scanner has true positives).
 *
 * GEOGRAPHY IS NOT GUESSED. The Mitchell's Plain wards below were derived by
 * point-in-polygon testing real suburb coordinates against `regions.geom`:
 *
 *   CPT-W079  Town Centre + Strandfontein   (-34.0517, 18.6167)
 *   CPT-W078  Westridge                     (-34.0450, 18.6050)
 *   CPT-W075  Rocklands                     (-34.0350, 18.6000)
 *   CPT-W116  Eastridge + Woodlands         (-34.0400, 18.6200)
 *   CPT-W043  Lentegeur/Glenwood fringe — adjacent, used as the control ward
 *
 * Idempotent: safe to re-run. Wards/members are matched on natural keys; the
 * business-record sections are guarded by a `[MP-VAL]` marker / ref_no prefix
 * and skipped when already present.
 *
 * Reversal: `npm run factory:reset -- --force` wipes every business table but
 * KEEPS `regions`, so the ward rename is undone with the SQL printed at the end
 * of this script (also recorded in TEST-REPORT.md).
 *
 * Run with: npm run seed:validation
 */

const PASSWORD = process.env.VALIDATION_PASSWORD ?? 'Validation!2026mp';

const MP_LABEL = "Mitchell's Plain";

/** Mitchell's Plain wards (verified against real ward geometry). */
const MP_WARDS = [
  { code: 'CPT-W079', num: '79', parent: 'CPT-SC17', area: 'Town Centre / Strandfontein', lat: -34.0517, lng: 18.6167 },
  { code: 'CPT-W078', num: '78', parent: 'CPT-SC17', area: 'Westridge', lat: -34.045, lng: 18.605 },
  { code: 'CPT-W075', num: '75', parent: 'CPT-SC17', area: 'Rocklands', lat: -34.035, lng: 18.6 },
  { code: 'CPT-W116', num: '116', parent: 'CPT-SC12', area: 'Eastridge / Woodlands', lat: -34.04, lng: 18.62 },
] as const;

/** Adjacent Mitchell's Plain ward used as the OUT-OF-SCOPE control. */
const CONTROL_WARD = { code: 'CPT-W043', num: '43', parent: 'CPT-SC17', area: 'Lentegeur fringe', lat: -34.06, lng: 18.59 } as const;

/** Elsewhere in the metro — proves cross-region isolation, not just cross-ward. */
const OUTSIDE_WARDS = [
  { code: 'CPT-W009', num: '9', parent: 'CPT-SC4', area: 'Blaauwberg', lat: -33.88, lng: 18.6 },
  { code: 'CPT-W025', num: '25', parent: 'CPT-SC1', area: 'City Bowl', lat: -33.92, lng: 18.42 },
] as const;

const PRIMARY = MP_WARDS[0]!; // CPT-W079

/** Mitchell's Plain spans two subcouncils, so the regional scope covers both. */
const MP_SUBCOUNCILS = ['CPT-SC17', 'CPT-SC12'];

/**
 * The published ward councillor's display name.
 *
 * One constant, used BOTH by the `leaders` fixture and by the leak-scanner
 * corpus's `publicByDesign` declaration, so the two cannot drift: if the name
 * ever changed in one place only, the scanner would either flag a legitimate
 * publication or silently bless a value that is no longer the one published.
 */
const LEADER_FULL_NAME = 'Aisha Adams';

interface TestUser {
  key: string;
  email: string;
  fullName: string;
  role: Role;
  regionCodes: string[];
  wardCode?: string;
}

/** One account per role, all anchored in Mitchell's Plain. */
const TEST_USERS: TestUser[] = [
  { key: 'admin', email: 'national.admin@udf.test', fullName: 'Nomsa Dlamini', role: Role.NATIONAL_ADMIN, regionCodes: [] },
  { key: 'regional', email: 'regional.mp@udf.test', fullName: 'Pieter van der Merwe', role: Role.REGIONAL_ORGANIZER, regionCodes: [...MP_SUBCOUNCILS] },
  { key: 'councillor', email: 'councillor.mp79@udf.test', fullName: LEADER_FULL_NAME, role: Role.WARD_COUNCILLOR, regionCodes: ['CPT-SC17'], wardCode: PRIMARY.code },
  { key: 'coordinator', email: 'coordinator.mp75@udf.test', fullName: 'Sipho Khumalo', role: Role.LOCAL_COORDINATOR, regionCodes: ['CPT-SC17'], wardCode: 'CPT-W075' },
  { key: 'analyst', email: 'analyst@udf.test', fullName: 'Chen Wei', role: Role.ANALYST, regionCodes: [] },
  { key: 'member', email: 'member.mp79@udf.test', fullName: 'Thandeka Majola', role: Role.MEMBER, regionCodes: ['CPT-SC17'], wardCode: PRIMARY.code },
  // Control: a member in the ADJACENT ward — must be invisible to the W079 councillor.
  { key: 'memberOutside', email: 'member.mp43@udf.test', fullName: 'Johan Botha', role: Role.MEMBER, regionCodes: ['CPT-SC17'], wardCode: CONTROL_WARD.code },
];

/** Residents with sealed PII, spread across the MP wards + controls. */
interface Resident {
  key: string;
  ward: (typeof MP_WARDS)[number] | typeof CONTROL_WARD | (typeof OUTSIDE_WARDS)[number];
  fullName: string;
  email: string;
  phone: string;
  address: string;
  tier: 'voter' | 'volunteer' | 'activist' | 'donor' | 'candidate' | 'staff';
  status: 'active' | 'inactive' | 'lapsed' | 'suspended' | 'pending';
  heat: number;
  tags: string[];
  /** Members who consented to public contact release on the verify page. */
  dataShare?: boolean;
}

const RESIDENTS: Resident[] = [
  // ── CPT-W079 (the councillor's own ward) ─────────────────────────────
  { key: 'r1', ward: PRIMARY, fullName: 'Thandeka Majola', email: 'thandeka.majola@webmail.co.za', phone: '+27821234501', address: '14 Westgate Drive, Strandfontein, Cape Town, 7785', tier: 'activist', status: 'active', heat: 12, tags: ['mp-79', 'volunteer'], dataShare: true },
  { key: 'r2', ward: PRIMARY, fullName: 'Riaan Nel', email: 'riaan.nel@postbox.co.za', phone: '+27831234502', address: '7 Rocklands Avenue, Rocklands, Cape Town, 7780', tier: 'voter', status: 'active', heat: 3, tags: ['mp-79'] },
  { key: 'r3', ward: PRIMARY, fullName: 'Fatima Isaacs', email: 'f.isaacs@mailhaven.co.za', phone: '+27841234503', address: '22 Baden Powell Drive, Town Centre, Cape Town, 7785', tier: 'donor', status: 'active', heat: 8, tags: ['mp-79', 'donor'], dataShare: true },
  { key: 'r4', ward: PRIMARY, fullName: 'Sizwe Mahlangu', email: 'sizwe.m@quicknet.co.za', phone: '+27851234504', address: '3 Eastridge Way, Eastridge, Cape Town, 7785', tier: 'volunteer', status: 'pending', heat: 2, tags: ['mp-79'] },
  { key: 'r5', ward: PRIMARY, fullName: LEADER_FULL_NAME, email: 'aisha.adams@udf.test', phone: '+27861234505', address: '11 Westridge Close, Westridge, Cape Town, 7785', tier: 'staff', status: 'active', heat: 20, tags: ['mp-79', 'councillor'] },
  { key: 'r6', ward: PRIMARY, fullName: 'Bongani Zulu', email: 'bongani.z@netlink.co.za', phone: '+27871234506', address: '48 Spine Road, Town Centre, Cape Town, 7785', tier: 'voter', status: 'lapsed', heat: 1, tags: ['mp-79'] },
  // ── CPT-W078 / W075 / W116 (in the regional scope, outside W079) ──────
  { key: 'r7', ward: MP_WARDS[1]!, fullName: 'Elmarie du Toit', email: 'elmarie.dt@postbox.co.za', phone: '+27821234507', address: '5 Westridge Avenue, Westridge, Cape Town, 7785', tier: 'volunteer', status: 'active', heat: 4, tags: ['mp-78'] },
  { key: 'r8', ward: MP_WARDS[1]!, fullName: 'Lerato Nkosi', email: 'lerato.nkosi@mailhaven.co.za', phone: '+27831234508', address: '19 Colorama Crescent, Westridge, Cape Town, 7785', tier: 'voter', status: 'active', heat: 2, tags: ['mp-78'] },
  { key: 'r9', ward: MP_WARDS[2]!, fullName: 'Sipho Khumalo', email: 'sipho.khumalo@quicknet.co.za', phone: '+27841234509', address: '8 Rocklands Street, Rocklands, Cape Town, 7780', tier: 'activist', status: 'active', heat: 10, tags: ['mp-75', 'coordinator'] },
  { key: 'r10', ward: MP_WARDS[2]!, fullName: 'Nadia Petersen', email: 'nadia.p@netlink.co.za', phone: '+27851234510', address: '31 Rocklands Drive, Rocklands, Cape Town, 7780', tier: 'voter', status: 'suspended', heat: 1, tags: ['mp-75'] },
  { key: 'r11', ward: MP_WARDS[3]!, fullName: 'Jaco van Wyk', email: 'jaco.vw@postbox.co.za', phone: '+27861234511', address: '12 Woodlands Avenue, Woodlands, Cape Town, 7785', tier: 'candidate', status: 'active', heat: 7, tags: ['mp-116'], dataShare: true },
  { key: 'r12', ward: MP_WARDS[3]!, fullName: 'Zanele Mthembu', email: 'zanele.m@webmail.co.za', phone: '+27871234512', address: '27 Eastridge Boulevard, Eastridge, Cape Town, 7785', tier: 'volunteer', status: 'active', heat: 5, tags: ['mp-116'] },
  // ── CONTROL: adjacent MP ward (CPT-W043) ─────────────────────────────
  { key: 'c1', ward: CONTROL_WARD, fullName: 'Johan Botha', email: 'johan.botha@netlink.co.za', phone: '+27821234513', address: '6 Lentegeur Avenue, Lentegeur, Cape Town, 7782', tier: 'voter', status: 'active', heat: 3, tags: ['mp-43-control'] },
  { key: 'c2', ward: CONTROL_WARD, fullName: 'Nomvula Shabalala', email: 'nomvula.s@mailhaven.co.za', phone: '+27831234514', address: '18 Glenwood Street, Lentegeur, Cape Town, 7782', tier: 'activist', status: 'active', heat: 6, tags: ['mp-43-control'] },
  // ── OUTSIDE: other metro areas (must never leak into MP scopes) ───────
  { key: 'o1', ward: OUTSIDE_WARDS[0]!, fullName: 'Marlene Fourie', email: 'marlene.f@postbox.co.za', phone: '+27841234515', address: '9 Blaauwberg Road, Table View, Cape Town, 7441', tier: 'donor', status: 'active', heat: 9, tags: ['outside-w009'], dataShare: true },
  { key: 'o2', ward: OUTSIDE_WARDS[0]!, fullName: 'Trevor Adams', email: 'trevor.adams@quicknet.co.za', phone: '+27851234516', address: '2 Sunningdale Park, Sunningdale, Cape Town, 7441', tier: 'voter', status: 'active', heat: 2, tags: ['outside-w009'] },
  { key: 'o3', ward: OUTSIDE_WARDS[1]!, fullName: 'Gadija Solomons', email: 'gadija.s@webmail.co.za', phone: '+27861234517', address: '25 Long Street, City Bowl, Cape Town, 8001', tier: 'volunteer', status: 'active', heat: 4, tags: ['outside-w025'] },
  { key: 'o4', ward: OUTSIDE_WARDS[1]!, fullName: 'Andre Louw', email: 'andre.louw@netlink.co.za', phone: '+27871234518', address: '41 Kloof Street, Gardens, Cape Town, 8001', tier: 'voter', status: 'pending', heat: 1, tags: ['outside-w025'] },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** True when a member with this email already exists (blind-index lookup). */
async function memberByEmail(email: string): Promise<string | null> {
  const res = await query<{ id: string }>('SELECT id FROM members WHERE email_bidx = $1 AND deleted_at IS NULL LIMIT 1', [
    blindIndex('email', email),
  ]);
  return res.rows[0]?.id ?? null;
}

async function userByEmail(email: string): Promise<string | null> {
  const res = await query<{ id: string }>('SELECT id FROM users WHERE email_bidx = $1 LIMIT 1', [blindIndex('email', email)]);
  return res.rows[0]?.id ?? null;
}

/** True when at least one row carries the `[MP-VAL]` marker for a table. */
async function markerExists(table: string, column: string): Promise<boolean> {
  const res = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${column} LIKE '[MP-VAL]%'`);
  return Number(res.rows[0]?.n ?? 0) > 0;
}

/**
 * Per-row idempotency.
 *
 * `markerExists` is all-or-nothing: once a table holds ANY `[MP-VAL]` row the
 * whole section is skipped, so a fixture added to this seeder in a later pass
 * never lands. That is not merely untidy — `SCANNER_TOKENS` is published
 * unconditionally, so the corpus advertises a token whose backing row does not
 * exist, the scanner never sees that string in any response, and the rule
 * "passes" VACUOUSLY. The audit then reports green for a control that was never
 * actually exercised. New fixtures must therefore guard themselves per row.
 */
async function rowExists(table: string, column: string, value: string): Promise<boolean> {
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE ${column} = $1`,
    [value],
  );
  return Number(res.rows[0]?.n ?? 0) > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Ward naming — make Mitchell's Plain visible across every screen
// ─────────────────────────────────────────────────────────────────────────────

async function ensureWardNaming(): Promise<void> {
  const all = [...MP_WARDS, CONTROL_WARD];
  for (const w of all) {
    const label = `${MP_LABEL} ${w.num} (${w.area})`;
    // `regions` is official reference data; this rename is reversible and the
    // exact revert SQL is printed by printRevertSql() below.
    await query(`UPDATE regions SET name = $2 WHERE code = $1 AND level = 'ward'`, [w.code, label]);
    await query(
      `INSERT INTO ward_profiles (ward_code, municipality, population, registered_voters)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (ward_code) DO UPDATE SET municipality = EXCLUDED.municipality`,
      [w.code, MP_LABEL, 38000 + Number(w.num) * 11, 24000 + Number(w.num) * 7],
    );
  }
  logger.info({ wards: all.map((w) => w.code) }, 'Named Mitchell\'s Plain wards + profiles');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Role accounts
// ─────────────────────────────────────────────────────────────────────────────

async function ensureUsers(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const u of TEST_USERS) {
    let id = await userByEmail(u.email);
    if (!id) {
      id = await createUser({
        email: u.email,
        password: PASSWORD,
        role: u.role,
        regionCodes: u.regionCodes,
        wardCode: u.wardCode,
        fullName: u.fullName,
      });
      logger.info({ email: u.email, role: u.role }, 'Created validation user');
    } else {
      // Keep scope + role in sync on re-run (idempotent).
      await query(`UPDATE users SET role = $2, region_codes = $3, ward_code = $4 WHERE id = $1`, [
        id,
        u.role,
        u.regionCodes,
        u.wardCode ?? null,
      ]);
    }
    // Clear the gates so automated UI/API testing is not blocked, and make the
    // account active + unmoderated.
    await query(
      `UPDATE users
          SET is_active = TRUE,
              moderation_status = 'active',
              suspended_until = NULL,
              must_change_password = FALSE,
              tc_version = $2,
              tc_accepted_at = COALESCE(tc_accepted_at, now()),
              updated_at = now()
        WHERE id = $1`,
      [id, TERMS_VERSION],
    );
    ids[u.key] = id;
  }
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Members (sealed PII)
// ─────────────────────────────────────────────────────────────────────────────

async function ensureMembers(userIds: Record<string, string>): Promise<Record<string, string>> {
  const actor = { actorId: userIds['admin'] ?? null, actorRole: 'seed' as const, ip: null, userAgent: 'seed-validation' };
  const ids: Record<string, string> = {};

  for (const r of RESIDENTS) {
    const existing = await memberByEmail(r.email);
    if (existing) {
      ids[r.key] = existing;
      continue;
    }
    const created = await createMember(
      {
        tier: r.tier,
        status: r.status,
        regionCode: r.ward.parent,
        ward: r.ward.code,
        lat: r.ward.lat,
        lng: r.ward.lng,
        heatWeight: r.heat,
        tags: r.tags,
        pii: { fullName: r.fullName, email: r.email, phone: r.phone, address: r.address },
        consent: {
          emailOptin: true,
          smsOptin: r.dataShare === true,
          phoneOptin: false,
          dataShare: r.dataShare === true,
          gdprBasis: 'consent',
        },
      },
      actor,
    );
    ids[r.key] = created.id;
  }
  logger.info({ members: Object.keys(ids).length }, 'Sealed-PII members ready');
  return ids;
}

/** Link the W079 councillor user to a member row + publish them as the ward leader. */
async function ensureCouncillorIdentity(userIds: Record<string, string>, memberIds: Record<string, string>): Promise<void> {
  const councillorMemberId = memberIds['r5'];
  if (!councillorMemberId) return;

  await query(
    `UPDATE ward_profiles SET councillor_member_id = $2, updated_at = now() WHERE ward_code = $1`,
    [PRIMARY.code, councillorMemberId],
  );

  // `leaders.contact_public` is deliberately PUBLIC (transparency surface) —
  // it must never carry sealed PII. Only an office line + ward office email.
  //
  // `leaders` has NO unique constraint on (member_id, ward_code) — only its `id`
  // primary key — so the `ON CONFLICT DO NOTHING` this statement used to carry
  // could never fire. Every seed run appended another identical row: eight runs
  // left eight duplicate leader profiles for one councillor (D46).
  // `councillorForWard()` survives that only because of its `LIMIT 1`, and even
  // then it picks arbitrarily among the duplicates, so a future edit to the
  // fixture would make the published councillor non-deterministic.
  //
  // Guard on the natural key instead, and refresh the row in place, so re-seeding
  // is both idempotent and current.
  const leaderParams = [
    councillorMemberId,
    PRIMARY.code,
    PRIMARY.parent,
    LEADER_FULL_NAME,
    `Ward ${PRIMARY.num} councillor for ${MP_LABEL}. Resident of Westridge since 2009; chairs the ward safety and sanitation task teams.`,
    JSON.stringify({ officeEmail: 'ward79.office@udf.test', officePhone: '+27215550079', clinicDay: 'Every second Saturday, 09:00–12:00, Town Centre hall' }),
    JSON.stringify({ facebook: 'udf.ward79' }),
  ];
  await query(
    `INSERT INTO leaders (member_id, ward_code, region_code, full_name, bio, contact_public, socials, is_public)
     SELECT $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, TRUE
      WHERE NOT EXISTS (SELECT 1 FROM leaders WHERE member_id = $1 AND ward_code = $2)`,
    leaderParams,
  );
  await query(
    `UPDATE leaders
        SET region_code = $3, full_name = $4, bio = $5,
            contact_public = $6::jsonb, socials = $7::jsonb,
            is_public = TRUE, updated_at = now()
      WHERE member_id = $1 AND ward_code = $2`,
    leaderParams,
  );
  logger.info({ ward: PRIMARY.code }, 'Councillor identity + public leader profile ready');
}

/**
 * Link the member-role accounts to the member row they ARE, via `users.member_id`
 * — the canonical identity link added in migration 020 (FR-P1) and read by
 * `memberForPrincipal()` in the recruitment + scorecard modules to resolve "the
 * member profile this account owns".
 *
 * `ensureUsers` and `ensureMembers` seed the accounts and the member rows
 * independently, so without this a member/councillor login resolves to NO member
 * profile: `/recruitment/invite`, `/recruitment/tree` and `/scorecards/history`
 * then 403 with "no member profile linked". Those roles legitimately hold
 * `recruitment:read` / `rating:scorecard_write`, so the role-audit scores the 403
 * as an authorization failure. The accounts are the SAME people as the
 * name-matched residents below, so we set the link the real onboarding flow sets.
 *
 * Deliberately NOT linked: `regional` and `coordinator` are staff with no personal
 * member row (a regional organiser is not a ward member). `/recruitment/invite`
 * degrades to 404 for them — authorised, but they have no invite resource.
 *
 * Idempotent: a plain UPDATE keyed on the user id.
 */
const MEMBER_ACCOUNT_LINKS: ReadonlyArray<{ userKey: string; memberKey: string }> = [
  { userKey: 'member', memberKey: 'r1' },        // Thandeka Majola — CPT-W079
  { userKey: 'councillor', memberKey: 'r5' },    // Aisha Adams — the published W079 councillor
  { userKey: 'memberOutside', memberKey: 'c1' }, // Johan Botha — CPT-W043 (out-of-scope control)
];

async function linkMemberAccounts(
  userIds: Record<string, string>,
  memberIds: Record<string, string>,
): Promise<void> {
  let linked = 0;
  for (const { userKey, memberKey } of MEMBER_ACCOUNT_LINKS) {
    const userId = userIds[userKey];
    const memberId = memberIds[memberKey];
    if (!userId || !memberId) continue;
    await query(`UPDATE users SET member_id = $2, updated_at = now() WHERE id = $1`, [userId, memberId]);
    linked += 1;
  }
  logger.info({ linked }, 'Linked member-role accounts to their member rows (users.member_id)');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Leak-scanner corpus
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The POPIA proof needs to know, in the clear, exactly which strings must
 * NEVER appear in a response for a role lacking `PII_DECRYPT`. Sealed values
 * cannot be read back out of the database (that is the point), so the seeder
 * publishes the corpus as an artifact for `scripts/role-audit.mjs` to consume.
 *
 * The file lives in `deploy/.artifacts/` which is git-ignored. It contains
 * synthetic fixture PII only — no real personal data.
 */
/** Ward → parent subcouncil, so the scanner can tell territory from noise. */
const WARD_PARENTS: Record<string, string> = {
  'CPT-W079': 'CPT-SC17',
  'CPT-W078': 'CPT-SC17',
  'CPT-W075': 'CPT-SC17',
  'CPT-W116': 'CPT-SC12',
  'CPT-W043': 'CPT-SC17',
  'CPT-W009': 'CPT-SC4',
  'CPT-W025': 'CPT-SC1',
};

/**
 * A string the leak scanner must be able to place. Every token carries the ward
 * it belongs to and the rule under which it is restricted, because "out of
 * scope" is not one thing:
 *
 *   territory — the record sits in a ward the caller has no authority over.
 *               CPT-W043 is inside CPT-SC17, so it is out of scope for the
 *               W079 councillor but IN scope for the regional organizer whose
 *               territory is SC17+SC12. A flat deny-list got this wrong and
 *               reported the regional organizer's own territory as a leak.
 *   private   — the record sits in the caller's own ward but carries
 *               `visibility = 'private'` (FR-E). Restricted by TIER, not by
 *               territory: staff see it, `member` and `analyst` never do.
 *   own       — the record belongs to the caller themselves (`owner`), so it is
 *               always legitimate for them and only for them.
 *   draft     — the record is in the caller's ward but NOT yet published
 *               (`projects.is_published = FALSE`, `ward_bulletins.status =
 *               'draft'`). Restricted by PUBLICATION and territory together:
 *               staff inside the ward see it, everybody else — including the
 *               ward's own members — does not. Seeded inside the primary ward on
 *               purpose, so a ward filter alone cannot hide it.
 */
interface ScannerToken {
  token: string;
  ward: string;
  kind: 'ward' | 'ref' | 'title' | 'member';
  rule: 'territory' | 'private' | 'own' | 'draft';
  owner?: string;
}

const SCANNER_TOKENS: ScannerToken[] = [
  // ── territory: adjacent control ward (CPT-W043, inside CPT-SC17) ─────────
  { token: CONTROL_WARD.code, ward: CONTROL_WARD.code, kind: 'ward', rule: 'territory' },
  { token: 'SR-MP-0011', ward: CONTROL_WARD.code, kind: 'ref', rule: 'territory' },
  { token: 'Open drainage channel in Lentegeur', ward: CONTROL_WARD.code, kind: 'title', rule: 'territory' },
  { token: 'Lentegeur canal rehabilitation (control ward)', ward: CONTROL_WARD.code, kind: 'title', rule: 'territory' },
  { token: 'Lentegeur open-drainage petition (control ward)', ward: CONTROL_WARD.code, kind: 'title', rule: 'territory' },
  { token: 'Comment: Lentegeur canal (control ward)', ward: CONTROL_WARD.code, kind: 'title', rule: 'territory' },
  { token: 'Lentegeur town hall (control ward)', ward: CONTROL_WARD.code, kind: 'title', rule: 'territory' },
  { token: 'Canal rehabilitation crew (control ward)', ward: CONTROL_WARD.code, kind: 'title', rule: 'territory' },
  { token: 'Lentegeur canal cleaning (control ward)', ward: CONTROL_WARD.code, kind: 'title', rule: 'territory' },
  { token: 'Johan Botha', ward: CONTROL_WARD.code, kind: 'member', rule: 'territory' },
  { token: 'Nomvula Shabalala', ward: CONTROL_WARD.code, kind: 'member', rule: 'territory' },
  // The out-of-scope member's OWN report: legitimate for them, forbidden to all
  // other ward-scoped principals (it is in a ward they do not hold).
  { token: 'RR-MP-0004', ward: CONTROL_WARD.code, kind: 'ref', rule: 'own', owner: 'memberOutside' },
  { token: 'JO-MP-0004', ward: CONTROL_WARD.code, kind: 'ref', rule: 'territory' },

  // ── territory: other metro areas (outside Mitchell's Plain entirely) ─────
  { token: 'CPT-W009', ward: 'CPT-W009', kind: 'ward', rule: 'territory' },
  { token: 'SR-MP-0012', ward: 'CPT-W009', kind: 'ref', rule: 'territory' },
  { token: 'Burst pipe in Table View', ward: 'CPT-W009', kind: 'title', rule: 'territory' },
  { token: 'Table View fundraising breakfast (outside MP)', ward: 'CPT-W009', kind: 'title', rule: 'territory' },
  { token: 'Marlene Fourie', ward: 'CPT-W009', kind: 'member', rule: 'territory' },
  { token: 'Trevor Adams', ward: 'CPT-W009', kind: 'member', rule: 'territory' },
  { token: 'CPT-W025', ward: 'CPT-W025', kind: 'ward', rule: 'territory' },
  { token: 'Gadija Solomons', ward: 'CPT-W025', kind: 'member', rule: 'territory' },
  { token: 'Andre Louw', ward: 'CPT-W025', kind: 'member', rule: 'territory' },

  // ── private tier: inside the primary ward, staff-only ────────────────────
  { token: 'SR-MP-0009', ward: PRIMARY.code, kind: 'ref', rule: 'private' },
  { token: 'Overcrowded backyard dwelling (private)', ward: PRIMARY.code, kind: 'title', rule: 'private' },
  { token: 'Internal patrol (not member-visible)', ward: PRIMARY.code, kind: 'title', rule: 'private' },

  // ── publication gate: inside the primary ward, unpublished ───────────────
  // Deliberately in the councillor's OWN ward: a territory filter would let them
  // through, so only the `is_published` / `status` gate can be what hides them.
  { token: 'DRAFT Town Centre taxi rank shelter (unpublished)', ward: PRIMARY.code, kind: 'title', rule: 'draft' },
  { token: 'DRAFT water interruption notice (unpublished)', ward: PRIMARY.code, kind: 'title', rule: 'draft' },

  // ── publication gate on a MIXED public surface (`posts`, D41) ────────────
  // `/api/posts` is readable by anonymous, so the matrix's scope scanner skips it
  // (unauthenticated routes are governed by publication, not territory) and these
  // rows are pinned by dedicated probes instead. The tokens are still declared
  // here so that a draft post title surfacing through ANY authenticated route —
  // a CRM feed, a notification, a digest — is caught as a scope leak.
  //
  // The three wards are chosen to separate the three scope levels:
  //   W079 draft → councillor, regional, admin
  //   W043 draft → regional, admin (same subcouncil as W079 — the region-only trap)
  //   W009 draft → admin only (a different subcouncil; a regional organizer holds
  //                `post:moderate` for CPT-SC17/SC12 and no further)
  { token: '[MP-VAL] DRAFT Ward 79 budget briefing (unpublished)', ward: PRIMARY.code, kind: 'title', rule: 'draft' },
  { token: '[MP-VAL] DRAFT Lentegeur internal note (control ward, unpublished)', ward: CONTROL_WARD.code, kind: 'title', rule: 'draft' },
  { token: '[MP-VAL] DRAFT Table View provincial memo (outside MP, unpublished)', ward: 'CPT-W009', kind: 'title', rule: 'draft' },
  { token: '[MP-VAL] TAKEN DOWN Westridge spam note', ward: 'CPT-W078', kind: 'title', rule: 'draft' },
  { token: 'Commercial advertising posted as a community service report.', ward: 'CPT-W078', kind: 'title', rule: 'draft' },
];

/**
 * Free-text columns a `ref`/`title` token could plausibly live in. The check
 * below asks only "does this string exist somewhere the API could return it",
 * so it deliberately casts wide rather than tracking which table each token
 * came from — that coupling would itself be a second copy of the fixture data.
 */
const CORPUS_TEXT_COLUMNS: [string, string][] = [
  ['service_requests', 'ref_no'], ['service_requests', 'title'],
  ['resident_reports', 'ref_no'], ['resident_reports', 'message'],
  ['job_opportunities', 'ref_no'], ['job_opportunities', 'title'],
  ['projects', 'title'],
  ['petitions', 'title'],
  ['public_participations', 'title'], ['public_participations', 'subject'],
  ['events', 'title'],
  ['posts', 'title'], ['posts', 'take_down_reason'],
  ['ward_bulletins', 'title'],
  ['patrols', 'purpose'],
  ['notifications', 'title'],
  ['engagement_requests', 'notes'],
  ['ratings', 'reason'],
  ['verifications', 'note'],
];

/**
 * Fail the seed rather than publish a corpus that cannot detect anything.
 *
 * `ward` tokens are ward codes (always resolvable) and `member` tokens are
 * sealed PII held encrypted, so neither can be matched with a plain SQL LIKE;
 * they are covered by the `sealed` list, which is derived from the resident
 * records themselves. The `ref`/`title` tokens are the scope and publication
 * controls, and those MUST be backed by a real row.
 */
async function assertCorpusIsBacked(): Promise<void> {
  const union = CORPUS_TEXT_COLUMNS.map(
    ([table, column], i) =>
      // Each branch needs its own parentheses: a bare `LIMIT` binds to the whole
      // UNION rather than the branch, which Postgres rejects outright.
      `(SELECT ${i} AS ord, '${table}.${column}' AS src FROM ${table} WHERE ${column} LIKE '%' || $1 || '%' LIMIT 1)`,
  ).join(' UNION ALL ');

  const missing: string[] = [];
  for (const t of SCANNER_TOKENS) {
    if (t.kind !== 'ref' && t.kind !== 'title') continue;
    const res = await query<{ src: string }>(`SELECT src FROM (${union}) u ORDER BY ord LIMIT 1`, [t.token]);
    if (res.rows.length === 0) missing.push(`  - "${t.token}"  [rule=${t.rule} ward=${t.ward}]`);
  }
  if (missing.length > 0) {
    throw new Error(
      `Leak-scanner corpus advertises ${missing.length} token(s) with no backing row:\n${missing.join('\n')}\n` +
        'A token that matches nothing makes its scope rule pass VACUOUSLY, so the audit would report ' +
        'green for a control that was never exercised. Seed the row or drop the token.',
    );
  }
  logger.info({ checked: SCANNER_TOKENS.filter((t) => t.kind === 'ref' || t.kind === 'title').length }, 'Scanner corpus verified against live rows');
}

async function writePiiCorpus(): Promise<void> {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../deploy/.artifacts');
  await mkdir(dir, { recursive: true });

  const sealed: string[] = [];
  for (const r of RESIDENTS) {
    sealed.push(r.email, r.phone, r.address, r.fullName);
  }
  for (const u of TEST_USERS) {
    sealed.push(u.email, u.fullName);
  }

  /**
   * Staff ACCOUNT identity — the six test users' email and display name.
   *
   * Declared separately from `sealed` because the two are governed by different
   * rules, and conflating them made the scanner flag the national admin for
   * doing their job (H5):
   *
   *   • `sealed` is RESIDENT personal data. It is decryptable only by a
   *     `member:pii_decrypt` holder, only per record, and only on an explicit
   *     audited `?pii=true` request — never in a list, which is why the matrix
   *     sends no such parameter and treats any appearance as a disclosure.
   *   • `accountIdentity` is the identifier of a USER ACCOUNT. `/api/crm/users`
   *     (`role:manage`) and `/api/moderation/users` (`moderate:users`) are the
   *     surfaces that administer those accounts; an email address is the primary
   *     key of the record being administered, so there is no `?pii=true` opt-in
   *     to gate it behind and no way to manage an account without seeing it.
   *
   * The harness therefore treats these values as legitimate on a route whose
   * permission set includes an account-administration permission, and as a hard
   * leak on EVERY other route — including for the same national admin. Keeping
   * them in a separate list rather than dropping them from the corpus is what
   * preserves that second half: an account email surfacing in a member list, a
   * notification or a public feed is still caught.
   */
  const accountIdentity: string[] = [];
  for (const u of TEST_USERS) {
    accountIdentity.push(u.email, u.fullName);
  }

  const corpus = {
    generatedAt: new Date().toISOString(),
    note: "Synthetic Mitchell's Plain validation fixtures. Safe to inspect; contains no real personal data.",
    password: PASSWORD,
    accounts: TEST_USERS.map((u) => ({
      key: u.key,
      email: u.email,
      role: u.role,
      regionCodes: u.regionCodes,
      wardCode: u.wardCode ?? null,
    })),
    /** Values that may only ever surface for a principal holding pii:decrypt. */
    sealed,
    /** Values that may only surface via an explicit ?pii=true request. */
    sealedUnlessRequested: RESIDENTS.map((r) => r.email),
    /** Staff account identifiers — see `accountIdentity` above. */
    accountIdentity,
    /**
     * Values the fixtures publish ON PURPOSE, on a surface anyone can read, from
     * a source that is not sealed member PII.
     *
     * `LEADER_FULL_NAME` is resident `r5` — her email, phone and street address
     * are sealed exactly like every other resident's — AND she is the published
     * ward councillor, whose display name comes from `leaders.full_name` on the
     * unauthenticated transparency overview. That separation is the whole point
     * of FR-C: the leaders directory publishes an official's name and OFFICE
     * contact in their public capacity while their personal details stay sealed.
     *
     * Declared here rather than derived from a live response, because the
     * harness's public baseline is built by calling the very endpoints it is
     * judging: a value an endpoint leaked by accident would be absorbed into its
     * own baseline and the leak would vanish from the report (H4). Seeding the
     * baseline from the seeder's declared intent keeps that circularity out.
     */
    publicByDesign: [LEADER_FULL_NAME],
    /** Ward → parent subcouncil, for resolving a regional principal's territory. */
    wardParents: WARD_PARENTS,
    /**
     * Restricted strings, each attributed to a ward and a rule. Supersedes the
     * earlier flat `outOfScope` deny-list, which could not distinguish "not my
     * ward" from "not my tier" from "not my region".
     */
    tokens: SCANNER_TOKENS,
    /** In-scope wards, for the positive half of the scope assertion. */
    inScope: {
      ward: PRIMARY.code,
      wards: MP_WARDS.map((w) => w.code),
      subcouncils: MP_SUBCOUNCILS,
    },
  };

  const file = path.join(dir, 'validation-fixtures.json');
  await writeFile(file, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
  logger.info({ file, sealedValues: sealed.length, tokens: SCANNER_TOKENS.length }, 'Published leak-scanner corpus');
  await assertCorpusIsBacked();
}

export {
  PASSWORD as VALIDATION_PASSWORD,
  MP_WARDS,
  CONTROL_WARD,
  OUTSIDE_WARDS,
  PRIMARY as PRIMARY_WARD,
  MP_SUBCOUNCILS,
  TEST_USERS,
  RESIDENTS,
  MP_LABEL,
  ensureWardNaming,
  ensureUsers,
  ensureMembers,
  ensureCouncillorIdentity,
  linkMemberAccounts,
  writePiiCorpus,
  memberByEmail,
  userByEmail,
  markerExists,
  rowExists,
};
