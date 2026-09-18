-- ============================================================
-- 023_patrol_call_log.sql — Patrol call log (service delivery calls).
--
-- Councillors log service-delivery calls from patrol entries/findings.
-- Each patrol stop can now carry a title and a call_status that tracks
-- the follow-up state of the issue discovered during the walkabout.
--
-- call_status values:
--   call_logged          — initial state: the issue has been noted
--   in_progress          — the councillor or a service team is working on it
--   waiting_on_feedback  — awaiting a response from the service provider
--
-- Idempotent: safe to run multiple times.
-- ============================================================

ALTER TABLE patrol_stops ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE patrol_stops ADD COLUMN IF NOT EXISTS call_status TEXT NOT NULL DEFAULT 'call_logged';
ALTER TABLE patrol_stops ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$ BEGIN
  ALTER TABLE patrol_stops ADD CONSTRAINT ps_call_status_chk
    CHECK (call_status IN ('call_logged','in_progress','waiting_on_feedback'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS ps_call_status_idx ON patrol_stops (call_status);
