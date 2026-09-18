import { query } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import { recordAudit } from '../../security/audit.js';
import type { Principal } from '../../auth/permissions.js';
import type { z } from 'zod';
import type { createRatingSchema } from './schemas.js';

export interface Rating {
  id: string;
  targetType: string;
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

export async function listRatings(filters: {
  targetType?: string;
  targetId?: string;
  limit: number;
  offset: number;
}): Promise<{ items: Rating[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filters.targetType) { conditions.push(`target_type = $${idx++}`); values.push(filters.targetType); }
  if (filters.targetId) { conditions.push(`target_id = $${idx++}`); values.push(filters.targetId); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [itemsRes, countRes] = await Promise.all([
    query<Rating>(
      `SELECT id, target_type AS "targetType", target_id AS "targetId",
              member_id AS "memberId", rating, reason, created_at AS "createdAt"
       FROM ratings ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...values, filters.limit, filters.offset],
    ),
    query<{ total: string }>(`SELECT COUNT(*) AS total FROM ratings ${where}`, values),
  ]);

  return { items: itemsRes.rows, total: parseInt(countRes.rows[0]?.total ?? '0', 10) };
}

export async function getAverageRating(targetType: string, targetId: string): Promise<{ avg: number; count: number }> {
  const res = await query<{ avg: string; count: string }>(
    `SELECT COALESCE(AVG(rating), 0) AS avg, COUNT(*) AS count
     FROM ratings WHERE target_type = $1 AND target_id = $2`,
    [targetType, targetId],
  );
  return { avg: parseFloat(res.rows[0]?.avg ?? '0'), count: parseInt(res.rows[0]?.count ?? '0', 10) };
}
