-- ============================================================
-- 013_must_change_password.sql — forced password change on first login
--
-- An account provisioned with a shared/bootstrap password (e.g. the seeded
-- super-admin, whose password the operator supplies via env) must set a private
-- password before it can use the app. `must_change_password` is the server-side
-- flag: the login response mirrors it as `mustChangePassword` and the frontend
-- gates on it exactly like the T&C gate. POST /auth/change-password verifies the
-- current password, rotates tokens (revoking every other session) and clears it.
--
-- Idempotent; a no-op where the column already exists. Existing rows default to
-- FALSE so the migration itself locks nobody out — seed:admin asserts TRUE for
-- the bootstrap admin.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
