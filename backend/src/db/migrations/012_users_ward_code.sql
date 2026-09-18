-- ============================================================
-- 012_users_ward_code.sql — fix schema drift (production readiness)
--
-- users.ward_code is written by createUser() during public registration and
-- read for a ward councillor's scope, but it was only ever added to the dev
-- database by hand — no migration created it. A fresh production database built
-- from migrations alone would be missing the column, and every INSERT INTO
-- users (...) would fail with "column ward_code does not exist".
--
-- Add it idempotently so a fresh deploy matches the running schema exactly
-- (TEXT, nullable, FK to regions(code) ON DELETE SET NULL — as in production
-- dev). Safe to re-run; a no-op where the column already exists.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ward_code TEXT REFERENCES regions(code) ON DELETE SET NULL;
