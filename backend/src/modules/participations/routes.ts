import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { authenticate } from '../../middleware/authenticate.js';
import { Permission } from '../../auth/permissions.js';
import { createParticipationSchema, createParticipationCommentSchema, listParticipationsQuery } from './schemas.js';
import * as svc from './service.js';

export const participationsRouter = Router();

participationsRouter.use(authenticate);

participationsRouter.get(
  '/',
  requirePermission(Permission.ENGAGEMENT_WRITE),
  async (req, res, next) => {
    try {
      const parsed = listParticipationsQuery.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      }
      const result = await svc.listParticipations(parsed.data);
      res.json(result);
    } catch (err) { next(err); }
  },
);

participationsRouter.get(
  '/:id',
  requirePermission(Permission.ENGAGEMENT_WRITE),
  async (req, res, next) => {
    try {
      const item = await svc.getParticipation(req.params.id!);
      if (!item) return res.status(404).json({ error: 'Not found' });
      res.json(item);
    } catch (err) { next(err); }
  },
);

participationsRouter.post(
  '/',
  requirePermission(Permission.PARTICIPATION_WRITE),
  async (req, res, next) => {
    try {
      const parsed = createParticipationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const item = await svc.createParticipation(parsed.data, req.principal!, {
        ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
      });
      res.status(201).json(item);
    } catch (err) { next(err); }
  },
);

participationsRouter.post(
  '/:id/comments',
  requirePermission(Permission.PARTICIPATION_COMMENT),
  async (req, res, next) => {
    try {
      const parsed = createParticipationCommentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const comment = await svc.addComment(req.params.id!, parsed.data, req.principal!, {
        ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
      });
      res.status(201).json(comment);
    } catch (err) { next(err); }
  },
);
