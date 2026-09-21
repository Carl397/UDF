import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { authenticate, optionalAuthenticate } from '../../middleware/authenticate.js';
import { Permission } from '../../auth/permissions.js';
import { principalSeesWard } from '../../auth/scope.js';
import { query } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { uploadMedia } from '../transparency/service.js';
import { recordAudit } from '../../security/audit.js';
import { createBulletinSchema, updateBulletinSchema, listBulletinsQuery } from './schemas.js';
import * as svc from './service.js';

export const wardBulletinsRouter = Router();

const coverSchema = z.object({ dataUrl: z.string().min(16).max(8 * 1024 * 1024) });

/**
 * SERVE a bulletin's cover bytes, registered BEFORE the router-wide
 * `authenticate` so a published bulletin's cover loads in a plain `<img>`.
 * A draft is only readable by a `bulletin:read` holder inside its ward (the
 * same gate `getVisibleBulletin` applies), so a cover never leaks a draft.
 */
wardBulletinsRouter.get(
  '/:id/cover',
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const r = await query<{ cover_media_id: string | null; ward_code: string; status: string }>(
      'SELECT cover_media_id, ward_code, status FROM ward_bulletins WHERE id = $1',
      [req.params.id],
    );
    const row = r.rows[0];
    if (!row || !row.cover_media_id) throw ApiError.notFound('Cover image not found');
    if (row.status !== 'published') {
      const p = req.principal;
      const allowed =
        !!p &&
        (p.permissions?.includes(Permission.BULLETIN_READ) ?? false) &&
        (await principalSeesWard(p, row.ward_code));
      if (!allowed) throw ApiError.notFound('Cover image not found');
    }
    const asset = await query<{ storage_key: string; content_type: string }>(
      'SELECT storage_key, content_type FROM media_assets WHERE id = $1',
      [row.cover_media_id],
    );
    const file = asset.rows[0];
    if (!file) throw ApiError.notFound('Cover image not found');
    const buffer = await readFile(join(process.cwd(), file.storage_key));
    res.setHeader('Content-Type', file.content_type);
    res.setHeader('Cache-Control', row.status === 'published' ? 'public, max-age=3600' : 'private, max-age=300');
    res.send(buffer);
  }),
);

wardBulletinsRouter.use(authenticate);

wardBulletinsRouter.get(
  '/',
  requirePermission(Permission.BULLETIN_READ),
  async (req, res, next) => {
    try {
      const parsed = listBulletinsQuery.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      }
      const result = await svc.listBulletins(req.principal!, parsed.data);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

wardBulletinsRouter.get(
  '/:id',
  requirePermission(Permission.BULLETIN_READ),
  async (req, res, next) => {
    try {
      // Scope-aware: `getBulletin` alone would hand any `bulletin:read` holder —
      // a member included — any ward's drafts by id.
      const bulletin = await svc.getVisibleBulletin(req.params.id!, req.principal!);
      res.json(bulletin);
    } catch (err) {
      next(err);
    }
  },
);

wardBulletinsRouter.post(
  '/',
  requirePermission(Permission.BULLETIN_WRITE),
  async (req, res, next) => {
    try {
      const parsed = createBulletinSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const bulletin = await svc.createBulletin(parsed.data, req.principal!, {
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });
      res.status(201).json(bulletin);
    } catch (err) {
      next(err);
    }
  },
);

wardBulletinsRouter.patch(
  '/:id',
  requirePermission(Permission.BULLETIN_WRITE),
  async (req, res, next) => {
    try {
      const parsed = updateBulletinSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const bulletin = await svc.updateBulletin(req.params.id!, parsed.data, req.principal!, {
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });
      res.json(bulletin);
    } catch (err) {
      next(err);
    }
  },
);

// ── Cover image (bulletin author only; ward-scoped) ─────────────────────────
wardBulletinsRouter.post(
  '/:id/cover',
  requirePermission(Permission.BULLETIN_WRITE),
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const existing = await svc.getBulletin(req.params.id!);
    if (!existing) throw ApiError.notFound('Bulletin not found');
    if (!(await principalSeesWard(p, existing.wardCode))) {
      throw ApiError.forbidden('Bulletin belongs to another ward');
    }
    const { dataUrl } = coverSchema.parse(req.body);
    const stored = await uploadMedia({ dataUrl, captureMode: 'photo' }, p);
    await query('UPDATE ward_bulletins SET cover_media_id = $2, updated_at = now() WHERE id = $1', [
      req.params.id,
      stored.id,
    ]);
    await recordAudit({
      action: 'bulletin.cover.update',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'ward_bulletins',
      targetId: req.params.id,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: { mediaId: stored.id },
    });
    res.json({ ok: true, hasCover: true });
  }),
);

wardBulletinsRouter.delete(
  '/:id/cover',
  requirePermission(Permission.BULLETIN_WRITE),
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const existing = await svc.getBulletin(req.params.id!);
    if (!existing) throw ApiError.notFound('Bulletin not found');
    if (!(await principalSeesWard(p, existing.wardCode))) {
      throw ApiError.forbidden('Bulletin belongs to another ward');
    }
    await query('UPDATE ward_bulletins SET cover_media_id = NULL, updated_at = now() WHERE id = $1', [
      req.params.id,
    ]);
    res.json({ ok: true, hasCover: false });
  }),
);
