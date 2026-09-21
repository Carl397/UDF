import { Router } from 'express';
import { asyncHandler } from '../../http/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { Permission } from '../../auth/permissions.js';
import { windowQuerySchema } from './schemas.js';
import * as analytics from './service.js';

/**
 * /api/analytics — SuperAdmin analytics read APIs.
 *
 * Every route is gated on `analytics:read` (held only by the `superadmin`
 * role, and stripped when the `superadmin` module is disabled). Nothing here
 * is scoped by region/ward: analytics is aggregate, cookieless and carries no
 * member PII, so it is a platform-wide view by design.
 */
export const analyticsRouter = Router();

analyticsRouter.use(authenticate, requirePermission(Permission.ANALYTICS_READ));

analyticsRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const q = windowQuerySchema.parse(req.query);
    res.json(await analytics.getOverview(q.days, { site: q.site }));
  }),
);

analyticsRouter.get(
  '/traffic',
  asyncHandler(async (req, res) => {
    const q = windowQuerySchema.parse(req.query);
    res.json(await analytics.getTraffic(q.days, { site: q.site }));
  }),
);

analyticsRouter.get(
  '/devices',
  asyncHandler(async (req, res) => {
    const q = windowQuerySchema.parse(req.query);
    res.json(await analytics.getDevices(q.days, { site: q.site }));
  }),
);

analyticsRouter.get(
  '/realtime',
  asyncHandler(async (_req, res) => {
    res.json(await analytics.getRealtime());
  }),
);

analyticsRouter.get(
  '/downloads',
  asyncHandler(async (req, res) => {
    const q = windowQuerySchema.parse(req.query);
    res.json(await analytics.getDownloads(q.days));
  }),
);
