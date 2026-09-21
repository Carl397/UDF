import { query } from '../../db/pool.js';
import { logger } from '../../config/logger.js';
import {
  refreshRealtime,
  rollupAnalyticsDay,
  rollupDownloadDay,
  currentDayKey,
} from '../analytics/service.js';

/**
 * A tiny, dependency-free interval scheduler for the platform housekeeping the
 * SuperAdmin dashboard depends on. Every run records a `job_runs` row (running
 * → ok/error) so a stalled or failing job is visible instead of silently dead.
 *
 * Deliberally in-process: these jobs are idempotent aggregates over our own
 * Postgres, the API is a single instance, and this keeps the "cron health"
 * panel honest without introducing a scheduler service to operate. Each timer
 * is `unref()`'d so it never, by itself, keeps the process alive.
 */

type Job = {
  name: string;
  intervalMs: number;
  run: () => Promise<Record<string, unknown>>;
};

const JOBS: Job[] = [
  { name: 'analytics.realtime_refresh', intervalMs: 60_000, run: async () => { await refreshRealtime(); return {}; } },
  { name: 'analytics.rollup', intervalMs: 15 * 60_000, run: async () => { const day = currentDayKey(); await rollupAnalyticsDay(day); return { day }; } },
  { name: 'analytics.download_rollup', intervalMs: 15 * 60_000, run: async () => { const day = currentDayKey(); await rollupDownloadDay(day); return { day }; } },
  {
    name: 'housekeeping.cleanup',
    intervalMs: 60 * 60_000,
    run: async () => {
      const deleted = await query(
        `WITH a AS (
           DELETE FROM analytics_events WHERE ts < now() - interval '400 days' RETURNING 1),
         j AS (
           DELETE FROM job_runs WHERE started_at < now() - interval '30 days' RETURNING 1),
         s AS (
           DELETE FROM refresh_tokens
            WHERE (revoked_at IS NOT NULL OR expires_at < now() - interval '30 days')
              AND COALESCE(last_seen_at, created_at) < now() - interval '30 days' RETURNING 1)
         SELECT
           (SELECT count(*) FROM a)::int AS events,
           (SELECT count(*) FROM j)::int AS jobs,
           (SELECT count(*) FROM s)::int AS sessions`,
      );
      return deleted.rows[0] ?? {};
    },
  },
];

/** Record one job execution, returning its terminal status. */
export async function runJob(job: Job): Promise<'ok' | 'error'> {
  const startedAt = new Date();
  let rowId = '';
  try {
    const ins = await query<{ id: string }>(
      `INSERT INTO job_runs (job_name, started_at, status)
       VALUES ($1, $2, 'running') RETURNING id`,
      [job.name, startedAt.toISOString()],
    );
    rowId = ins.rows[0]!.id;
  } catch (err) {
    logger.warn({ err, job: job.name }, 'job_runs insert failed');
  }

  const t0 = Date.now();
  let status: 'ok' | 'error' = 'ok';
  let detail: Record<string, unknown> = {};
  try {
    detail = await job.run();
  } catch (err) {
    status = 'error';
    detail = { error: err instanceof Error ? err.message : String(err) };
    logger.error({ err, job: job.name }, 'scheduled job failed');
  }
  const durationMs = Date.now() - t0;

  if (rowId) {
    try {
      await query(
        `UPDATE job_runs
            SET finished_at = now(), status = $2, duration_ms = $3, detail = $4::jsonb
          WHERE id = $1`,
        [rowId, status, durationMs, JSON.stringify(detail)],
      );
    } catch (err) {
      logger.warn({ err, job: job.name }, 'job_runs update failed');
    }
  }
  return status;
}

let started = false;
const timers: NodeJS.Timeout[] = [];

/** Start the scheduler. Safe to call once; returns a stop() handle. */
export function startScheduler(): () => void {
  if (started) return () => undefined;
  started = true;
  for (const job of JOBS) {
    // Stagger first runs a few seconds apart to avoid a startup thundering herd.
    const firstDelay = 5_000 + timers.length * 2_000;
    setTimeout(() => void runJob(job), firstDelay).unref();
    const timer = setInterval(() => void runJob(job), job.intervalMs);
    timer.unref();
    timers.push(timer);
  }
  logger.info({ jobs: JOBS.map((j) => j.name) }, 'platform scheduler started');
  return () => {
    timers.forEach(clearInterval);
    started = false;
  };
}
