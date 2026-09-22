import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { authenticate } from '../../middleware/authenticate.js';
import { Permission } from '../../auth/permissions.js';
import { createVerificationSchema, listVerificationsQuery } from './schemas.js';
import * as svc from './service.js';

export const verificationsRouter = Router();

verificationsRouter.use(authenticate);

verificationsRouter.get(
  '/',
  requirePermission(Permission.CASE_READ),
  async (req, res, next) => {
    try {
      const parsed = listVerificationsQuery.safeParse(req.query);
      if (!parsed.success) throw parsed.error;
      const result = await svc.listVerifications(parsed.data, req.principal!);
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch (err) { next(err); }
  },
);

verificationsRouter.post(
  '/',
  requirePermission(Permission.VERIFY_WRITE),
  async (req, res, next) => {
    try {
      const parsed = createVerificationSchema.safeParse(req.body);
      if (!parsed.success) throw parsed.error;
      const verification = await svc.createVerification(parsed.data, req.principal!, {
        ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
      });
      res.status(201).json(verification);
    } catch (err) { next(err); }
  },
);
