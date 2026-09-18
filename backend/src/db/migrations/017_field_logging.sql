-- ============================================================
-- 017_field_logging.sql — Field logging (Wave 3 foundation).
--
-- Three additive changes that let councillor/staff log cases and patrols from
-- the field with the detail the paper forms used to carry:
--
--   1. sr_follow_up — an INDEPENDENT follow-up sub-state on a case. The 11
--      sr_status values keep their lifecycle meaning (reported → … → closed);
--      follow_up_state paints a SEPARATE chip (awaiting / done / engaged) so a
--      case can be, e.g., 'in_progress' AND 'awaiting' follow-up without the
--      two signals colliding. No enum value of sr_status is changed.
--
--   2. service_requests.street_number — the house / stand number a field worker
--      reads off the erf, kept alongside the existing reverse-geocoded
--      street_address (which is a best-effort label from the GPS point).
--
--   3. patrol_media — attachments for a patrol's "End & report" overview,
--      mirroring service_request_media / resident_report_media so photos,
--      video and voice notes ride the same media_assets pipeline and inherit
--      the same ward-scoped privacy tier in loadMediaForPrincipal().
--
-- resident_reports deliberately gets NO street_number column: that table
-- carries no street address at all (only a GPS `location` + accuracy_m, with
-- the human-readable address living on the reverse-geocoded
-- media_assets.street_address), so per the migration's own conditional the
-- column is skipped rather than added to a table that has nothing to pair it
-- with.
--
-- Idempotent: safe to run multiple times.
-- ============================================================

-- ---------- Follow-up sub-state (independent of sr_status) ----------
DO $$ BEGIN
  CREATE TYPE sr_follow_up AS ENUM ('none','awaiting','done','engaged');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- service_requests: follow-up state + street/stand number ----------
ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS follow_up_state sr_follow_up NOT NULL DEFAULT 'none';
ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS street_number TEXT;

-- ---------- patrol_media (overview-report attachments) ----------
-- Mirrors service_request_media (003) and resident_report_media (009): a link
-- row per captured asset, ordered by seq. loadMediaForPrincipal() gains a
-- matching UNION branch so a patrol attachment resolves to the patrol's ward
-- and is served under the same ward-scoped tier as project media.
CREATE TABLE IF NOT EXISTS patrol_media (
  patrol_id      UUID NOT NULL REFERENCES patrols(id) ON DELETE CASCADE,
  media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (patrol_id, media_asset_id)
);
CREATE INDEX IF NOT EXISTS patrol_media_media_idx ON patrol_media (media_asset_id);
