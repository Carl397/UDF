import { query } from './pool.js';
import { logger } from '../config/logger.js';

/**
 * Seeds a few open petitions plus some member signatures so the public home
 * and member signing flow have realistic data. Idempotent — skipped when
 * petitions already exist.
 */

const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
};

const PETITIONS = [
  {
    title: 'Petition for Reliable Water Supply in Ward 9',
    body:
      'We, the residents and members of Ward 9, call on the City to restore reliable ' +
      'water supply and publish a transparent repair schedule for the recurring outages.',
    target: 'municipality',
    scope: 'ward',
    goal: 500,
    closesIn: 30,
  },
  {
    title: 'National Petition: Transparent Service-Delivery Budgets',
    body:
      'We call on National Government to mandate publication of municipal service-delivery ' +
      'budgets and spend-to-date in an open, machine-readable format every quarter.',
    target: 'national',
    scope: 'national',
    goal: 5000,
    closesIn: 60,
  },
  {
    title: 'Metro Petition: Safer Streets Lighting Programme',
    body:
      'We petition the Metro to fund and roll out a street-lighting programme prioritised ' +
      'by crime and incident heat-maps across all wards.',
    target: 'province',
    scope: 'metro',
    goal: 1500,
    closesIn: 45,
  },
];

export async function seedPetitions(): Promise<void> {
  const existing = await query<{ c: number }>('SELECT count(*)::int AS c FROM petitions');
  if ((existing.rows[0]?.c ?? 0) > 0) {
    logger.info('Petitions already present — skipping petition seed');
    return;
  }

  // A handful of members to attach signatures to.
  const members = await query<{ id: string; ward: string | null }>(
    'SELECT id, ward FROM members WHERE deleted_at IS NULL ORDER BY created_at LIMIT 12',
  );
  const memberRows = members.rows;

  for (let i = 0; i < PETITIONS.length; i++) {
    const p = PETITIONS[i]!;
    const inserted = await query<{ id: string }>(
      `INSERT INTO petitions (title, body, target, scope, ward_code, region_code, opens_at, closes_at, signature_goal, status)
       VALUES ($1, $2, $3, $4,
               (SELECT code FROM regions WHERE code = $5),
               (SELECT code FROM regions WHERE code = $6),
               now(), $7, $8, 'open')
       RETURNING id`,
      [
        p.title,
        p.body,
        p.target,
        p.scope,
        p.scope === 'ward' ? 'CPT-W009' : null,
        p.scope === 'national' ? null : 'CPT',
        inDays(p.closesIn),
        p.goal,
      ],
    );
    const petitionId = inserted.rows[0]!.id;

    // Attach a spread of signatures (fewer for later petitions).
    const signCount = Math.min(memberRows.length, 8 - i * 3);
    for (let s = 0; s < signCount; s++) {
      const m = memberRows[s]!;
      await query(
        `INSERT INTO petition_signatures (petition_id, member_id, ward_code)
         VALUES ($1, $2, (SELECT code FROM regions WHERE code = $3))
         ON CONFLICT (petition_id, member_id) DO NOTHING`,
        [petitionId, m.id, m.ward],
      );
    }
  }

  logger.info({ count: PETITIONS.length }, 'Seeded petitions');
}
