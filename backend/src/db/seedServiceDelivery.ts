import { fileURLToPath } from 'node:url';
import { pool, query } from './pool.js';
import { logger } from '../config/logger.js';
import { createUser } from '../modules/auth/service.js';
import { createMember } from '../modules/members/service.js';
import { Role } from '../auth/permissions.js';
import { blindIndex } from '../security/blindIndex.js';

/**
 * Seeds test users for all roles + ward-level regions + ward profiles.
 * Run with: npm run seed:sd (or chained after seed.ts)
 */

const DEMO_PASSWORD = 'ChangeMe!12345';

// Ward-level regions (Cape Town wards for testing)
const WARDS = [
  { code: 'CPT-W009', name: 'Ward 9', parent: 'CPT-SC4', municipality: 'City of Cape Town' },
  { code: 'CPT-W025', name: 'Ward 25', parent: 'CPT-SC1', municipality: 'City of Cape Town' },
  { code: 'CPT-W032', name: 'Ward 32', parent: 'CPT-SC2', municipality: 'City of Cape Town' },
  { code: 'CPT-W045', name: 'Ward 45', parent: 'CPT-SC1', municipality: 'City of Cape Town' },
  { code: 'CPT-W061', name: 'Ward 61', parent: 'CPT-SC2', municipality: 'City of Cape Town' },
];

// Test users for all roles
const TEST_USERS = [
  {
    email: 'national.admin@udf.example',
    fullName: 'National Administrator',
    role: Role.NATIONAL_ADMIN,
    regionCodes: [],
    wardCode: undefined,
  },
  {
    email: 'regional.organizer@udf.example',
    fullName: 'Regional Organizer (North)',
    role: Role.REGIONAL_ORGANIZER,
    regionCodes: ['NORTH'],
    wardCode: undefined,
  },
  {
    email: 'local.coordinator@udf.example',
    fullName: 'Local Coordinator (Ward 9)',
    role: Role.LOCAL_COORDINATOR,
    regionCodes: ['CPT-SC4'],
    wardCode: 'CPT-W009',
  },
  {
    email: 'councillor.ward9@udf.example',
    fullName: 'Ward 9 Councillor',
    role: Role.WARD_COUNCILLOR,
    regionCodes: ['CPT-SC4'],
    wardCode: 'CPT-W009',
    memberId: null as string | null, // will be set after member creation
  },
  {
    email: 'analyst@udf.example',
    fullName: 'National Analyst',
    role: Role.ANALYST,
    regionCodes: [],
    wardCode: undefined,
  },
  {
    email: 'member.ward9@udf.example',
    fullName: 'Ward 9 Member',
    role: Role.MEMBER,
    regionCodes: ['CPT-SC4'],
    wardCode: 'CPT-W009',
    memberId: null as string | null, // will be set after member creation
  },
];

async function seedServiceDelivery(): Promise<void> {
  logger.info('Seeding service-delivery test data...');

  // 1. Create ward-level regions
  for (const w of WARDS) {
    await query(
      `INSERT INTO regions (code, name, parent_code, level)
       VALUES ($1, $2, $3, 'ward')
       ON CONFLICT (code) DO NOTHING`,
      [w.code, w.name, w.parent],
    );
  }
  logger.info({ count: WARDS.length }, 'Created ward-level regions');

  // 2. Create test users
  for (const u of TEST_USERS) {
    try {
      await createUser({
        email: u.email,
        password: DEMO_PASSWORD,
        role: u.role,
        regionCodes: u.regionCodes,
        fullName: u.fullName,
      });
      logger.info({ email: u.email, role: u.role }, 'Created test user');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('duplicate') || msg.includes('already')) {
        logger.warn({ email: u.email }, 'Test user already exists — skipping');
      } else {
        throw err;
      }
    }
  }

  // 3. Create members for councillor and member roles (linked to users)
  const councillorUser = await query<{ id: string }>(
    'SELECT id FROM users WHERE email_bidx = $1',
    [blindIndex('email', 'councillor.ward9@udf.example')],
  );
  const memberUser = await query<{ id: string }>(
    'SELECT id FROM users WHERE email_bidx = $1',
    [blindIndex('email', 'member.ward9@udf.example')],
  );

  if (councillorUser.rows[0]) {
    const existingMember = await query<{ id: string }>(
      'SELECT id FROM members WHERE created_by = $1 LIMIT 1',
      [councillorUser.rows[0].id],
    );
    if (!existingMember.rows[0]) {
      const councillorMember = await createMember(
        {
          tier: 'activist',
          status: 'active',
          regionCode: 'CPT-SC4',
          ward: 'CPT-W009',
          lat: -33.82,
          lng: 18.55,
          heatWeight: 10,
          tags: ['councillor', 'ward-9'],
          pii: {
            fullName: 'Ward 9 Councillor',
            email: 'councillor.ward9@udf.example',
            phone: '+15550100900',
            address: '1 Councillor Lane, Ward 9',
          },
          consent: {
            emailOptin: true,
            smsOptin: true,
            phoneOptin: true,
            dataShare: true,
            gdprBasis: 'consent',
          },
        },
        { actorId: councillorUser.rows[0].id, actorRole: 'seed', ip: null, userAgent: 'seed-script' },
      );
      // Link user to member via ward_profiles
      await query(
        `INSERT INTO ward_profiles (ward_code, councillor_member_id, municipality, population, registered_voters)
         VALUES ('CPT-W009', $1, 'City of Cape Town', 35000, 22000)
         ON CONFLICT (ward_code) DO UPDATE SET councillor_member_id = $1`,
        [councillorMember.id],
      );
      logger.info({ memberId: councillorMember.id }, 'Created councillor member + ward_profile');
    }
  }

  if (memberUser.rows[0]) {
    const existingMember = await query<{ id: string }>(
      'SELECT id FROM members WHERE created_by = $1 LIMIT 1',
      [memberUser.rows[0].id],
    );
    if (!existingMember.rows[0]) {
      await createMember(
        {
          tier: 'voter',
          status: 'active',
          regionCode: 'CPT-SC4',
          ward: 'CPT-W009',
          lat: -33.821,
          lng: 18.549,
          heatWeight: 2,
          tags: ['member', 'ward-9'],
          pii: {
            fullName: 'Ward 9 Resident',
            email: 'member.ward9@udf.example',
            phone: '+15550100901',
            address: '42 Resident Road, Ward 9',
          },
          consent: {
            emailOptin: true,
            smsOptin: false,
            phoneOptin: false,
            dataShare: false,
            gdprBasis: 'consent',
          },
        },
        { actorId: memberUser.rows[0].id, actorRole: 'seed', ip: null, userAgent: 'seed-script' },
      );
      logger.info('Created member (Ward 9 resident)');
    }
  }

  logger.info('Service-delivery seed complete');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  seedServiceDelivery()
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, 'Service-delivery seed failed');
      process.exit(1);
    });
}

export { seedServiceDelivery };
