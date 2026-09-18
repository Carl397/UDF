-- ============================================================
-- 025_resident_report_feedback.sql — Report status workflow + resident feedback.
--
-- Residents send information to their ward councillor (migration 009). Until now
-- staff could only see the report; there was no way to move it through a
-- lifecycle or to write back to the resident. This adds:
--
--   * A richer status vocabulary so a resident can track progress
--     (submitted → acknowledged → in_progress → resolved / closed).
--   * `feedback`     — the follow-up note the councillor's office writes back to
--                      the resident (shown in their "my reports" view).
--   * `responded_at` / `responded_by` — when and by whom feedback was last given.
--
-- Idempotent: safe to run multiple times.
-- ============================================================

-- Widen the status CHECK. 'in_progress' and 'resolved' are added between
-- 'acknowledged' and 'closed'; the two original values stay valid so existing
-- rows are unaffected.
ALTER TABLE resident_reports DROP CONSTRAINT IF EXISTS rr_status_chk;
ALTER TABLE resident_reports
  ADD CONSTRAINT rr_status_chk
  CHECK (status IN ('submitted','acknowledged','in_progress','resolved','closed'));

ALTER TABLE resident_reports ADD COLUMN IF NOT EXISTS feedback TEXT;
ALTER TABLE resident_reports ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;
ALTER TABLE resident_reports
  ADD COLUMN IF NOT EXISTS responded_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE resident_reports DROP CONSTRAINT IF EXISTS rr_feedback_len;
ALTER TABLE resident_reports
  ADD CONSTRAINT rr_feedback_len
  CHECK (feedback IS NULL OR char_length(feedback) BETWEEN 1 AND 4000);
