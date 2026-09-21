import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { Permission } from '../../auth/permissions.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { recordDownload } from '../analytics/service.js';
import { OFFICIAL_ORIGIN } from './catalog.js';
import { activeUpdate, listReleases, publishRelease, withdrawRelease, requireReleaseManager, resolveReleaseDownload } from './service.js';

export const appReleasesAdminRouter = Router();
appReleasesAdminRouter.use(authenticate, requirePermission(Permission.APP_RELEASE_MANAGE));
appReleasesAdminRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  try { requireReleaseManager(req.principal!); next(); } catch (err) { next(err); }
});
appReleasesAdminRouter.get('/', asyncHandler(async (req, res) => { res.json(await listReleases(req.principal!)); }));
appReleasesAdminRouter.post('/publish', asyncHandler(async (req, res) => { res.json(await publishRelease(req.principal!, req.body)); }));
appReleasesAdminRouter.post('/withdraw', asyncHandler(async (req, res) => { res.json(await withdrawRelease(req.principal!, req.body)); }));

export const appReleasesPublicRouter = Router();
appReleasesPublicRouter.get('/app-update', asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await activeUpdate());
}));
appReleasesPublicRouter.get('/download/app-release/:id', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const a = await resolveReleaseDownload(req.params.id!);
  await recordDownload('apk', { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
    referrer: req.get('referer') ?? null, version: a.versionName });
  res.redirect(302, OFFICIAL_ORIGIN + a.path);
}));
