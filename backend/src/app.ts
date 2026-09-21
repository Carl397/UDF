import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { requestId, errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { checkDb } from './db/pool.js';
import { authRouter } from './modules/auth/routes.js';
import { membersRouter } from './modules/members/routes.js';
import { geoRouter } from './modules/geo/routes.js';
import { auditRouter } from './modules/audit/routes.js';
import { eventsRouter } from './modules/events/routes.js';
import { postsRouter } from './modules/posts/routes.js';
import { appointmentsRouter } from './modules/appointments/routes.js';
import { notificationsRouter } from './modules/notifications/routes.js';
import { serviceRequestsRouter } from './modules/serviceRequests/routes.js';
import { wardBulletinsRouter } from './modules/wardBulletins/routes.js';
import { attachmentsRouter } from './modules/attachments/routes.js';
import { participationsRouter } from './modules/participations/routes.js';
import { ratingsRouter } from './modules/ratings/routes.js';
import { patrolsRouter } from './modules/patrols/routes.js';
import { verificationsRouter } from './modules/verifications/routes.js';
import { projectsRouter } from './modules/projects/routes.js';
import { petitionsRouter } from './modules/petitions/routes.js';
import { publicRouter } from './modules/public/routes.js';
import { transparencyRouter } from './modules/transparency/routes.js';
import { jobsRouter } from './modules/jobs/routes.js';
import { recruitmentRouter } from './modules/recruitment/routes.js';
import { scorecardsRouter } from './modules/scorecards/routes.js';
import { cardStudioRouter } from './modules/cardstudio/routes.js';
import { crmRouter } from './modules/crm/routes.js';
import { moderationRouter } from './modules/moderation/routes.js';
import { analyticsRouter } from './modules/analytics/routes.js';
import { analyticsPublicRouter } from './modules/analytics/publicRoutes.js';
import { superadminRouter } from './modules/platform/routes.js';
import { appReleasesAdminRouter, appReleasesPublicRouter } from './modules/appReleases/routes.js';
import { contentAdminRouter, contentPublicRouter, contentPublicPagesRouter, contentPublicMediaRouter } from './modules/content/routes.js';
import { candidatesCrmRouter } from './modules/candidates/routes.js';
import { candidatesPublicRouter } from './modules/candidates/publicRoutes.js';

export function createApp(): express.Express {
  const app = express();

  // Behind a reverse proxy/TLS terminator in production.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // ── Layer 1 (in transit) hardening ──────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: env.isProduction ? undefined : false,
      strictTransportSecurity: env.ENABLE_HSTS
        ? { maxAge: 31536000, includeSubDomains: true, preload: true }
        : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id', 'x-device-id'],
    }),
  );

  app.use(compression());
  // Resident reports, staff capture, patrol stops and posts carry base64 media
  // (photo/video/voice) inline in the JSON body. A 256kb cap rejected any
  // report with an attachment as a 413 (surfaced in-app as "internal server
  // error"). Match nginx's client_max_body_size (25m) so media reports fit.
  app.use(express.json({ limit: '25mb' }));
  app.use(requestId);
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' } }));

  // Global baseline rate limit (auth has a stricter one).
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  // ── Routes ──────────────────────────────────────────────────────
  app.get('/healthz', async (_req, res) => {
    const db = await checkDb();
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', db });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/members', membersRouter);
  app.use('/api/geo', geoRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/posts', postsRouter);
  app.use('/api/appointments', appointmentsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/service-requests', serviceRequestsRouter);
  app.use('/api/ward-bulletins', wardBulletinsRouter);
  app.use('/api/attachments', attachmentsRouter);
  app.use('/api/participations', participationsRouter);
  app.use('/api/ratings', ratingsRouter);
  app.use('/api/patrols', patrolsRouter);
  app.use('/api/verifications', verificationsRouter);
  app.use('/api/projects', projectsRouter);
  // Public website + QR party card (register / confirm / verify / manifesto).
  app.use('/api/public', publicRouter);
  // Ward transparency & accountability (geolocation lookup, overview, detail).
  app.use('/api/transparency', transparencyRouter);
  // Ward job-interest register & opportunity relay (PRD-jobs).
  app.use('/api/jobs', jobsRouter);
  // Recruitment genealogy tree, lineage-to-source & national growth report (PRD-growth FR-O).
  app.use('/api/recruitment', recruitmentRouter);
  // Monthly councillor performance scorecards: member ratings, the 100-word reason
  // rule, the acknowledgement lifecycle and the accountability rollups (PRD-growth FR-S).
  app.use('/api/scorecards', scorecardsRouter);
  // Party ID Card Studio: the national-admin card designer (size/layout/colours/
  // text/logo/border/scale), per-member photo + crop/zoom, card media and batch
  // print. Its own namespace so the card surfaces are not caught behind the CRM
  // router's `overview:read` gate that `local_coordinator` does not hold.
  app.use('/api/id-card', cardStudioRouter);
  // Public petitions (view open + member sign) under the public namespace.
  app.use('/api/public/petitions', petitionsRouter);
  // First-party analytics ingest + counted APK download (anonymous, cookieless).
  app.use('/api/public', analyticsPublicRouter);
  app.use('/api/public', appReleasesPublicRouter);
  // Structured website content, published blocks only (anonymous hydration).
  app.use('/api/public/content', contentPublicRouter);
  // Published CMS pages (ordered block sections), for marketing + in-app renderers.
  app.use('/api/public/pages', contentPublicPagesRouter);
  // Images referenced by CMS content (allow-listed to CMS/published media).
  app.use('/api/public/content-media', contentPublicMediaRouter);
  // Public "Meet our ward councillors" feed + photos (anonymous, active only).
  app.use('/api/public/candidates', candidatesPublicRouter);
  // SuperAdmin analytics read APIs (analytics:read).
  app.use('/api/analytics', analyticsRouter);
  // SuperAdmin platform ops surface (server/cron/live + SSE) and the website
  // content editor. Mounted BEFORE the CRM router so its `overview:read`
  // router-level gate never pre-empts the stricter `platform:read`/
  // `content:manage` guards on these paths.
  app.use('/api/crm/superadmin/app-releases', appReleasesAdminRouter);
  app.use('/api/crm/superadmin/content', contentAdminRouter);
  // Ward-candidate roster CRUD + photos (content:manage), mounted before the
  // general CRM router so its own permission guard is authoritative.
  app.use('/api/crm/candidates', candidatesCrmRouter);
  app.use('/api/crm/superadmin', superadminRouter);
  // CRM desktop endpoints (national_admin only).
  app.use('/api/crm', crmRouter);
  // Moderation ladder + device bans (national_admin only).
  app.use('/api/moderation', moderationRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
