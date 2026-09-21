import { query } from '../../db/pool.js';

/** Cron/job health for the SuperAdmin dashboard: latest run per job + success rate. */
export interface JobHealth {
  jobName: string;
  lastStatus: string;
  lastStartedAt: string;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  /** Seconds since the last successful completion; the panel reddens when stale. */
  secondsSinceLastSuccess: number | null;
  successRatePct: number | null;
  recentRuns: number;
}

export async function getJobHealth(): Promise<JobHealth[]> {
  const { rows } = await query<{
    job_name: string;
    last_status: string;
    last_started_at: string;
    last_finished_at: string | null;
    last_duration_ms: number | null;
    since_success_secs: number | null;
    success_rate: string | null;
    recent_runs: string;
  }>(
    `WITH ranked AS (
       SELECT job_name, status, started_at, finished_at, duration_ms,
              row_number() OVER (PARTITION BY job_name ORDER BY started_at DESC) AS rn,
              count(*) OVER (PARTITION BY job_name) AS total
         FROM job_runs
        WHERE started_at > now() - interval '7 days'
     ), latest AS (
       SELECT job_name,
              (array_agg(status ORDER BY started_at DESC))[1] AS last_status,
              max(started_at) AS last_started_at,
              (array_agg(finished_at ORDER BY started_at DESC))[1] AS last_finished_at,
              (array_agg(duration_ms ORDER BY started_at DESC))[1] AS last_duration_ms,
              count(*)::text AS recent_runs,
              round(100.0 * count(*) FILTER (WHERE status='ok') / nullif(count(*),0))::text AS success_rate
         FROM ranked GROUP BY job_name
     ), success AS (
       SELECT job_name,
              EXTRACT(EPOCH FROM (now() - max(started_at)))::int AS since_success_secs
         FROM job_runs WHERE status = 'ok' GROUP BY job_name
     )
     SELECT l.job_name, l.last_status, l.last_started_at, l.last_finished_at, l.last_duration_ms,
            s.since_success_secs, l.success_rate, l.recent_runs
       FROM latest l LEFT JOIN success s ON s.job_name = l.job_name
       ORDER BY l.job_name`,
  );
  return rows.map((r) => ({
    jobName: r.job_name,
    lastStatus: r.last_status,
    lastStartedAt: r.last_started_at,
    lastFinishedAt: r.last_finished_at,
    lastDurationMs: r.last_duration_ms,
    secondsSinceLastSuccess: r.since_success_secs,
    successRatePct: r.success_rate != null ? Number(r.success_rate) : null,
    recentRuns: Number(r.recent_runs),
  }));
}

/** The most recent individual job runs, for a history strip. */
export async function getRecentRuns(limit = 30) {
  const { rows } = await query(
    `SELECT job_name AS "jobName", status, started_at AS "startedAt",
            finished_at AS "finishedAt", duration_ms AS "durationMs", detail
       FROM job_runs ORDER BY started_at DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 100)],
  );
  return rows;
}
