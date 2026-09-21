-- Structured website content blocks (SuperAdmin website editor).
--
-- The marketing site and the app landing page render from named, structured
-- blocks instead of hard-coded copy. A block holds a JSON `schema` (the fields
-- the editor renders: label, type, max length), a `draft` (work in progress) and
-- the `published` payload the public read API serves. Editing is field-based, so
-- a superadmin can change hero copy, stats, CTA links and images without writing
-- HTML. Every publish snapshots into content_block_versions for rollback.
CREATE TABLE content_blocks (
  key         text PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 128),
  site        text NOT NULL CHECK (site IN ('marketing','app','shared')),
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  schema      jsonb NOT NULL DEFAULT '{}'::jsonb,
  draft       jsonb NOT NULL DEFAULT '{}'::jsonb,
  published   jsonb,
  version     integer NOT NULL DEFAULT 0,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX content_blocks_site_idx ON content_blocks (site);

CREATE TABLE content_block_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL REFERENCES content_blocks(key) ON DELETE CASCADE,
  version     integer NOT NULL,
  payload     jsonb NOT NULL,
  published_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, version)
);
CREATE INDEX content_block_versions_key_idx ON content_block_versions (key, version DESC);
