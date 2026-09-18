import { fileURLToPath } from 'node:url';
import { pool, query } from './pool.js';
import { logger } from '../config/logger.js';
import { createUser } from '../modules/auth/service.js';
import { createMember } from '../modules/members/service.js';
import { Role } from '../auth/permissions.js';
import { blindIndex } from '../security/blindIndex.js';
import { refreshDemand } from '../modules/jobs/service.js';

/**
 * Seeds the Ward Job Interest Register demo data (PRD-jobs §9.1):
 *   • 3 active job interests across ≥2 work types for Ward 9 (NORTH-W09)
 *   • 1 DRAFT opportunity overlapping those work types (so a publish relays)
 *   • today's demand rollup (job_demand_daily) rebuilt from the interests
 *
 * Idempotent: safe to re-run. The real `member.ward9` account registers their
 * own interest; two synthetic job-seeker personas are created for aggregate
 * depth. NO CV / document data exists by design (PRD-jobs NG1).
 *
 * Run with: npm run seed:jobs
 */

const DEMO_PASSWORD = 'ChangeMe!12345';
const WARD = 'NORTH-W09';
const REGION = 'NORTH';
// Approximate centroid for the synthetic member pins.
const WARD_LAT = -33.82;
const WARD_LNG = 18.55;

/** The real member account created by seedServiceDelivery. */
const REAL_MEMBER_EMAIL = 'member.ward9@udf.example';
const REAL_MEMBER = {
  firstName: 'Ward9',
  surname: 'Resident',
  workTypes: ['labourer', 'gardening'],
  experience: 'Available for general labour and garden maintenance.',
};

/** Two synthetic job-seeker personas (own user + member + interest). */
const PERSONAS = [
  {
    email: 'jobseeker2.ward9@udf.example',
    fullName: 'Nomsa Dlamini',
    firstName: 'Nomsa',
    surname: 'Dlamini',
    workTypes: ['catering', 'cleaning'],
    experience: 'Event catering and cleaning; food-handling certificate.',
  },
  {
    email: 'jobseeker3.ward9@udf.example',
    fullName: 'Sipho Khumalo',
    firstName: 'Sipho',
    surname: 'Khumalo',
    workTypes: ['labourer', 'driving'],
    experience: 'Construction labourer; code 10 driver.',
  },
];

/** The draft opportunity seeded for the ward (overlaps the interests above). */
const SEED_OPPORTUNITY = {
  refNo: `UDF-JOB-${WARD}-000001`,
  title: 'Site labourers & catering for ward upgrade',
  company: 'NORTH-W09 Project Consortium',
  workTypes: ['labourer', 'catering'],
  description:
    'Short-term work on the ward upgrade project. Apply directly to the company — no CV is held on the UDF platform.',
  contactEmail: 'jobs@northw09consortium.example',
  contactPhone: '+275550100910',
  closesAt: (() => {
    const d = new Date();
    d.setDate(d.getDate() + 21);
    return d.toISOString().slice(0, 10);
  })(),
};

/** Look up a user id by email via the blind index (null when absent). */
async function userIdByEmail(email: string): Promise<string | null> {
  const res = await query<{ id: string }>('SELECT id FROM users WHERE email_bidx = $1', [
    blindIndex('email', email),
  ]);
  return res.rows[0]?.id ?? null;
}

/** Create a user (or return the existing id). */
async function ensureUser(opts: {
  email: string;
  fullName: string;
  role: Role;
  regionCodes: string[];
  wardCode?: string;
}): Promise<string> {
  const existing = await userIdByEmail(opts.email);
  if (existing) return existing;
  try {
    return await createUser({
      email: opts.email,
      password: DEMO_PASSWORD,
      role: opts.role,
      regionCodes: opts.regionCodes,
      wardCode: opts.wardCode,
      fullName: opts.fullName,
    });
  } catch (err) {
    // Race / already-exists → resolve by blind index.
    const again = await userIdByEmail(opts.email);
    if (again) return again;
    throw err;
  }
}

/** Create a member row owned by `userId` (or return the existing one). */
async function ensureMember(
  userId: string,
  opts: { fullName: string; email: string; tags: string[] },
): Promise<string> {
  const existing = await query<{ id: string }>(
    'SELECT id FROM members WHERE created_by = $1 AND deleted_at IS NULL LIMIT 1',
    [userId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await createMember(
    {
      tier: 'voter',
      status: 'active',
      regionCode: REGION,
      ward: WARD,
      lat: WARD_LAT,
      lng: WARD_LNG,
      heatWeight: 2,
      tags: opts.tags,
      pii: { fullName: opts.fullName, email: opts.email },
      consent: { emailOptin: true, smsOptin: false, phoneOptin: false, dataShare: false, gdprBasis: 'consent' },
    },
    { actorId: userId, actorRole: 'seed', ip: null, userAgent: 'seed-jobs' },
  );
  return created.id;
}

/** Upsert one active interest (one per member). */
async function upsertInterest(row: {
  memberId: string;
  userId: string;
  firstName: string;
  surname: string;
  email: string;
  workTypes: string[];
  experience: string;
}): Promise<void> {
  await query(
    `INSERT INTO job_interests
       (member_id, user_id, ward_code, region_code, first_name, surname, email, work_types, experience, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')
     ON CONFLICT (member_id) WHERE status = 'active'
     DO UPDATE SET first_name = EXCLUDED.first_name, surname = EXCLUDED.surname,
                   email = EXCLUDED.email, work_types = EXCLUDED.work_types,
                   experience = EXCLUDED.experience, ward_code = EXCLUDED.ward_code,
                   region_code = EXCLUDED.region_code, updated_at = now()`,
    [row.memberId, row.userId, WARD, REGION, row.firstName, row.surname, row.email, row.workTypes, row.experience],
  );
}

async function seedJobs(): Promise<void> {
  logger.info({ ward: WARD }, 'Seeding ward job-interest demo data...');

  // 1. Real member.ward9 registers their own interest.
  const realUserId = await userIdByEmail(REAL_MEMBER_EMAIL);
  if (realUserId) {
    const realMember = await query<{ id: string }>(
      'SELECT id FROM members WHERE created_by = $1 AND deleted_at IS NULL LIMIT 1',
      [realUserId],
    );
    if (realMember.rows[0]) {
      await upsertInterest({
        memberId: realMember.rows[0].id,
        userId: realUserId,
        firstName: REAL_MEMBER.firstName,
        surname: REAL_MEMBER.surname,
        email: REAL_MEMBER_EMAIL,
        workTypes: REAL_MEMBER.workTypes,
        experience: REAL_MEMBER.experience,
      });
      logger.info({ email: REAL_MEMBER_EMAIL }, 'Seeded job interest for real member');
    } else {
      logger.warn({ email: REAL_MEMBER_EMAIL }, 'Real member has no member row — skipped interest');
    }
  } else {
    logger.warn({ email: REAL_MEMBER_EMAIL }, 'Real member account not found — run seed:sd first');
  }

  // 2. Synthetic job-seeker personas.
  for (const p of PERSONAS) {
    const userId = await ensureUser({
      email: p.email,
      fullName: p.fullName,
      role: Role.MEMBER,
      regionCodes: [REGION],
      wardCode: WARD,
    });
    const memberId = await ensureMember(userId, {
      fullName: p.fullName,
      email: p.email,
      tags: ['member', 'ward-9', 'job-seeker'],
    });
    await upsertInterest({
      memberId,
      userId,
      firstName: p.firstName,
      surname: p.surname,
      email: p.email,
      workTypes: p.workTypes,
      experience: p.experience,
    });
    logger.info({ email: p.email }, 'Seeded synthetic job-seeker interest');
  }

  // 3. One DRAFT opportunity for the ward (authored by the ward councillor).
  const councillorId =
    (await userIdByEmail('councillor.ward9@udf.example')) ??
    (await userIdByEmail('national.admin@udf.example'));
  await query(
    `INSERT INTO job_opportunities
       (ref_no, ward_code, region_code, title, company, work_types, description,
        contact_email, contact_phone, status, created_by, closes_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11)
     ON CONFLICT (ref_no) DO NOTHING`,
    [
      SEED_OPPORTUNITY.refNo, WARD, REGION, SEED_OPPORTUNITY.title, SEED_OPPORTUNITY.company,
      SEED_OPPORTUNITY.workTypes, SEED_OPPORTUNITY.description, SEED_OPPORTUNITY.contactEmail,
      SEED_OPPORTUNITY.contactPhone, councillorId, SEED_OPPORTUNITY.closesAt,
    ],
  );
  logger.info({ ref: SEED_OPPORTUNITY.refNo }, 'Seeded draft opportunity');

  // 4. Rebuild today's aggregate rollup from the active interests.
  await refreshDemand(WARD, REGION);

  const summary = await query<{ interests: string; types: string; opps: string }>(
    `SELECT
       (SELECT count(*)::text FROM job_interests WHERE ward_code = $1 AND status = 'active') AS interests,
       (SELECT count(DISTINCT wt)::text FROM job_interests, unnest(work_types) wt WHERE ward_code = $1 AND status = 'active') AS types,
       (SELECT count(*)::text FROM job_opportunities WHERE ward_code = $1) AS opps`,
    [WARD],
  );
  logger.info({ ...summary.rows[0] }, 'Ward job seed complete');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  seedJobs()
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, 'Jobs seed failed');
      process.exit(1);
    });
}

export { seedJobs };
