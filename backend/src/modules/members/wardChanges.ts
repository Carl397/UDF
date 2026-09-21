import type { PoolClient } from 'pg';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { Role, type Principal } from '../../auth/permissions.js';
import { signAccessToken } from '../../auth/tokens.js';
import { ApiError } from '../../http/errors.js';

const MAX_WARD_CHANGES = 3;

export const changeOwnWardSchema = z.object({
  wardCode: z.string().trim().min(1).max(64),
  // Compare-and-set prevents an old screen or a concurrent request from using
  // another allowance without the member seeing their current ward first.
  expectedWardCode: z.string().max(64).nullable(),
}).strict();

type WardRow = {
  member_id: string;
  ward: string | null;
  ward_name: string | null;
  region_code: string | null;
  changes_used: number;
};

function view(row: WardRow) {
  return {
    wardCode: row.ward,
    wardName: row.ward_name,
    regionCode: row.region_code,
    changesUsed: row.changes_used,
    changesRemaining: Math.max(0, MAX_WARD_CHANGES - row.changes_used),
    maxChanges: MAX_WARD_CHANGES,
  };
}

async function readOwnWard(userId: string, run: typeof query): Promise<WardRow> {
  const row = (await run<WardRow>(
    `SELECT m.id AS member_id, m.ward, r.name AS ward_name, m.region_code,
            GREATEST(m.ward_changes_used, (
              SELECT count(*)::int FROM ward_change_log w
               WHERE w.member_id = m.id AND w.from_ward IS NOT NULL
                 AND w.from_ward IS DISTINCT FROM w.to_ward
            )) AS changes_used
       FROM users u JOIN members m ON m.id = u.member_id
       LEFT JOIN regions r ON r.code = m.ward
      WHERE u.id = $1 AND u.role = 'member' AND u.is_active
        AND m.deleted_at IS NULL`, [userId])).rows[0];
  if (!row) throw ApiError.forbidden('No member profile is linked to this account');
  return row;
}

function requireMember(p: Principal) {
  if (p.role !== Role.MEMBER) {
    throw ApiError.forbidden('Registered-ward self-service is available to members only');
  }
}

export async function getOwnWardChanges(p: Principal) {
  requireMember(p);
  return view(await readOwnWard(p.sub, query));
}

/** A lifetime allowance, not a device counter or a rolling election-term cap. */
export async function changeOwnWard(p: Principal, raw: z.infer<typeof changeOwnWardSchema>) {
  requireMember(p);
  const input = changeOwnWardSchema.parse(raw);
  return withTransaction(async (client: PoolClient) => {
    const run = client.query.bind(client) as typeof query;
    // Serialize every self-service change for this account AND member. Resolve
    // the canonical users.member_id link, never members.created_by.
    const user = (await run<{
      member_id: string | null; role: string; token_version: number;
      is_active: boolean; moderation_status: string; suspended_until: string | null;
    }>(`SELECT member_id, role, token_version, is_active, moderation_status, suspended_until
          FROM users WHERE id = $1 FOR UPDATE`, [p.sub])).rows[0];
    if (!user || !user.is_active || user.moderation_status === 'banned' ||
        (user.suspended_until && new Date(user.suspended_until).getTime() > Date.now())) {
      throw ApiError.unauthorized();
    }
    if (user.role !== Role.MEMBER || !user.member_id) {
      throw ApiError.forbidden('No member profile is linked to this account');
    }
    await run('SELECT id FROM members WHERE id = $1 FOR UPDATE', [user.member_id]);
    let row = await readOwnWard(p.sub, run);
    const changed = row.ward !== input.wardCode;
    if (changed) {
      if (row.ward !== input.expectedWardCode) {
        throw ApiError.conflict('Your registered ward has changed. Reload it before trying again.');
      }
      if (row.changes_used >= MAX_WARD_CHANGES) {
        throw ApiError.conflict('You have used all 3 ward changes. Your registered ward cannot be changed again.');
      }
      const destination = (await run<{ code: string; name: string; parent_code: string | null }>(
        `SELECT code, name, parent_code FROM regions
          WHERE code = $1 AND level = 'ward' FOR SHARE`, [input.wardCode])).rows[0];
      if (!destination?.parent_code) throw ApiError.badRequest('Select a valid ward with a parent region');
      // First assignment is not a change. Existing allowances/history are never
      // reset by a missing ward, reinstatement, logout, reinstall or term date.
      const used = row.changes_used + (row.ward === null ? 0 : 1);
      await run(`UPDATE members SET ward = $2, region_code = $3,
          district_code = NULL, location = NULL, ward_changes_used = $4,
          tags = ARRAY(SELECT tag FROM unnest(tags) AS tag WHERE tag NOT LIKE 'ward:%') || ARRAY[$5::text]
          WHERE id = $1`, [row.member_id, destination.code, destination.parent_code, used, `ward:${destination.code}`]);
      // This is the durable audit trail and commits atomically with the counter.
      // No address, reason text, fabricated OTP, or other PII is recorded.
      await run(`INSERT INTO ward_change_log(member_id, from_ward, to_ward, reason, changed_by)
          VALUES ($1,(SELECT code FROM regions WHERE code = $2),$3,'Member self-service',$4)`,
        [row.member_id, row.ward, destination.code, p.sub]);
      await run(`UPDATE users SET ward_code = $2, ward_codes = ARRAY[$2::text], region_codes = ARRAY[$3::text]
          WHERE id = $1`, [p.sub, destination.code, destination.parent_code]);
      row = { ...row, ward: destination.code, ward_name: destination.name,
        region_code: destination.parent_code, changes_used: used };
    }
    // Keep the existing refresh token/session. A fresh access token updates the
    // current UI immediately; authenticate also reads LIVE scope for old tokens.
    const accessToken = signAccessToken({ sub: p.sub, role: Role.MEMBER,
      wardCode: row.ward ?? undefined, regionCodes: row.region_code ? [row.region_code] : [] }, user.token_version);
    return { ...view(row), changed, accessToken };
  });
}
