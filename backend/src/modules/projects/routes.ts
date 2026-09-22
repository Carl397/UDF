import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { authenticate } from '../../middleware/authenticate.js';
import { Permission } from '../../auth/permissions.js';
import { createProjectSchema, createMilestoneSchema, listProjectsQuery } from './schemas.js';
import * as svc from './service.js';

export const projectsRouter = Router();

projectsRouter.use(authenticate);

projectsRouter.get(
  '/',
  requirePermission(Permission.CASE_READ),
  async (req, res, next) => {
    try {
      const parsed = listProjectsQuery.safeParse(req.query);
      if (!parsed.success) throw parsed.error;
      const result = await svc.listProjects(req.principal!, parsed.data);
      res.json(result);
    } catch (err) { next(err); }
  },
);

projectsRouter.get(
  '/:id',
  requirePermission(Permission.CASE_READ),
  async (req, res, next) => {
    try {
      // `getProject` gates on publication + territory and returns null when the
      // caller may not read it, so the 404 below covers both "does not exist" and
      // "not yours" — see D43 in service.ts. Milestones are fetched only after
      // that gate, never before it.
      const project = await svc.getProject(req.params.id!, req.principal!);
      if (!project) return res.status(404).json({ error: 'Not found' });
      const milestones = await svc.getProjectMilestones(req.params.id!);
      res.json({ ...project, milestones });
    } catch (err) { next(err); }
  },
);

projectsRouter.post(
  '/',
  requirePermission(Permission.ENGAGEMENT_WRITE),
  async (req, res, next) => {
    try {
      const parsed = createProjectSchema.safeParse(req.body);
      if (!parsed.success) throw parsed.error;
      const project = await svc.createProject(parsed.data, req.principal!, {
        ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
      });
      res.status(201).json(project);
    } catch (err) { next(err); }
  },
);

projectsRouter.post(
  '/:id/milestones',
  requirePermission(Permission.ENGAGEMENT_WRITE),
  async (req, res, next) => {
    try {
      const parsed = createMilestoneSchema.safeParse(req.body);
      if (!parsed.success) throw parsed.error;
      const milestone = await svc.addMilestone(req.params.id!, parsed.data);
      res.status(201).json(milestone);
    } catch (err) { next(err); }
  },
);
