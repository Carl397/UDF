import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, requireRegionInScope } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { ApiError } from '../../http/errors.js';
import { Permission, isNationalScope, type Principal } from '../../auth/permissions.js';
import { principalSeesMember, principalSeesPlace } from '../../auth/scope.js';
import { recordAudit } from '../../security/audit.js';
import { notify } from '../notifications/service.js';
import { issueToken, publicUrl } from '../memberships/service.js';

/**
 * /api/appointments — party appointments & mandates.
 *
 * An appointment binds a member to a position from the catalog (ward chair,
 * ward candidate, mobilizer…). Confirming an appointment issues a *mandate
 * link*; when the member opens it, the mandate is recorded as accepted.
 * The position catalog (/api/positions) is public — it documents the roles
 * available to each kind of member.
 */
export const appointmentsRouter = Router();

const listQuery = z.object({
  memberId: z.string().uuid().optional(),
  regionCode: z.string().max(32).optional(),
  ward: z.string().max(64).optional(),
  status: z.enum(['proposed', 'confirmed', 'revoked']).optional(),
  positionCode: z.string().max(48).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createSchema = z.object({
  memberId: z.string().uuid(),
  positionCode: z.string().min(1).max(48),
  title: z.string().max(160).optional(),
  regionCode: z.string().max(32).optional(),
  ward: z.string().max(64).optional(),
  appointedBy: z.string().max(160).optional(),
  termStart: z.coerce.date().optional(),
  termEnd: z.coerce.date().optional(),
  status: z.enum(['proposed', 'confirmed']).default('proposed'),
  notes: z.string().max(2000).optional(),
});
const updateSchema = createSchema
  .omit({ memberId: true })
  .partial()
  .extend({ status: z.enum(['proposed', 'confirmed', 'revoked']).optional() });

interface Row {
  id: string;
  member_id: string;
  position_code: string | null;
  position_name: string | null;
  position_level: string | null;
  title: string | null;
  region_code: string | null;
  ward: string | null;
  appointed_by: string | null;
  term_start: string | null;
  term_end: string | null;
  status: string;
  mandate_accepted_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  membership_no: string | null;
  member_tier: string | null;
  public_code: string | null;
}

const COLS = `a.id, a.member_id, a.position_code, p.name AS position_name,
       p.level AS position_level, a.title, a.region_code, a.ward, a.appointed_by,
       a.term_start, a.term_end, a.status, a.mandate_accepted_at, a.notes,
       a.created_at, a.updated_at,
       m.membership_no, m.tier AS member_tier, m.public_code`;

const FROM = `FROM appointments a
  LEFT JOIN positions p ON p.code = a.position_code
  LEFT JOIN members m ON m.id = a.member_id`;

const toView = (r: Row) => ({
  id: r.id,
  memberId: r.member_id,
  positionCode: r.position_code,
  positionName: r.position_name,
  positionLevel: r.position_level,
  title: r.title,
  regionCode: r.region_code,
  ward: r.ward,
  appointedBy: r.appointed_by,
  termStart: r.term_start,
  termEnd: r.term_end,
  status: r.status,
  mandateAcceptedAt: r.mandate_accepted_at,
  notes: r.notes,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  member: {
    membershipNo: r.membership_no,
    tier: r.member_tier,
    publicCode: r.public_code,
  },
  verifyUrl: r.public_code ? publicUrl(`/v/${r.public_code}`) : null,
});

async function load(id: string): Promise<Row> {
  const r = await query<Row>(`SELECT ${COLS} ${FROM} WHERE a.id = $1`, [id]);
  if (!r.rows[0]) throw ApiError.notFound('Appointment not found');
  return r.rows[0]!;
}

async function assertScope(
  p: Principal,
  place: { region_code?: string | null; regionCode?: string | null; ward?: string | null },
): Promise<void> {
  const regionCode = place.regionCode ?? place.region_code ?? null;
  if (!regionCode && !place.ward) return;
  if (!(await principalSeesPlace(p, { regionCode, ward: place.ward ?? null }))) {
    throw ApiError.forbidden('Appointment outside your authorized scope');
  }
}

// Position catalog — public ("various roles for various types" of member).
// Served at GET /api/appointments/positions.
appointmentsRouter.get(
  '/positions',
  asyncHandler(async (_req, res) => {
    const r = await query<{
      code: string;
      name: string;
      level: string;
      tier: string;
      description: string | null;
      term_months: number | null;
    }>('SELECT code, name, level, tier, description, term_months FROM positions ORDER BY level, name');
    res.json({
      items: r.rows.map((p) => ({
        code: p.code,
        name: p.name,
        level: p.level,
        tier: p.tier,
        description: p.description,
        termMonths: p.term_months,
      })),
    });
  }),
);

// ── Authenticated ────────────────────────────────────────────────
appointmentsRouter.use(authenticate);

appointmentsRouter.get(
  '/',
  requirePermission(Permission.MEMBER_READ),
  requireRegionInScope((req) => (req.query.regionCode as string) || undefined),
  asyncHandler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const p = req.principal!;
    const where: string[] = ['m.deleted_at IS NULL'];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };

    if (q.memberId) add('a.member_id = ?', q.memberId);
    if (q.status) add('a.status = ?', q.status);
    if (q.positionCode) add('a.position_code = ?', q.positionCode);
    if (q.ward) {
      if (p.wardCode && q.ward !== p.wardCode) {
        throw ApiError.forbidden('Ward outside your authorized scope');
      }
      add('a.ward = ?', q.ward);
    }
    if (q.regionCode) {
      add('a.region_code = ?', q.regionCode);
    } else if (p.wardCode) {
      // A ward-scoped official sees only appointments IN their ward. Filtering
      // on `a.region_code` here — as this did before — matched on the
      // subcouncil, so a single ward's councillor received every appointment in
      // all of the subcouncil's wards, including the membership numbers and
      // public codes of officials they do not work with.
      add('a.ward = ?', p.wardCode);
    } else if (!isNationalScope(p)) {
      // Region-scoped principals only ever see their own regions.
      params.push(p.regionCodes ?? []);
      where.push(`(a.region_code = ANY($${params.length}) OR a.region_code IS NULL)`);
    }

    const filterCount = params.length;
    params.push(q.limit, q.offset);

    const rows = await query<Row>(
      `SELECT ${COLS} ${FROM}
        WHERE ${where.join(' AND ')}
        ORDER BY a.created_at DESC
        LIMIT $${filterCount + 1} OFFSET $${filterCount + 2}`,
      params,
    );
    const countRes = await query<{ c: string }>(
      `SELECT count(*)::text AS c ${FROM} WHERE ${where.join(' AND ')}`,
      params.slice(0, filterCount),
    );

    res.json({
      items: rows.rows.map(toView),
      total: Number(countRes.rows[0]?.c ?? 0),
      limit: q.limit,
      offset: q.offset,
    });
  }),
);

appointmentsRouter.get(
  '/:id',
  requirePermission(Permission.MEMBER_READ),
  asyncHandler(async (req, res) => {
    const row = await load(req.params.id!);
    await assertScope(req.principal!, row);
    res.json(toView(row));
  }),
);

appointmentsRouter.post(
  '/',
  requirePermission(Permission.APPOINT_WRITE),
  requireRegionInScope((req) => (req.body as any)?.regionCode),
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    const p = req.principal!;

    const member = await query<{ id: string; region_code: string | null; ward: string | null }>(
      'SELECT id, region_code, ward FROM members WHERE id = $1 AND deleted_at IS NULL',
      [input.memberId],
    );
    if (!member.rows[0]) throw ApiError.notFound('Member not found');
    // Both the appointee and the place being appointed TO must sit inside the
    // appointer's territory. Previously only the region was checked, and only
    // when it was non-null, so a member with no recorded region could be
    // appointed by anyone holding `appoint:write`.
    if (
      !(await principalSeesMember(p, {
        regionCode: member.rows[0]!.region_code,
        ward: member.rows[0]!.ward,
      }))
    ) {
      throw ApiError.forbidden('Member outside your authorized scope');
    }
    const regionCode = input.regionCode ?? member.rows[0]!.region_code ?? undefined;
    const ward = input.ward ?? member.rows[0]!.ward ?? null;
    await assertScope(p, { regionCode: regionCode ?? null, ward });

    const position = await query<{ code: string; name: string }>(
      'SELECT code, name FROM positions WHERE code = $1',
      [input.positionCode],
    );
    if (!position.rows[0]) throw ApiError.badRequest('Unknown position code');

    const r = await query<Row>(
      `INSERT INTO appointments
         (member_id, position_code, title, region_code, ward, appointed_by,
          term_start, term_end, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        input.memberId,
        input.positionCode,
        input.title ?? null,
        regionCode ?? null,
        ward,
        input.appointedBy ?? 'Party Executive',
        input.termStart ? input.termStart.toISOString().slice(0, 10) : null,
        input.termEnd ? input.termEnd.toISOString().slice(0, 10) : null,
        input.status,
        input.notes ?? null,
        p.sub,
      ],
    );
    // RETURNING cannot use joined aliases — refetch through the shared loader.
    const appointment = toView(await load(r.rows[0]!.id));

    const mandate = await issueToken({
      memberId: input.memberId,
      appointmentId: appointment.id,
      kind: 'mandate',
      ttlDays: 30,
    });

    await recordAudit({
      action: 'appointment.create',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'appointment',
      targetId: appointment.id,
      regionCode: appointment.regionCode,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: {
        position: input.positionCode,
        status: input.status,
        memberId: input.memberId,
      },
    });

    await notify({
      kind: 'appointment',
      title: `Appointment: ${position.rows[0]!.name}`,
      body: `${appointment.ward ? `Ward ${appointment.ward}` : appointment.regionCode ?? 'National'} — mandate link issued`,
      link: `tab:engage#appointments:${appointment.id}`,
      regionCode: appointment.regionCode,
      audience: 'staff',
    });

    res.status(201).json({ ...appointment, mandateUrl: mandate.confirmUrl });
  }),
);

// Re-issue the mandate confirmation link (e.g. it expired or was lost).
appointmentsRouter.post(
  '/:id/mandate-link',
  requirePermission(Permission.APPOINT_WRITE),
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const row = await load(req.params.id!);
    await assertScope(p, row);

    const mandate = await issueToken({
      memberId: row.member_id,
      appointmentId: row.id,
      kind: 'mandate',
      ttlDays: 30,
    });
    await recordAudit({
      action: 'mandate.link_issue',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'appointment',
      targetId: row.id,
      regionCode: row.region_code,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json({ mandateUrl: mandate.confirmUrl, expiresAt: mandate.expiresAt });
  }),
);

appointmentsRouter.patch(
  '/:id',
  requirePermission(Permission.APPOINT_WRITE),
  asyncHandler(async (req, res) => {
    const input = updateSchema.parse(req.body);
    const p = req.principal!;
    const before = await load(req.params.id!);
    await assertScope(p, before);
    // Re-targeting the appointment is a write into the new place as well.
    if (input.regionCode !== undefined || input.ward !== undefined) {
      await assertScope(p, {
        regionCode: input.regionCode !== undefined ? input.regionCode : before.region_code,
        ward: input.ward !== undefined ? input.ward : before.ward,
      });
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (input.positionCode !== undefined) add('position_code', input.positionCode);
    if (input.title !== undefined) add('title', input.title ?? null);
    if (input.regionCode !== undefined) add('region_code', input.regionCode ?? null);
    if (input.ward !== undefined) add('ward', input.ward ?? null);
    if (input.appointedBy !== undefined) add('appointed_by', input.appointedBy ?? null);
    if (input.termStart !== undefined) add('term_start', input.termStart.toISOString().slice(0, 10));
    if (input.termEnd !== undefined) add('term_end', input.termEnd.toISOString().slice(0, 10));
    if (input.notes !== undefined) add('notes', input.notes ?? null);
    if (input.status !== undefined) {
      add('status', input.status);
      if (input.status === 'confirmed') sets.push('mandate_accepted_at = COALESCE(mandate_accepted_at, now())');
      if (input.status === 'revoked') sets.push('mandate_accepted_at = NULL');
    }
    if (!sets.length) throw ApiError.badRequest('No fields to update');

    params.push(req.params.id);
    await query(`UPDATE appointments SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const appointment = toView(await load(req.params.id!));

    await recordAudit({
      action: 'appointment.update',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'appointment',
      targetId: appointment.id,
      regionCode: appointment.regionCode,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { fields: Object.keys(input), status: appointment.status },
    });

    if (input.status && input.status !== before.status) {
      await notify({
        kind: 'appointment',
        title:
          input.status === 'revoked'
            ? `Appointment revoked: ${appointment.positionName ?? ''}`
            : `Appointment ${input.status}: ${appointment.positionName ?? ''}`,
        body: appointment.ward ? `Ward ${appointment.ward}` : appointment.regionCode ?? undefined,
        link: `tab:engage#appointments:${appointment.id}`,
        regionCode: appointment.regionCode,
        audience: 'staff',
      });
    }

    res.json(appointment);
  }),
);

appointmentsRouter.delete(
  '/:id',
  requirePermission(Permission.APPOINT_WRITE),
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const before = await load(req.params.id!);
    await assertScope(p, before);

    await query('DELETE FROM appointments WHERE id = $1', [req.params.id]);
    await recordAudit({
      action: 'appointment.delete',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'appointment',
      targetId: req.params.id,
      regionCode: before.region_code,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { position: before.position_code },
    });
    res.status(204).end();
  }),
);
