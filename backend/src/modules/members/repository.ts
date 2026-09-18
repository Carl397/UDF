import { query } from '../../db/pool.js';
import type {
  MemberRow,
  ConsentRow,
  MemberScope,
} from './types.js';
import type { CreateMemberInput, UpdateMemberInput, ListMembersQuery } from './schemas.js';

/**
 * Data-access layer for members. All SQL is parameterized (no string
 * interpolation of user input) to prevent SQL injection.
 */

const SELECT_FIELDS = `
  id, membership_no, tier, status, region_code, district_code,
  ST_Y(location::geometry) AS lat,
  ST_X(location::geometry) AS lng,
  heat_weight, sealed_pii, email_bidx, phone_bidx, tags,
  public_code, ward, joined_at,
  created_at, updated_at, deleted_at
`;

/**
 * Build the scope predicate for a caller. Fragments are AND-ed:
 * `null` ⇒ national (no filter), `{ward}` ⇒ one ward, `{regions}` ⇒ a set of
 * parent regions, both ⇒ the intersection. A non-null scope with neither field
 * matches nothing.
 */
function scopeClause(scope: MemberScope, params: unknown[]): string {
  if (scope === null) return '';
  let clause = '';
  if (scope.ward) {
    params.push(scope.ward);
    clause += ` AND ward = $${params.length}`;
  }
  if (scope.regions && scope.regions.length) {
    params.push(scope.regions);
    clause += ` AND region_code = ANY($${params.length}::text[])`;
  }
  return clause || ' AND FALSE';
}

export interface PersistedMember {
  id: string;
  membershipNo: string | null;
  tier: string;
  status: string;
  regionCode: string;
  districtCode: string | null;
  ward: string | null;
  lat: number;
  lng: number;
  heatWeight: number;
  tags: string[];
  sealedPii: unknown;
  emailBidx: Buffer | null;
  phoneBidx: Buffer | null;
  createdBy: string | null;
}

export async function insertMember(m: PersistedMember): Promise<MemberRow> {
  const res = await query<MemberRow>(
    `INSERT INTO members
       (id, membership_no, tier, status, region_code, district_code,
        location, heat_weight, sealed_pii, email_bidx, phone_bidx, tags, created_by, ward)
     VALUES
       ($1,$2,$3,$4,$5,$6,
        ST_SetSRID(ST_MakePoint($7,$8),4326)::geography,
        $9,$10::jsonb,$11,$12,$13,$14,$15)
     RETURNING ${SELECT_FIELDS}`,
    [
      m.id,
      m.membershipNo,
      m.tier,
      m.status,
      m.regionCode,
      m.districtCode,
      m.lng,
      m.lat,
      m.heatWeight,
      JSON.stringify(m.sealedPii),
      m.emailBidx,
      m.phoneBidx,
      m.tags,
      m.createdBy,
      m.ward,
    ],
  );
  return res.rows[0]!;
}

export async function findMemberById(
  id: string,
  scope: MemberScope,
): Promise<MemberRow | null> {
  const params: unknown[] = [id];
  const res = await query<MemberRow>(
    `SELECT ${SELECT_FIELDS} FROM members
      WHERE id = $1 AND deleted_at IS NULL${scopeClause(scope, params)}
      LIMIT 1`,
    params,
  );
  return res.rows[0] ?? null;
}

export async function listMembers(
  filters: ListMembersQuery,
  scope: MemberScope,
): Promise<{ rows: MemberRow[]; total: number }> {
  const params: unknown[] = [];
  let where = 'WHERE deleted_at IS NULL';

  if (filters.regionCode) {
    params.push(filters.regionCode);
    where += ` AND region_code = $${params.length}`;
  }
  if (filters.districtCode) {
    params.push(filters.districtCode);
    where += ` AND district_code = $${params.length}`;
  }
  if (filters.ward) {
    params.push(filters.ward);
    where += ` AND ward = $${params.length}`;
  }
  if (filters.tiers && filters.tiers.length) {
    // `tier` is the `member_tier` enum: cast the array to it so the comparison
    // stays enum = enum (and `members_tier_idx` remains usable).
    params.push(filters.tiers);
    where += ` AND tier = ANY($${params.length}::member_tier[])`;
  } else if (filters.tier) {
    params.push(filters.tier);
    where += ` AND tier = $${params.length}`;
  }
  if (filters.status) {
    params.push(filters.status);
    where += ` AND status = $${params.length}`;
  }
  if (filters.tag) {
    params.push(filters.tag);
    where += ` AND $${params.length} = ANY(tags)`;
  }
  where += scopeClause(scope, params);

  params.push(filters.limit, filters.offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const [countRes, rowsRes] = await Promise.all([
    query<{ total: string }>(
      `SELECT count(*)::text AS total FROM members ${where}`,
      params.slice(0, params.length - 2),
    ),
    query<MemberRow>(
      `SELECT ${SELECT_FIELDS} FROM members ${where}
        ORDER BY created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    ),
  ]);

  return { rows: rowsRes.rows, total: Number(countRes.rows[0]?.total ?? 0) };
}

export interface MemberPatch {
  membershipNo?: string | null;
  tier?: string;
  status?: string;
  regionCode?: string;
  districtCode?: string | null;
  ward?: string | null;
  lat?: number;
  lng?: number;
  heatWeight?: number;
  tags?: string[];
  sealedPii?: unknown;
  emailBidx?: Buffer | null;
  phoneBidx?: Buffer | null;
}

/** Dynamically build an UPDATE with only provided fields (still parameterized). */
export async function updateMember(
  id: string,
  patch: MemberPatch,
  scope: MemberScope,
): Promise<MemberRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  const add = (col: string, value: unknown, raw = false) => {
    params.push(value);
    sets.push(raw ? `${col} = $${params.length}` : `${col} = $${params.length}`);
  };

  if (patch.membershipNo !== undefined) add('membership_no', patch.membershipNo);
  if (patch.tier !== undefined) add('tier', patch.tier);
  if (patch.status !== undefined) add('status', patch.status);
  if (patch.regionCode !== undefined) add('region_code', patch.regionCode);
  if (patch.districtCode !== undefined) add('district_code', patch.districtCode);
  if (patch.ward !== undefined) add('ward', patch.ward);
  if (patch.heatWeight !== undefined) add('heat_weight', patch.heatWeight);
  if (patch.tags !== undefined) add('tags', patch.tags);
  if (patch.sealedPii !== undefined) {
    params.push(JSON.stringify(patch.sealedPii));
    sets.push(`sealed_pii = $${params.length}::jsonb`);
  }
  if (patch.emailBidx !== undefined) add('email_bidx', patch.emailBidx);
  if (patch.phoneBidx !== undefined) add('phone_bidx', patch.phoneBidx);
  if (patch.lat !== undefined && patch.lng !== undefined) {
    params.push(patch.lng, patch.lat);
    sets.push(
      `location = ST_SetSRID(ST_MakePoint($${params.length - 1},$${params.length}),4326)::geography`,
    );
  }

  if (sets.length === 0) return findMemberById(id, scope);

  params.push(id);
  const idIdx = params.length;
  const scopeSql = scopeClause(scope, params);

  const res = await query<MemberRow>(
    `UPDATE members SET ${sets.join(', ')}
      WHERE id = $${idIdx} AND deleted_at IS NULL${scopeSql}
      RETURNING ${SELECT_FIELDS}`,
    params,
  );
  return res.rows[0] ?? null;
}

export async function softDeleteMember(
  id: string,
  scope: MemberScope,
): Promise<boolean> {
  const params: unknown[] = [id];
  const scopeSql = scopeClause(scope, params);
  const res = await query(
    `UPDATE members SET deleted_at = now()
      WHERE id = $1 AND deleted_at IS NULL${scopeSql}`,
    params,
  );
  return (res.rowCount ?? 0) > 0;
}

export async function upsertConsent(
  memberId: string,
  consent: Partial<CreateMemberInput['consent'] & object>,
): Promise<ConsentRow> {
  const c = consent ?? {};
  const res = await query<ConsentRow>(
    `INSERT INTO member_consents
       (member_id, email_optin, sms_optin, phone_optin, data_share, gdpr_basis)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (member_id) DO UPDATE SET
       email_optin = COALESCE($2, member_consents.email_optin),
       sms_optin   = COALESCE($3, member_consents.sms_optin),
       phone_optin = COALESCE($4, member_consents.phone_optin),
       data_share  = COALESCE($5, member_consents.data_share),
       gdpr_basis  = COALESCE($6, member_consents.gdpr_basis)
     RETURNING *`,
    [
      memberId,
      (c as any).emailOptin ?? false,
      (c as any).smsOptin ?? false,
      (c as any).phoneOptin ?? false,
      (c as any).dataShare ?? false,
      (c as any).gdprBasis ?? null,
    ],
  );
  return res.rows[0]!;
}

export async function getConsent(memberId: string): Promise<ConsentRow | null> {
  const res = await query<ConsentRow>(
    'SELECT * FROM member_consents WHERE member_id = $1',
    [memberId],
  );
  return res.rows[0] ?? null;
}

export type { UpdateMemberInput };
