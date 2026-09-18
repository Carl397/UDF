-- 026_notification_audience.sql
--
-- Add an audience dimension to notifications so broadcasts (user_id IS NULL) can
-- be scoped to STAFF operators only, instead of landing in every member's bell.
--
--   audience = 'all'   → visible to everyone (members + staff): events, new
--                        community posts, and deliberate manual broadcasts.
--   audience = 'staff' → visible to STAFF roles only: workflow noise like a new
--                        membership application, a membership/mandate
--                        confirmation, a taken-down community note, or an
--                        appointment being issued/revoked.
--
-- Targeted notifications (user_id set) are unaffected — audience only gates the
-- broadcast rows. Idempotent: safe to re-run.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'all';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notifications_audience_chk'
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT notifications_audience_chk CHECK (audience IN ('all', 'staff'));
  END IF;
END $$;

-- Broadcasts that are clearly staff-workflow get re-tagged so existing rows stop
-- showing in member bells. Targeted rows (user_id IS NOT NULL) are left alone.
UPDATE notifications
   SET audience = 'staff'
 WHERE user_id IS NULL
   AND audience = 'all'
   AND (
        kind IN ('member', 'mandate', 'appointment')
     OR link LIKE '/crm/%'
   );
