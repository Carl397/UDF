-- ============================================================
-- 014_actor_attribution.sql — record WHO acted, and stop
-- attributing patrols and bulletins to an arbitrary member.
--
-- `patrols.councillor_member_id` and `ward_bulletins.councillor_member_id` are
-- both NOT NULL with no default, and both services resolved them with the same
-- guess:
--
--     (SELECT id FROM members WHERE created_by = <principal.sub> LIMIT 1)
--
-- i.e. "some member this user once happened to enrol". There is no user→member
-- link anywhere in the schema — `users` has no member_id column, and the users'
-- and members' blind indexes do not overlap — so for any account that has not
-- itself created a member row the sub-select returns NULL and the INSERT dies on
-- the not-null constraint. Measured against the validation fixtures:
--
--     ward_councillor     POST /api/patrols        → 500 not-null violation
--     ward_councillor     POST /api/ward-bulletins → 500 not-null violation
--     regional_organizer  POST /api/patrols        → 500 not-null violation
--     regional_organizer  POST /api/ward-bulletins → 500 not-null violation
--     national_admin      both                     → 201, attributed to an
--                                                    unrelated member
--                                                    (LIMIT 1, no ORDER BY)
--
-- So the two roles that walk patrols and publish ward bulletins could not use
-- either feature at all, and the one role that could had its records silently
-- written against a stranger's member record. `patrols` additionally had no
-- column naming the acting user, so the API could not answer "who logged this
-- patrol?" — an accountability gap under POPIA §8 for a table holding GPS tracks
-- and street addresses.
--
-- Fix:
--   • add `patrols.created_by`, the accountable actor, matching the convention
--     used by every other table in 001–003 (`ward_bulletins` already has it);
--   • make both `councillor_member_id` columns nullable. They remain the
--     optional link to the member record being reported on, but a patrol or a
--     bulletin is no longer refused when no such member can be identified.
--
-- Idempotent; safe to re-run, and a no-op where the changes already exist.
-- ============================================================

ALTER TABLE patrols
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE patrols
  ALTER COLUMN councillor_member_id DROP NOT NULL;

ALTER TABLE ward_bulletins
  ALTER COLUMN councillor_member_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_patrols_created_by ON patrols (created_by);
