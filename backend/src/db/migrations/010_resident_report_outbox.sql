-- Phase 3: resident → councillor report delivery outbox.
-- Mirrors job_relay_outbox: captures in-app + email delivery per routed
-- councillor. The dev transport has no SMTP, so an email row is captured here
-- (status 'sent' when the councillor's sealed address resolves, else 'failed').
CREATE TABLE IF NOT EXISTS resident_report_outbox (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id  UUID NOT NULL REFERENCES resident_reports(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL,
  to_email   TEXT,
  status     TEXT NOT NULL DEFAULT 'queued',
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rro_channel_chk CHECK (channel IN ('inapp','email')),
  CONSTRAINT rro_status_chk CHECK (status IN ('queued','sent','failed'))
);
CREATE INDEX IF NOT EXISTS rro_report_idx ON resident_report_outbox (report_id);
CREATE INDEX IF NOT EXISTS rro_user_idx   ON resident_report_outbox (user_id);
