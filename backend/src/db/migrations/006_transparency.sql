-- ============================================================
-- 006_transparency.sql — Ward transparency & accountability (PRD Phase 4.5).
-- Adds: visibility/privacy tiers on logs & patrols, project stage media,
-- moderation trail, ward-change audit + cap, email OTP, diagnostics events.
-- Idempotent: safe to run multiple times.
-- ============================================================

-- ---------- Visibility / privacy tiers ----------
-- public   => anyone (overview aggregates only, no media)
-- members  => ward members see detail + privacy-filtered media
-- private  => authorised staff see category + overview only
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'members';
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS privacy_flags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE patrols ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'members';

DO $$ BEGIN
  ALTER TABLE service_requests ADD CONSTRAINT sr_visibility_chk
    CHECK (visibility IN ('public','members','private'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE patrols ADD CONSTRAINT patrols_visibility_chk
    CHECK (visibility IN ('public','members','private'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS sr_visibility_idx ON service_requests (visibility);
CREATE INDEX IF NOT EXISTS patrols_visibility_idx ON patrols (visibility);

-- Allow ratings on patrols as well as cases / councillors / projects.
DO $$ BEGIN
  ALTER TYPE rating_target_type ADD VALUE 'patrol';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Project stage media (before / during / after) ----------
DO $$ BEGIN
  CREATE TYPE project_media_stage AS ENUM ('before','during','after');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS project_media (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage       project_media_stage NOT NULL,
  media_id    UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  caption     TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, stage, media_id)
);
CREATE INDEX IF NOT EXISTS pm_stage_idx ON project_media (project_id, stage);

-- ---------- Moderation trail (posts / events / bulletins) ----------
CREATE TABLE IF NOT EXISTS moderation_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type   TEXT NOT NULL,               -- post|event|bulletin
  target_id     UUID NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|taken_down
  submitted_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   TIMESTAMPTZ,
  decision_note TEXT,
  UNIQUE (target_type, target_id)
);
CREATE INDEX IF NOT EXISTS mi_status_idx ON moderation_items (status);
CREATE INDEX IF NOT EXISTS mi_submitted_idx ON moderation_items (submitted_at DESC);

ALTER TABLE posts  ADD COLUMN IF NOT EXISTS publication_status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE events ADD COLUMN IF NOT EXISTS publication_status TEXT NOT NULL DEFAULT 'published';

-- ---------- Ward change audit + cap (3 per 5-year term) ----------
CREATE TABLE IF NOT EXISTS ward_change_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id       UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  from_ward       TEXT REFERENCES regions(code) ON DELETE SET NULL,
  to_ward         TEXT NOT NULL REFERENCES regions(code) ON DELETE CASCADE,
  reason          TEXT NOT NULL,
  otp_verified_at TIMESTAMPTZ,
  overridden_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wcl_member_idx ON ward_change_log (member_id);
CREATE INDEX IF NOT EXISTS wcl_created_idx ON ward_change_log (created_at DESC);

ALTER TABLE members ADD COLUMN IF NOT EXISTS ward_changes_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN IF NOT EXISTS term_started_at DATE NOT NULL DEFAULT CURRENT_DATE;

-- ---------- Email OTP (login / reset / ward change) ----------
CREATE TABLE IF NOT EXISTS email_otps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id  UUID NOT NULL,                 -- users.id
  purpose     TEXT NOT NULL,                 -- login|reset|ward_change
  code_hash   CHAR(64) NOT NULL,             -- SHA-256 of the 6-digit code
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_subject_idx ON email_otps (subject_id, purpose);
CREATE INDEX IF NOT EXISTS otp_expires_idx ON email_otps (expires_at);

-- ---------- Diagnostics events (CRM debugging workspace, PRD §6) ----------
CREATE TABLE IF NOT EXISTS diagnostics_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source         TEXT NOT NULL,              -- web|android
  app_version    TEXT,
  route          TEXT,
  role           TEXT,
  correlation_id TEXT,
  severity       TEXT NOT NULL DEFAULT 'error', -- error|warn|network
  signature      TEXT NOT NULL,              -- dedupe key
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- redacted server-side
  count          INTEGER NOT NULL DEFAULT 1,
  first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status         TEXT NOT NULL DEFAULT 'open',  -- open|ack|resolved
  owner          UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS de_signature_idx ON diagnostics_events (signature);
CREATE INDEX IF NOT EXISTS de_status_idx ON diagnostics_events (status);
CREATE INDEX IF NOT EXISTS de_corr_idx ON diagnostics_events (correlation_id);
