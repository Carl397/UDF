-- ============================================================
-- 040_cover_images.sql — A dedicated cover/banner image for
-- events and ward bulletins.
--
-- Distinct from the `attachments` gallery (036): the cover is the single
-- hero image shown on the event card / bulletin, so it is a first-class
-- column rather than one photo among many. It reuses the shared
-- `media_assets` pipeline (base64 data-url -> uploads/ + SHA-256 hash) that
-- attachments, patrols and resident reports already use — only a FK pointer
-- is added here.
--
-- ON DELETE SET NULL: removing the media asset (or the author's account)
-- detaches the cover instead of cascading away the whole event/bulletin.
-- ============================================================

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS cover_media_id UUID REFERENCES media_assets(id) ON DELETE SET NULL;

ALTER TABLE ward_bulletins
  ADD COLUMN IF NOT EXISTS cover_media_id UUID REFERENCES media_assets(id) ON DELETE SET NULL;
