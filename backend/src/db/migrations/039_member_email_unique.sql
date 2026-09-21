-- ============================================================
-- 039_member_email_unique.sql — Close the duplicate-email gap on
-- the public membership register.
--
-- `users.email_bidx` has been UNIQUE since 001, but `members.email_bidx`
-- was only ever a plain lookup index. The "already registered" guard in
-- memberships/service.ts is an application-level SELECT-then-INSERT, so two
-- concurrent registrations of the same email could both pass the check and
-- land two member rows on one identity — the "double email account" risk.
--
-- This makes the guarantee a real database constraint. It is PARTIAL and
-- scoped to live rows (`deleted_at IS NULL`) so it matches the register's
-- notion of "taken": a member soft-deleted for right-to-erasure frees their
-- email for a fresh registration, and NULL bidx (a staff-created member with
-- no email) is unconstrained, exactly as Postgres treats NULLs as distinct in
-- a unique index.
--
-- Dedup is verified before the index is created: if the register already
-- holds a live duplicate, the migration fails loudly rather than silently
-- picking a winner and hiding the data problem.
-- ============================================================

DO $$
DECLARE
  dup_groups INTEGER;
BEGIN
  SELECT count(*) INTO dup_groups
    FROM (
      SELECT email_bidx
        FROM members
       WHERE email_bidx IS NOT NULL AND deleted_at IS NULL
       GROUP BY email_bidx
      HAVING count(*) > 1
    ) d;
  IF dup_groups > 0 THEN
    RAISE EXCEPTION
      'cannot enforce unique member email: % live email(s) are registered more than once; resolve them first',
      dup_groups;
  END IF;
END $$;

-- The unique index supersedes the plain lookup index.
DROP INDEX IF EXISTS members_email_bidx;
CREATE UNIQUE INDEX IF NOT EXISTS members_email_bidx_live_unique
    ON members (email_bidx)
 WHERE email_bidx IS NOT NULL AND deleted_at IS NULL;
