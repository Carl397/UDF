-- Cron / scheduled-job health.
--
-- The backend runs a small in-process scheduler (see db/../modules/platform
-- scheduler). Every run records a row here: the SuperAdmin "crons" panel reads
-- the latest run per job_name plus success rate, so a stalled or failing job is
-- visible instead of silently dead. `status='running'` rows are updated to
-- 'ok'/'error' on completion; a stuck 'running' row older than its interval is
-- treated as failed by the dashboard.
CREATE TABLE job_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name    text NOT NULL CHECK (char_length(job_name) BETWEEN 1 AND 64),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error')),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX job_runs_name_started_idx ON job_runs (job_name, started_at DESC);
CREATE INDEX job_runs_started_idx ON job_runs (started_at DESC);
