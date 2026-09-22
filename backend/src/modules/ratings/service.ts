import { query, withReadSnapshot } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import { recordAudit } from '../../security/audit.js';
import { Permission, type Principal } from '../../auth/permissions.js';
import { wardCodeScope, privateTierClause, canSeeUnpublished } from '../../auth/scope.js';
import type { z } from 'zod';
import { listRatingsQuery, type createRatingSchema } from './schemas.js';

export interface Rating {
  id: string;
  targetType: 'service_request' | 'project' | 'participation' | 'councillor' | 'patrol';
  targetId: string;
  memberId: string;
  rating: number;
  reason: string | null;
  createdAt: Date;
}

export async function createRating(
  input: z.infer<typeof createRatingSchema>,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<Rating> {
  if (input.rating <= 2 && !input.reason) {
    throw ApiError.badRequest('A reason is required for ratings of 2 or below');
  }

  const res = await query<Rating>(
    `INSERT INTO ratings (target_type, target_id, member_id, rating, reason)
     SELECT $1, $2,
            (SELECT id FROM members WHERE created_by = $5 LIMIT 1),
            $3, $4
     RETURNING id, target_type AS "targetType", target_id AS "targetId",
            member_id AS "memberId", rating, reason, created_at AS "createdAt"`,
    [input.targetType, input.targetId, input.rating, input.reason ?? null, principal.sub],
  );

  if (res.rowCount === 0) throw new Error('Failed to create rating');
  const rating = res.rows[0]!;

  await recordAudit({
    action: 'rating.create',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'ratings',
    targetId: rating.id,
    metadata: { targetType: input.targetType, targetId: input.targetId, rating: input.rating },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return rating;
}

export async function listRatings(input: {
  targetType?: string;
  targetId?: string;
  limit: number;
  offset: number;
}, principal: Principal): Promise<{ items: Rating[]; total: number }> {
  if (!principal?.permissions?.includes(Permission.OVERVIEW_READ)) throw ApiError.forbidden();
  const filters = listRatingsQuery.parse(input);
  const scope = await wardCodeScope(principal, 'x.ward_code', 1);
  const tier = privateTierClause(principal, 'x.visibility');
  const publication = canSeeUnpublished(principal) ? '' : ' AND x.is_published';
  const leaderPublication = canSeeUnpublished(principal) ? '' : ' AND x.is_public';
  // Resolve the actual target, never the submitter's current ward. Missing or
  // unsupported targets fail closed; secondary display assignments confer no access.
  const conditions = [`CASE r.target_type::text
    WHEN 'service_request' THEN EXISTS (SELECT 1 FROM service_requests x WHERE x.id=r.target_id${scope.sql}${tier})
    WHEN 'patrol' THEN EXISTS (SELECT 1 FROM patrols x WHERE x.id=r.target_id${scope.sql}${tier})
    WHEN 'project' THEN EXISTS (SELECT 1 FROM projects x WHERE x.id=r.target_id${scope.sql}${publication})
    WHEN 'participation' THEN EXISTS (SELECT 1 FROM public_participations x WHERE x.id=r.target_id${scope.sql})
    WHEN 'councillor' THEN EXISTS (SELECT 1 FROM leaders x WHERE x.member_id=r.target_id${scope.sql}${leaderPublication})
    ELSE FALSE END`];
  const values = [...scope.params];
  let idx = scope.nextIndex;
  if (filters.targetType) { conditions.push(`r.target_type::text = $${idx++}`); values.push(filters.targetType); }
  if (filters.targetId) { conditions.push(`r.target_id = $${idx++}`); values.push(filters.targetId); }
  const where = `WHERE ${conditions.join(' AND ')}`;
  return withReadSnapshot(async (run) => {
    const count = await run<{ total: number }>(`SELECT count(*)::int AS total FROM ratings r ${where}`, values);
    const items = await run<Rating>(
      `SELECT r.id, r.target_type AS "targetType", r.target_id AS "targetId",
         r.member_id AS "memberId", r.rating, r.reason, r.created_at AS "createdAt"
       FROM ratings r ${where} ORDER BY r.created_at DESC, r.id LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, filters.limit, filters.offset]);
    return { items: items.rows, total: count.rows[0]!.total };
  });
}

export async function getAverageRating(targetType: string, targetId: string): Promise<{ avg: number; count: number }> {
  const res = await query<{ avg: string; count: string }>(
    `SELECT COALESCE(AVG(rating), 0) AS avg, COUNT(*) AS count
     FROM ratings WHERE target_type = $1 AND target_id = $2`,
    [targetType, targetId],
  );
  return { avg: parseFloat(res.rows[0]?.avg ?? '0'), count: parseInt(res.rows[0]?.count ?? '0', 10) };
}
