import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { authenticate } from '../../middleware/authenticate.js';
import { Permission } from '../../auth/permissions.js';
import { createPatrolSchema, addTrackPointSchema, addPatrolStopSchema, endPatrolSchema, listPatrolsQuery, updatePatrolStopSchema, updatePatrolSchema } from './schemas.js';
import * as svc from './service.js';
import { getDashboardActivity } from '../crm/activityStats.js';

export const patrolsRouter = Router();

patrolsRouter.use(authenticate);

patrolsRouter.get(
  '/',
  requirePermission(Permission.PATROL_READ),
  async (req, res, next) => {
    try {
      const parsed = listPatrolsQuery.safeParse(req.query);
      if (!parsed.success) throw parsed.error;
      const result = await svc.listPatrols(req.principal!, parsed.data);
      res.json(result);
    } catch (err) { next(err); }
  },
);

patrolsRouter.get(
  '/heatmap',
  requirePermission(Permission.OVERVIEW_READ),
  async (req, res, next) => {
    try {
      const wardCode = typeof req.query.wardCode === 'string' ? req.query.wardCode : undefined;
      const data = await svc.getHeatmapData(req.principal!, wardCode);
      res.json({ points: data });
    } catch (err) { next(err); }
  },
);

patrolsRouter.get(
  '/stats',
  requirePermission(Permission.PATROL_READ),
  async (req, res, next) => {
    try {
      const activity = await getDashboardActivity(req.principal!, 'patrols');
      res.json(activity.modules.patrols);
    } catch (err) { next(err); }
  },
);

patrolsRouter.get(
  '/:id',
  requirePermission(Permission.PATROL_READ),
  async (req, res, next) => {
    try {
      const patrol = await svc.getPatrol(req.params.id!, req.principal!);
      if (!patrol) return res.status(404).json({ error: 'Not found' });
      res.json(patrol);
    } catch (err) { next(err); }
  },
);

patrolsRouter.post(
  '/',
  requirePermission(Permission.PATROL_WRITE),
  async (req, res, next) => {
    try {
      const parsed = createPatrolSchema.safeParse(req.body);
      if (!parsed.success) throw parsed.error;
      const patrol = await svc.createPatrol(parsed.data, req.principal!, {
        ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
      });
      res.status(201).json(patrol);
    } catch (err) { next(err); }
  },
);

patrolsRouter.patch(
  '/:id',
  requirePermission(Permission.PATROL_WRITE),
  async (req, res, next) => {
    try {
      const parsed = updatePatrolSchema.safeParse(req.body);
      if (!parsed.success) throw parsed.error;
      const patrol = await svc.updatePatrol(req.params.id!, parsed.data, req.principal!, {
        ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
      });
      res.json(patrol);
    } catch (err) { next(err); }
  },
);

patrolsRouter.delete(
  '/:id',
  requirePermission(Permission.PATROL_WRITE),
  async (req, res, next) => {
    try {
      await svc.deletePatrol(req.params.id!, req.principal!, {
        ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
      });
      res.status(204).end();
    } catch (err) { next(err); }
  },
);

patrolsRouter.post(
  '/:id/track-points',
  requirePermission(Permission.PATROL_WRITE),
  async (req, res, next) => {
    try {
      const parsed = addTrackPointSchema.safeParse(req.body);
      if (!parsed.success) throw parsed.error;
      const result = await svc.addTrackPoint(req.params.id!, parsed.data, req.principal!);
      res.status(201).json(result);
    } catch (err) { next(err); }
  },
);

patrolsRouter.post(
  '/:id/stops',
  requirePermission(Permission.PATROL_WRITE),
  async (req, res, next) => {
    try {
      const parsed = addPatrolStopSchema.safeParse(req.body);
      if (!parsed.success) throw parsed.error;
      const result = await svc.addStop(req.params.id!, parsed.data, req.principal!, {
        ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
      });
      res.status(201).json(result);
    } catch (err) { next(err); }
  },
);

patrolsRouter.get(
  '/:id/stops',
  requirePermission(Permission.PATROL_READ),
  async (req, res, next) => {
    try {
      const stops = await svc.listPatrolStops(req.params.id!, req.principal!);
      res.json({ items: stops });
    } catch (err) { next(err); }
  },
);

patrolsRouter.patch(
  '/:id/stops/:stopId',
  requirePermission(Permission.PATROL_WRITE),
  async (req, res, next) => {
    try {
      const parsed = updatePatrolStopSchema.safeParse(req.body);
      if (!parsed.success) throw parsed.error;
      const stop = await svc.updatePatrolStop(req.params.id!, req.params.stopId!, parsed.data, req.principal!, {
        ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
      });
      res.json(stop);
    } catch (err) { next(err); }
  },
);

patrolsRouter.post(
  '/:id/end',
  requirePermission(Permission.PATROL_WRITE),
  async (req, res, next) => {
    try {
      const parsed = endPatrolSchema.safeParse(req.body);
      if (!parsed.success) throw parsed.error;
      const patrol = await svc.endPatrol(req.params.id!, parsed.data, req.principal!, {
        ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
      });
      res.json(patrol);
    } catch (err) { next(err); }
  },
);
