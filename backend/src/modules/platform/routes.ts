import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../http/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { logger } from '../../config/logger.js';
import { Permission } from '../../auth/permissions.js';
import { getServerStatus } from './serverStats.js';
import { getLiveUsers } from './presence.js';
import { getJobHealth, getRecentRuns } from './service.js';
import { getRealtime } from '../analytics/service.js';

/**
 * /api/crm/superadmin — the platform operations surface.
 *
 * Gated on `platform:read` (superadmin only, and stripped when the `superadmin`
 * module is disabled), on top of `authenticate`. The read endpoints are plain
 * JSON; `/stream` is an adaptive SSE feed the frontend opens only while its tab
 * is visible (battery-safe), pushing a compact status snapshot every ~15s.
 */
export const superadminRouter = Router();

superadminRouter.use(authenticate, requirePermission(Permission.PLATFORM_READ));

superadminRouter.get(
  '/server',
  asyncHandler(async (_req, res) => {
    res.json(await getServerStatus());
  }),
);

superadminRouter.get(
  '/live',
  asyncHandler(async (_req, res) => {
    res.json(await getLiveUsers());
  }),
);

superadminRouter.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 30;
    const [health, recent] = await Promise.all([getJobHealth(), getRecentRuns(limit)]);
    res.json({ health, recent });
  }),
);

/** One consolidated snapshot, reused by both the SSE loop and a one-shot fetch. */
async function buildSnapshot() {
  const [server, live, jobs, realtime] = await Promise.all([
    getServerStatus(),
    getLiveUsers(),
    getJobHealth(),
    getRealtime(),
  ]);
  return { at: new Date().toISOString(), server, live, jobs, realtime };
}

superadminRouter.get(
  '/snapshot',
  asyncHandler(async (_req, res) => {
    res.json(await buildSnapshot());
  }),
);

/**
 * GET /stream — Server-Sent Events status feed.
 *
 * The client (fetch + ReadableStream, so it can send the Bearer header) opens
 * this only while its tab is visible and aborts on hide; the server also stops
 * on client disconnect. A heartbeat comment every interval keeps proxies from
 * buffering the stream idle.
 */
superadminRouter.get(
  '/stream',
  (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering for this response
    });
    res.write(': open\n\n');

    let closed = false;
    const send = async () => {
      if (closed) return;
      try {
        const snap = await buildSnapshot();
        res.write(`event: status\ndata: ${JSON.stringify(snap)}\n\n`);
      } catch (err) {
        logger.warn({ err }, 'superadmin SSE snapshot failed');
        res.write(': error\n\n');
      }
    };

    void send();
    const timer = setInterval(() => void send(), 15_000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
  },
);
