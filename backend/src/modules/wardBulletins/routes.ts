import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { authenticate } from '../../middleware/authenticate.js';
import { Permission } from '../../auth/permissions.js';
import { createBulletinSchema, updateBulletinSchema, listBulletinsQuery } from './schemas.js';
import * as svc from './service.js';

export const wardBulletinsRouter = Router();

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
