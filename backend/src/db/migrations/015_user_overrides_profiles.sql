-- 015: per-user permission overrides + user profile (avatar / bio / title).
--
-- Permission overrides let an administrator grant or revoke individual
-- permissions ON TOP of a user's base role (the ROLE_PERMISSIONS matrix in
-- backend/src/auth/permissions.ts stays the single source of truth for the
-- role default). Effective set = (role perms ∪ grants) − revokes, computed by
-- effectivePermissions() and re-read from these columns on every request, so
-- enforcement is live with no stale-token window.
--
-- The profile columns back the CRM "Users & Roles" photo / bio / title editor.
-- avatar_media_id references media_assets (the existing hashed-upload store);
-- for ward_councillors the same photo+bio is mirrored into `leaders` so the
-- public ward/verify pages can show the councillor's face and bio.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS permission_grants  TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS permission_revokes TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS avatar_media_id    UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bio                TEXT,
  ADD COLUMN IF NOT EXISTS title              TEXT;
