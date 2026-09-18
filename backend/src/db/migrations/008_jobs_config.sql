-- ============================================================
-- 008_jobs_config.sql — Ward Jobs administration (PRD-jobs FR-N4).
-- Adds: runtime feature flags (kill-switch without redeploy) and a small
-- key/value config store for the relay email template and demand windows.
-- The work-type taxonomy table (work_types) already exists in 007; national
-- admins edit it through the CRM Settings surface backed by these endpoints.
-- Idempotent: safe to run multiple times.
-- ============================================================

-- ---------- Feature flags (FR-N4 / §9.7 kill-switch) ----------
CREATE TABLE IF NOT EXISTS feature_flags (
  key         TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO feature_flags (key, enabled, description) VALUES
  ('jobs.register',    true,  'Members may add/edit their own ward work-interest register (FR-K).'),
  ('jobs.relay',       true,  'Publishing an opportunity relays in-app + email alerts to matched members (FR-M2). Off = manual briefing mode.'),
  ('jobs.publicCount', false, 'Show the anonymous "people looking for work" count on the public ward overview (FR-L4).')
ON CONFLICT (key) DO NOTHING;

-- ---------- Job config key/value store (FR-N4) ----------
CREATE TABLE IF NOT EXISTS job_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO job_config (key, value) VALUES
  ('jobs.relayEmailSubject', 'Work opportunity in your ward — {ref}'),
  ('jobs.relayEmailBody',
   E'Hi {firstName},\n\nA work opportunity matching your skills is now open in your ward:\n\n{title} at {company}\nReference: {ref}\n\nApply DIRECTLY to the company:\n{contact}\n\nUDF never collects CVs and never shares your details with the employer. This is an indication only.'),
  ('jobs.demandStaleDays',   '90'),
  ('jobs.duplicateGuardDays','14')
ON CONFLICT (key) DO NOTHING;
