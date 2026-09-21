-- ============================================================
-- Multi-ward councillors (public display link)
-- ============================================================
-- A ward_councillor can now be LINKED to more than one ward. The single
-- `ward_code` stays the councillor's PRIMARY ward — it is what drives their
-- login/territory scope (auth/scope.ts) and remains the FK-guarded column. The
-- new `ward_codes[]` is the full list of wards they are shown for across the
-- public surfaces (the map region summary and the ward transparency page, i.e.
-- "your councillor" + "rate your councillor"). It is served live from the API,
-- so changing it needs no APK rebuild.
--
-- `users.ward_codes` is the editable source of truth (set in CRM → Users &
-- Roles); `leaders.ward_codes` is the published mirror that the read queries
-- use, kept in step by syncCouncillorLeader().
--
-- Idempotent: guarded ADD COLUMN / backfill only fills empty arrays.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ward_codes TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE leaders
  ADD COLUMN IF NOT EXISTS ward_codes TEXT[] NOT NULL DEFAULT '{}';

-- Backfill: a councillor's existing single ward becomes their one-element list.
UPDATE users
   SET ward_codes = ARRAY[ward_code]
 WHERE ward_code IS NOT NULL AND ward_codes = '{}';

UPDATE leaders
   SET ward_codes = ARRAY[ward_code]
 WHERE ward_code IS NOT NULL AND ward_codes = '{}';

-- The read queries match a requested ward against the array; a GIN index keeps
-- that cheap as the roster grows.
CREATE INDEX IF NOT EXISTS leaders_ward_codes_idx ON leaders USING gin (ward_codes);
CREATE INDEX IF NOT EXISTS users_ward_codes_idx   ON users   USING gin (ward_codes);
