-- CMS: pages + sections on top of the existing content blocks.
--
-- content_blocks already holds named, field-based, draft/published/rollback
-- payloads (035). This adds the two pieces the SuperAdmin editor needs to manage
-- whole pages rather than only editing pre-seeded blocks:
--   1. a `kind` on blocks so the editor/renderer can special-case a `slider`
--      (image + text, per-slide duration) or a generic `section`, not just the
--      flat `fields` blocks that already exist;
--   2. a `content_pages` table whose `sections` is an ordered array of
--      { blockKey } references, with the same draft -> published split as blocks
--      (public readers only ever see `published_sections`), plus a version
--      snapshot table for page rollback.
--
-- A page is a lightweight ordering shell; the actual field payloads still live
-- in content_blocks (shared across pages / surfaces). Blocks are deliberately
-- NOT hard-FK-referenced from the jsonb `sections`, so the service layer is
-- responsible for refusing to delete a block a page still uses.

ALTER TABLE content_blocks
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'fields'
    CHECK (kind IN ('fields', 'slider', 'section'));

CREATE TABLE content_pages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (char_length(slug) BETWEEN 1 AND 160),
  site        text NOT NULL CHECK (site IN ('marketing', 'app')),
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  -- draft: ordered array of { "blockKey": text }
  sections    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- published: the same shape, only ever served publicly
  published_sections jsonb,
  published_title    text,
  version     integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX content_pages_site_idx ON content_pages (site);

CREATE TABLE content_page_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL REFERENCES content_pages(slug) ON DELETE CASCADE,
  version      integer NOT NULL,
  snapshot     jsonb NOT NULL, -- { title, sections }
  published_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug, version)
);
CREATE INDEX content_page_versions_slug_idx ON content_page_versions (slug, version DESC);

-- Registry of media uploaded through the CMS itself (slider imagery etc.). The
-- public media route only ever serves ids present here, so an internal report
-- attachment can never leak by guessing its uuid.
CREATE TABLE cms_media (
  media_id   uuid PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
