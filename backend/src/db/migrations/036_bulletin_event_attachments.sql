-- ============================================================
-- 036_bulletin_event_attachments.sql — Rich attachments for
-- ward bulletins and events.
--
-- Lets an author insert a PDF, a photo, a short video, or a URL
-- link onto a bulletin or an event. Binary files (photo / video /
-- PDF) reuse the existing `media_assets` pipeline (base64 data-url
-- -> uploads/ + SHA-256 hash); only a join row is added here. A
-- link carries no file, just its URL.
--
-- The link is POLYMORPHIC (parent_type + parent_id) rather than a
-- FK per entity, mirroring how the CRM already relates media to
-- many parents, so a single module serves both surfaces. parent_id
-- is intentionally not a FK (a UUID cannot reference two tables);
-- the service validates the parent exists and is in scope on every
-- write, and ON DELETE of a parent is cleaned up in-service.
-- ============================================================

-- A PDF is neither photo / video / audio; give the shared media
-- enum a value so a document asset is labelled truthfully.
ALTER TYPE capture_mode ADD VALUE IF NOT EXISTS 'document';

CREATE TABLE IF NOT EXISTS attachments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_type TEXT NOT NULL CHECK (parent_type IN ('bulletin','event')),
  parent_id   UUID NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('photo','video','document','link')),
  -- File kinds reference a media_asset; a link stores its URL and no media.
  media_id    UUID REFERENCES media_assets(id) ON DELETE CASCADE,
  url         TEXT,
  title       TEXT,
  caption     TEXT,
  seq         INTEGER NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attachment_shape CHECK (
    (kind = 'link'     AND url IS NOT NULL AND media_id IS NULL)
    OR
    (kind <> 'link'    AND media_id IS NOT NULL AND url IS NULL)
  ),
  CONSTRAINT attachment_link_http CHECK (
    url IS NULL OR url ~* '^https?://'
  )
);
CREATE INDEX IF NOT EXISTS attachments_parent_idx ON attachments (parent_type, parent_id, seq);
CREATE INDEX IF NOT EXISTS attachments_media_idx  ON attachments (media_id);
