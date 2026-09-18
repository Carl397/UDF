import { query } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import { recordAudit } from '../../security/audit.js';
import type { Principal } from '../../auth/permissions.js';
import type { z } from 'zod';
import type { createVerificationSchema } from './schemas.js';

export interface Verification {
  id: string;
  serviceRequestId: string;
  memberId: string;
  verdict: string;
  note: string | null;
  photoId: string | null;
  createdAt: Date;
}

export async function createVerification(
  input: z.infer<typeof createVerificationSchema>,
  principal: Principal,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<Verification> {
  // Check SR status - must be 'resolved' to verify
  const srRes = await query<{ status: string; councillorMemberId: string | null }>(
    `SELECT status, councillor_member_id AS "councillorMemberId"
     FROM service_requests WHERE id = $1`,
    [input.serviceRequestId],
  );
  if (srRes.rowCount === 0) throw ApiError.notFound('Service request not found');
  const sr = srRes.rows[0]!;

  if (sr.status !== 'resolved') {
    throw ApiError.conflict(`Cannot verify: status is '${sr.status}', must be 'resolved'`);
  }

  // Councillor cannot verify own case
  if (principal.role === 'ward_councillor') {
    const mRes = await query<{ id: string }>(`SELECT id FROM members WHERE created_by = $1 LIMIT 1`, [principal.sub]);
    const verifierMemberId = mRes.rows[0]?.id;
    if (verifierMemberId && sr.councillorMemberId === verifierMemberId) {
      throw ApiError.conflict('Councillor cannot verify their own case');
    }
  }

  const res = await query<Verification>(
    `INSERT INTO verifications (service_request_id, member_id, verdict, note, photo_id)
     SELECT $1,
            (SELECT id FROM members WHERE created_by = $5 LIMIT 1),
            $2, $3, $4
     RETURNING id, service_request_id AS "serviceRequestId",
            member_id AS "memberId", verdict, note, photo_id AS "photoId",
            created_at AS "createdAt"`,
    [input.serviceRequestId, input.verdict, input.note ?? null, input.photoId ?? null, principal.sub],
  );

  if (res.rowCount === 0) throw new Error('Failed to create verification');
  const verification = res.rows[0]!;

  // If verdict is 'fixed', update SR status
  if (input.verdict === 'fixed') {
    await query(
      `UPDATE service_requests SET verified_at = now(), status = 'verified', updated_at = now()
       WHERE id = $1 AND verified_at IS NULL`,
      [input.serviceRequestId],
    );
  }

  await recordAudit({
    action: 'verification.create',
    actorId: principal.sub,
    actorRole: principal.role,
    targetType: 'verifications',
    targetId: verification.id,
    metadata: { serviceRequestId: input.serviceRequestId, verdict: input.verdict },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return verification;
}

export async function listVerifications(filters: {
  serviceRequestId?: string;
  limit: number;
  offset: number;
}): Promise<{ items: Verification[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filters.serviceRequestId) { conditions.push(`service_request_id = $${idx++}`); values.push(filters.serviceRequestId); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [itemsRes, countRes] = await Promise.all([
    query<Verification>(
      `SELECT id, service_request_id AS "serviceRequestId", member_id AS "memberId",
              verdict, note, photo_id AS "photoId", created_at AS "createdAt"
       FROM verifications ${where}
       ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...values, filters.limit, filters.offset],
    ),
    query<{ total: string }>(`SELECT COUNT(*) AS total FROM verifications ${where}`, values),
  ]);

  return { items: itemsRes.rows, total: parseInt(countRes.rows[0]?.total ?? '0', 10) };
}
