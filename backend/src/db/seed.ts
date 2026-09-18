import { fileURLToPath } from 'node:url';
import { migrate } from './migrate.js';
import { pool, query } from './pool.js';
import { logger } from '../config/logger.js';
import { createUser } from '../modules/auth/service.js';
import { createMember } from '../modules/members/service.js';
import { seedEngage } from './seedEngage.js';
import { seedServiceDelivery } from './seedServiceDelivery.js';
import { seedPetitions } from './seedPetitions.js';
import { Role } from '../auth/permissions.js';

/**
 * Seeds a demo dataset: an admin + organizer account, a few regions, and a
 * batch of members spread across those regions with sealed PII and geo points.
 * Run with: npm run seed
 */

const DEMO_PASSWORD = 'ChangeMe!12345';

const REGIONS = [
  { code: 'CPT-SC1', name: 'Subcouncil 1 (City Bowl)', parent: 'CPT' },
  { code: 'CPT-SC2', name: 'Subcouncil 2 (South Peninsula)', parent: 'CPT' },
  { code: 'CPT-SC3', name: 'Subcouncil 3 (Khayelitsha / Mitchells Plain)', parent: 'CPT' },
  { code: 'CPT-SC4', name: 'Subcouncil 4 (Blaauwberg / Northern)', parent: 'CPT' },
  { code: 'CPT-SC5', name: 'Subcouncil 5 (Tygerberg)', parent: 'CPT' },
];

// Rough centroid per subcouncil (Cape Town coordinates).
const REGION_CENTERS: Record<string, { lat: number; lng: number }> = {
  'CPT-SC1': { lat: -33.95, lng: 18.43 },
  'CPT-SC2': { lat: -34.12, lng: 18.43 },
  'CPT-SC3': { lat: -34.02, lng: 18.63 },
  'CPT-SC4': { lat: -33.82, lng: 18.55 },
  'CPT-SC5': { lat: -33.88, lng: 18.65 },
};

const TIERS = ['voter', 'volunteer', 'activist', 'donor', 'candidate', 'staff'] as const;
const STATUSES = ['active', 'inactive', 'lapsed', 'pending'] as const;

function jitter(center: number, spread: number): number {
  return center + (Math.random() - 0.5) * spread;
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

async function seed(): Promise<void> {
  await migrate();

  // Regions (idempotent) — ensure Cape Town hierarchy exists.
  await query(
    `INSERT INTO regions (code, name, parent_code, level) VALUES ('CPT','City of Cape Town',NULL,'municipality')
     ON CONFLICT (code) DO NOTHING`,
  );
  for (const r of REGIONS) {
    await query(
      `INSERT INTO regions (code, name, parent_code, level) VALUES ($1,$2,$3,'subcouncil')
       ON CONFLICT (code) DO NOTHING`,
      [r.code, r.name, r.parent],
    );
  }

  // Users (idempotent-ish: createUser conflicts are ignored).
  try {
    await createUser({
      email: 'admin@party.example',
      password: DEMO_PASSWORD,
      role: Role.NATIONAL_ADMIN,
      regionCodes: [],
      fullName: 'National Admin',
    });
    await createUser({
      email: 'north@party.example',
      password: DEMO_PASSWORD,
      role: Role.REGIONAL_ORGANIZER,
      regionCodes: ['CPT-SC4'],
      fullName: 'North Organizer',
    });
    logger.info('Seeded demo users (admin@party.example / north@party.example)');
  } catch (err) {
    logger.warn({ err }, 'User seeding skipped (may already exist)');
  }

  // Members.
  const existing = await query<{ c: string }>('SELECT count(*)::text AS c FROM members');
  if (Number(existing.rows[0]?.c ?? 0) > 0) {
    logger.info('Members already present — skipping member seed');
    return;
  }

  let n = 0;
  for (let i = 0; i < 60; i++) {
    const region = pick(REGIONS).code;
    const center = REGION_CENTERS[region]!;
    const tier = pick(TIERS);
    await createMember(
      {
        tier,
        status: pick(STATUSES),
        regionCode: region,
        districtCode: `CPT-D${1 + (i % 4)}`,
        lat: jitter(center.lat, 0.06),
        lng: jitter(center.lng, 0.06),
        heatWeight: tier === 'donor' ? 5 + Math.random() * 20 : 1 + Math.random() * 5,
        tags: [region.toLowerCase(), tier],
        pii: {
          fullName: `Member ${i + 1}`,
          email: `member${i + 1}@example.com`,
          phone: `+1555${String(1000000 + i).slice(0, 7)}`,
          address: `${100 + i} Demo Street`,
        },
        consent: {
          emailOptin: Math.random() > 0.3,
          smsOptin: Math.random() > 0.6,
          phoneOptin: Math.random() > 0.6,
          dataShare: false,
          gdprBasis: 'consent',
        },
      },
      { actorId: null, actorRole: 'seed', ip: null, userAgent: 'seed-script' },
    );
    n++;
  }
  logger.info({ count: n }, 'Seeded members');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  seed()
    .then(() => seedEngage())
    .then(() => seedServiceDelivery())
    .then(() => seedPetitions())
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, 'Seed failed');
      process.exit(1);
    });
}
