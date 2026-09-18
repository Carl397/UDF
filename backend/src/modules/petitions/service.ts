import { query } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';

/**
 * Petitions — public view + member signing.
 *
 * Petitions are part of the party's public participation surface: anyone can
 * read open petitions, and confirmed members sign with their public party code
 * (members have no staff login, so the code is their identity here).
 */

export interface PetitionSummary {
  id: string;
  title: string;
  body: string | null;
  target: string;
  scope: string;
  wardCode: string | null;
  regionCode: string | null;
  opensAt: string | null;
  closesAt: string | null;
  signatureGoal: number | null;
  status: string;
  signatureCount: number;
}

/** Open petitions (within their signing window) with live signature counts. */
export async function listOpenPetitions(): Promise<PetitionSummary[]> {
  const res = await query<{
    id: string;
    title: string;
    body: string | null;
    target: string;
    scope: string;
    ward_code: string | null;
    region_code: string | null;
    opens_at: string | null;
    closes_at: string | null;
    signature_goal: number | null;
    status: string;
    signature_count: number;
  }>(
    `SELECT p.id, p.title, p.body, p.target, p.scope, p.ward_code, p.region_code,
            p.opens_at, p.closes_at, p.signature_goal, p.status,
            (SELECT count(*)::int FROM petition_signatures s WHERE s.petition_id = p.id) AS signature_count
       FROM petitions p
      WHERE p.status = 'open'
        AND (p.opens_at IS NULL OR p.opens_at <= now())
        AND (p.closes_at IS NULL OR p.closes_at > now())
      ORDER BY p.closes_at NULLS LAST, p.created_at DESC`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    target: r.target,
    scope: r.scope,
    wardCode: r.ward_code,
    regionCode: r.region_code,
    opensAt: r.opens_at,
    closesAt: r.closes_at,
    signatureGoal: r.signature_goal,
    status: r.status,
    signatureCount: r.signature_count,
  }));
}

export interface SignResult {
  petitionId: string;
  signatureCount: number;
  alreadySigned: boolean;
}

/**
 * Record a member's signature on an open petition. Idempotent: signing twice
 * is not an error, it simply reports alreadySigned.
 */
export async function signPetition(petitionId: string, publicCode: string): Promise<SignResult> {
  const pet = await query<{ id: string; status: string; closes_at: string | null }>(
    'SELECT id, status, closes_at FROM petitions WHERE id = $1',
    [petitionId],
  );
  const p = pet.rows[0];
  if (!p) throw ApiError.notFound('Petition not found');
  if (p.status !== 'open') throw ApiError.conflict('This petition is not open for signing');
  if (p.closes_at && new Date(p.closes_at).getTime() <= Date.now()) {
    throw ApiError.conflict('This petition has closed');
  }

  const code = publicCode.trim().toUpperCase();
  const member = await query<{ id: string; ward: string | null }>(
    'SELECT id, ward FROM members WHERE public_code = $1 AND deleted_at IS NULL',
    [code],
  );
  const m = member.rows[0];
  if (!m) throw ApiError.notFound('That party code is not recognised');

  const before = await query<{ c: number }>(
    'SELECT count(*)::int AS c FROM petition_signatures WHERE petition_id = $1 AND member_id = $2',
    [p.id, m.id],
  );
  const alreadySigned = (before.rows[0]?.c ?? 0) > 0;

  // ward_code only lands if the member's ward is a known region code.
  await query(
    `INSERT INTO petition_signatures (petition_id, member_id, ward_code)
     VALUES ($1, $2, (SELECT code FROM regions WHERE code = $3))
     ON CONFLICT (petition_id, member_id) DO NOTHING`,
    [p.id, m.id, m.ward],
  );

  const count = await query<{ c: number }>(
    'SELECT count(*)::int AS c FROM petition_signatures WHERE petition_id = $1',
    [p.id],
  );
  return { petitionId: p.id, signatureCount: count.rows[0]?.c ?? 0, alreadySigned };
}
