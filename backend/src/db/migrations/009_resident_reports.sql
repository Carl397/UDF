-- ============================================================
-- 009_resident_reports.sql — Resident → ward councillor report channel.
-- Lets a resident/member in a ward send information (text + optional
-- photo / video / voice note + optional location) to their ward councillor.
-- Media reuse the existing media_assets pipeline (hash + capture_mode +
-- exif_geo). POPIA: the report is private to the author and the ward's staff.
-- Idempotent: safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS resident_reports (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no             TEXT NOT NULL UNIQUE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_id          UUID REFERENCES members(id) ON DELETE SET NULL,
  ward_code          TEXT REFERENCES regions(code) ON DELETE SET NULL,
  category           TEXT NOT NULL,
  message            TEXT NOT NULL,
  location           GEOGRAPHY(Point,4326),
  accuracy_m         DOUBLE PRECISION,
  status             TEXT NOT NULL DEFAULT 'submitted',
  -- The councillor user this report was routed to (null if the ward is vacant).
  councillor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rr_status_chk CHECK (status IN ('submitted','acknowledged','closed')),
  CONSTRAINT rr_category_len CHECK (char_length(category) BETWEEN 1 AND 40),
  CONSTRAINT rr_message_len CHECK (char_length(message) BETWEEN 1 AND 4000)
);

CREATE INDEX IF NOT EXISTS rr_ward_idx ON resident_reports (ward_code, created_at DESC);
CREATE INDEX IF NOT EXISTS rr_user_idx ON resident_reports (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rr_status_idx ON resident_reports (status);

-- Join table linking a report to its captured media assets.
CREATE TABLE IF NOT EXISTS resident_report_media (
  report_id      UUID NOT NULL REFERENCES resident_reports(id) ON DELETE CASCADE,
  media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  PRIMARY KEY (report_id, media_asset_id)
);

CREATE INDEX IF NOT EXISTS rrm_media_idx ON resident_report_media (media_asset_id);
