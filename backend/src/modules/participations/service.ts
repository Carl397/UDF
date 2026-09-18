import { query } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import { recordAudit } from '../../security/audit.js';
import type { Principal } from '../../auth/permissions.js';
import type { z } from 'zod';
import type { createParticipationSchema, createParticipationCommentSchema } from './schemas.js';

export interface Participation {
  id: string;
  title: string;
  subject: string | null;
  body: string | null;
  scope: string;
  wardCode: string | null;
  regionCode: string | null;
  opensAt: Date;
  closesAt: Date;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function createParticipation(
  input: z.infer<typeof createParticipationSchema>,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<Participation> {
  const res = await query<Participation>(
    `INSERT INTO public_participations (title, subject, body, scope, ward_code, region_code, opens_at, closes_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, title, subject, body, scope, ward_code AS "wardCode", region_code AS "regionCode",
            opens_at AS "opensAt", closes_at AS "closesAt", status,
            created_at AS "createdAt", updated_at AS "updatedAt"`,
    [input.title, input.subject ?? null, input.body ?? null, input.scope,
     input.wardCode ?? principal.wardCode ?? null, input.regionCode ?? null,
     input.opensAt, input.closesAt, principal.sub],
  );

  if (res.rowCount === 0) throw new Error('Failed to create participation');
  const participation = res.rows[0]!;

  await recordAudit({
    action: 'participation.create',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'public_participations',
    targetId: participation.id,
    metadata: { title: participation.title, wardCode: participation.wardCode },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return participation;
}

export async function addComment(
  participationId: string,
  input: z.infer<typeof createParticipationCommentSchema>,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<{ id: string; comment: string; createdAt: Date }> {
  // Enforce mandatory reason for low ratings
  if (input.rating && input.rating <= 2 && !input.reasonIfLow) {
    throw ApiError.badRequest('A reason is required for ratings of 2 or below');
  }

  const res = await query<{ id: string; comment: string; createdAt: Date }>(
    `INSERT INTO participation_comments (participation_id, member_id, ward_code, comment, rating, reason_if_low)
     SELECT $1,
            (SELECT id FROM members WHERE created_by = $5 LIMIT 1),
            (SELECT ward_code FROM regions WHERE level = 'ward' AND code = (SELECT ward_code FROM users WHERE id = $5) LIMIT 1),
            $2, $3, $4
     RETURNING id, comment, created_at AS "createdAt"`,
    [participationId, input.comment, input.rating ?? null, input.reasonIfLow ?? null, principal.sub],
  );

  if (res.rowCount === 0) throw new Error('Failed to add comment');

  await recordAudit({
    action: 'participation.comment',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'participation_comments',
    targetId: res.rows[0]!.id,
    metadata: { participationId, comment: input.comment.substring(0, 100) },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return res.rows[0]!;
}

export async function listParticipations(filters: {
  wardCode?: string;
  status?: string;
  limit: number;
  offset: number;
}): Promise<{ items: Participation[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filters.wardCode) { conditions.push(`ward_code = $${idx++}`); values.push(filters.wardCode); }
  if (filters.status) { conditions.push(`status = $${idx++}`); values.push(filters.status); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [itemsRes, countRes] = await Promise.all([
    query<Participation>(
      `SELECT id, title, subject, body, scope, ward_code AS "wardCode", region_code AS "regionCode",
              opens_at AS "opensAt", closes_at AS "closesAt", status,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM public_participations ${where}
       ORDER BY opens_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...values, filters.limit, filters.offset],
    ),
    query<{ total: string }>(`SELECT COUNT(*) AS total FROM public_participations ${where}`, values),
  ]);

  return { items: itemsRes.rows, total: parseInt(countRes.rows[0]?.total ?? '0', 10) };
}

export async function getParticipation(id: string): Promise<Participation | null> {
  const res = await query<Participation>(
    `SELECT id, title, subject, body, scope, ward_code AS "wardCode", region_code AS "regionCode",
            opens_at AS "opensAt", closes_at AS "closesAt", status,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM public_participations WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}
