import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { authenticate } from '../../middleware/authenticate.js';
import { Permission } from '../../auth/permissions.js';
import { createRatingSchema, listRatingsQuery } from './schemas.js';
import * as svc from './service.js';

export const ratingsRouter = Router();

ratingsRouter.use(authenticate);

ratingsRouter.get(
  '/',
  requirePermission(Permission.OVERVIEW_READ),
  async (req, res, next) => {
    try {
      const parsed = listRatingsQuery.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      }
      const result = await svc.listRatings(parsed.data);
      res.json(result);
    } catch (err) { next(err); }
  },
);

ratingsRouter.post(
  '/',
  requirePermission(Permission.RATING_WRITE),
  async (req, res, next) => {
    try {
      const parsed = createRatingSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const rating = await svc.createRating(parsed.data, req.principal!, {
        ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
      });
      res.status(201).json(rating);
    } catch (err) { next(err); }
  },
);

ratingsRouter.get(
  '/average/:targetType/:targetId',
  requirePermission(Permission.OVERVIEW_READ),
  async (req, res, next) => {
    try {
      const result = await svc.getAverageRating(req.params.targetType!, req.params.targetId!);
      res.json(result);
    } catch (err) { next(err); }
  },
);
