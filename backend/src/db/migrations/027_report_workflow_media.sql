-- Durable resident follow-up and independent global capture controls.
ALTER TABLE resident_reports ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE resident_reports ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE resident_reports ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE resident_reports ADD COLUMN IF NOT EXISTS follow_up_at timestamptz;
ALTER TABLE resident_reports ADD COLUMN IF NOT EXISTS sealed_reference jsonb;
ALTER TABLE resident_reports ADD COLUMN IF NOT EXISTS masked_reference text;
ALTER TABLE resident_reports ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
ALTER TABLE resident_reports ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS resident_report_request_idx ON resident_reports(user_id, request_id);

CREATE TABLE IF NOT EXISTS resident_report_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES resident_reports(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role text,
  action text NOT NULL,
  from_status text,
  to_status text,
  note text,
  contact_method text CHECK (contact_method IN ('phone','email','sms','whatsapp','in_person','service_portal','other')),
  contact_target text,
  contact_method_detail text,
  internal_note text,
  follow_up_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid,
  UNIQUE (report_id, request_id)
);
CREATE INDEX IF NOT EXISTS resident_report_events_report_idx ON resident_report_events(report_id, created_at);
CREATE INDEX IF NOT EXISTS resident_report_due_idx ON resident_reports(follow_up_at) WHERE status NOT IN ('resolved','closed');

-- Preserve the last old reply; earlier overwritten replies cannot be reconstructed.
INSERT INTO resident_report_events(report_id, actor_id, action, to_status, note, created_at)
SELECT id, responded_by, 'legacy_feedback', status, feedback, COALESCE(responded_at, created_at)
FROM resident_reports r WHERE feedback IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM resident_report_events e WHERE e.report_id = r.id AND e.action = 'legacy_feedback');

CREATE TABLE IF NOT EXISTS media_capture_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  photo boolean NOT NULL DEFAULT true,
  video boolean NOT NULL DEFAULT true,
  voice boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO media_capture_policy(singleton) VALUES (true) ON CONFLICT DO NOTHING;

ALTER TABLE patrols ADD COLUMN IF NOT EXISTS completion_request_id uuid;
ALTER TABLE patrols ADD COLUMN IF NOT EXISTS distance_source text CHECK (distance_source IN ('gps', 'manual'));
ALTER TABLE patrol_stops ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS patrol_stops_request_idx ON patrol_stops(patrol_id, request_id);
ALTER TABLE patrol_stops ADD COLUMN IF NOT EXISTS contact_method text;
ALTER TABLE patrol_stops ADD COLUMN IF NOT EXISTS follow_up_at timestamptz;
ALTER TABLE patrol_stops ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE patrol_stops DROP CONSTRAINT IF EXISTS ps_call_status_chk;
ALTER TABLE patrol_stops ADD CONSTRAINT ps_call_status_chk CHECK (call_status IN ('call_logged','in_progress','waiting_on_feedback','completed'));
