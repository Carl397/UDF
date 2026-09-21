import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { ApiError } from '../../http/errors.js';
import { Permission } from '../../auth/permissions.js';
import { uploadMedia } from '../transparency/service.js';
import { recordAudit } from '../../security/audit.js';

/**
 * /api/crm/candidates — the "Meet our ward councillors" roster.
 *
 * Managed by whoever owns website content (CONTENT_MANAGE), because the list is
 * published to the public marketing site rather than being a territory-scoped
 * operational record — so, unlike events, it carries no ward/region scope.
 * The public read lives in ./publicRoutes.ts.
 */
export const candidatesCrmRouter = Router();

const writeSchema = z.object({
  fullName: z.string().trim().min(1).max(160),
  roleLabel: z.string().trim().max(120).optional(),
  wardsLabel: z.string().trim().max(160).optional(),
  bio: z.string().trim().max(2000).optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  isActive: z.boolean().optional(),
});
const updateSchema = writeSchema.partial();

interface Row {
  id: string;
  full_name: string;
  role_label: string;
  wards_label: string;
  bio: string;
  photo_media_id: string | null;
  sort_order: number;
  is_active: boolean;
}

const SELECT = `SELECT id, full_name, role_label, wards_label, bio, photo_media_id,
       sort_order, is_active FROM ward_candidates`;

const toView = (r: Row) => ({
  id: r.id,
  fullName: r.full_name,
  roleLabel: r.role_label,
  wardsLabel: r.wards_label,
  bio: r.bio,
  hasPhoto: Boolean(r.photo_media_id),
  sortOrder: r.sort_order,
  isActive: r.is_active,
});

candidatesCrmRouter.use(authenticate, requirePermission(Permission.CONTENT_MANAGE));

candidatesCrmRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const r = await query<Row>(`${SELECT} ORDER BY sort_order ASC, full_name ASC`);
    res.json({ items: r.rows.map(toView), total: r.rows.length });
  }),
);

candidatesCrmRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const i = writeSchema.parse(req.body);
    const r = await query<Row>(
      `INSERT INTO ward_candidates (full_name, role_label, wards_label, bio, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, full_name, role_label, wards_label, bio, photo_media_id, sort_order, is_active`,
      [
        i.fullName,
        i.roleLabel ?? '',
        i.wardsLabel ?? '',
        i.bio ?? '',
        i.sortOrder ?? 0,
        i.isActive ?? true,
      ],
    );
    await recordAudit({
      action: 'candidate.create',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'candidate',
      targetId: r.rows[0]!.id,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { fullName: i.fullName },
    });
    res.status(201).json(toView(r.rows[0]!));
  }),
);

candidatesCrmRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const i = updateSchema.parse(req.body);
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (i.fullName !== undefined) add('full_name', i.fullName);
    if (i.roleLabel !== undefined) add('role_label', i.roleLabel);
    if (i.wardsLabel !== undefined) add('wards_label', i.wardsLabel);
    if (i.bio !== undefined) add('bio', i.bio);
    if (i.sortOrder !== undefined) add('sort_order', i.sortOrder);
    if (i.isActive !== undefined) add('is_active', i.isActive);
    if (!sets.length) throw ApiError.badRequest('No fields to update');
    params.push(req.params.id);
    const r = await query<Row>(
      `UPDATE ward_candidates SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length}
        RETURNING id, full_name, role_label, wards_label, bio, photo_media_id, sort_order, is_active`,
      params,
    );
    if (!r.rows[0]) throw ApiError.notFound('Candidate not found');
    await recordAudit({
      action: 'candidate.update',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'candidate',
      targetId: req.params.id,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { fields: Object.keys(i) },
    });
    res.json(toView(r.rows[0]));
  }),
);

candidatesCrmRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const r = await query('DELETE FROM ward_candidates WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows[0]) throw ApiError.notFound('Candidate not found');
    await recordAudit({
      action: 'candidate.delete',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'candidate',
      targetId: req.params.id,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.status(204).end();
  }),
);

/**
 * CRM photo bytes for any candidate, active or not. The public endpoint hides
 * inactive rows, so the editor previews through this authenticated path instead
 * — a photo stays visible while a candidate is toggled off the public site.
 */
candidatesCrmRouter.get(
  '/:id/photo',
  asyncHandler(async (req, res) => {
    const r = await query<{ photo_media_id: string | null }>(
      'SELECT photo_media_id FROM ward_candidates WHERE id = $1',
      [req.params.id],
    );
    if (!r.rows[0]) throw ApiError.notFound('Candidate not found');
    if (!r.rows[0].photo_media_id) throw ApiError.notFound('Candidate has no photo');
    const asset = await query<{ storage_key: string; content_type: string }>(
      'SELECT storage_key, content_type FROM media_assets WHERE id = $1',
      [r.rows[0].photo_media_id],
    );
    if (!asset.rows[0]) throw ApiError.notFound('Photo not found');
    const buffer = await readFile(join(process.cwd(), asset.rows[0].storage_key));
    res.setHeader('Content-Type', asset.rows[0].content_type);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  }),
);

/** Set/replace a candidate's photo through the shared media pipeline. */
const photoSchema = z.object({ dataUrl: z.string().min(16).max(8 * 1024 * 1024) });
candidatesCrmRouter.post(
  '/:id/photo',
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const exists = await query<{ id: string }>('SELECT id FROM ward_candidates WHERE id = $1', [
      req.params.id,
    ]);
    if (!exists.rows[0]) throw ApiError.notFound('Candidate not found');
    const { dataUrl } = photoSchema.parse(req.body);
    const stored = await uploadMedia({ dataUrl, captureMode: 'photo' }, p, undefined, 'profile');
    await query('UPDATE ward_candidates SET photo_media_id = $2, updated_at = now() WHERE id = $1', [
      req.params.id,
      stored.id,
    ]);
    await recordAudit({
      action: 'candidate.photo.update',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'candidate',
      targetId: req.params.id,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { mediaId: stored.id },
    });
    res.json({ ok: true, hasPhoto: true });
  }),
);

candidatesCrmRouter.delete(
  '/:id/photo',
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const r = await query<{ id: string }>(
      'UPDATE ward_candidates SET photo_media_id = NULL, updated_at = now() WHERE id = $1 RETURNING id',
      [req.params.id],
    );
    if (!r.rows[0]) throw ApiError.notFound('Candidate not found');
    await recordAudit({
      action: 'candidate.photo.delete',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'candidate',
      targetId: req.params.id,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json({ ok: true, hasPhoto: false });
  }),
);
