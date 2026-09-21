import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../../http/asyncHandler.js';
import { optionalAuthenticate } from '../../middleware/authenticate.js';
import { env } from '../../config/env.js';
import { collectSchema } from './schemas.js';
import * as analytics from './service.js';

/**
 * /api/public analytics ingest + counted APK download.
 *
 * These live under the public namespace (already CORS-permitted for anonymous
 * website + app visitors). Collection is cookieless: the beacon carries no
 * identifier, and the server derives only a per-day visitor hash. The download
 * route records one row per hit, then redirects to the real file — this is the
 * ONLY trustworthy download counter (nginx access logs for the app vhost are
 * off), and it never returns the file itself so the payload stays cacheable at
 * the edge.
 */
export const analyticsPublicRouter = Router();

/** Beacons are high-volume and anonymous: give them their own generous budget. */
const collectLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // A beacon must never surface an error to the visitor; swallow over-limit.
  skipFailedRequests: true,
  message: { error: { code: 'too_many_requests', message: 'slow down' } },
});

analyticsPublicRouter.post(
  '/collect',
  collectLimiter,
  optionalAuthenticate,
  asyncHandler(async (req: Request, res) => {
    const input = collectSchema.parse(req.body ?? {});
    // A beacon for the app/crm sites is attributable when an access token is
    // offered; marketing stays fully anonymous.
    const userId =
      input.site !== 'marketing' ? (req.principal?.sub ?? null) : null;
    await analytics.collectEvent(input, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      userId,
    });
    // 204 so the beacon's keepalive/sendBeacon call sees a clean success.
    res.status(204).end();
  }),
);

// Where the real artifact is served from once placed on disk (see RUNBOOK).
const APK_TARGET = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/downloads/udf.apk`;

/**
 * GET /public/download/apk — log the download (device/os/browser/referrer) then
 * 302 to the actual APK. `?v=` lets the caller tag the app version for the
 * per-version breakdown without a second lookup.
 */
analyticsPublicRouter.get(
  '/download/apk',
  asyncHandler(async (req: Request, res) => {
    const version =
      typeof req.query.v === 'string' ? req.query.v.slice(0, 32) : null;
    await analytics.recordDownload('apk', {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      referrer: req.get('referer') ?? null,
      version,
    });
    res.redirect(302, APK_TARGET);
  }),
);
