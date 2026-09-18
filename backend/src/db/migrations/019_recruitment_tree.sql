-- ============================================================
-- 019_recruitment_tree.sql — Recruitment genealogy (PRD-growth FR-O, Wave 5 Phase A).
--
-- Turns the free-text `members.referral` hint (migration 002) into a durable,
-- queryable parent → child recruitment LINK so the platform can render a
-- recruitment tree ("this branch grew to 6, those 6 to 15, …"), trace any member
-- back to the root source, and rank ward councillors by the trees they originate.
--
--   members.referred_by_member_id  self-FK to the member who recruited this one.
--   idx_members_referred_by        fast child lookups (the recursive tree walk).
--   backfill                       resolve existing free-text referral codes
--                                  (public_code) to member ids — NULL when a code
--                                  does not resolve (organic signup), never an error.
--   fn_prevent_referral_cycle()    reject any INSERT/UPDATE that would make a node
--                                  its own ancestor (FR-O8 integrity). Created AFTER
--                                  the backfill so the bulk UPDATE is not walked.
--
-- The `recruitment` feature module and its kill-switch flags are registered here
-- too, so the CRM module registry and the service's isFlagEnabled() see them.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ---------- Durable recruitment link (FR-O1) ----------
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS referred_by_member_id UUID REFERENCES members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_members_referred_by ON members (referred_by_member_id);

-- ---------- Backfill from the free-text referral code (FR-O1) ----------
-- `members.referral` holds the referrer's public code (`UDF-XXX-YYY`) as typed or
-- supplied via `/register?ref=`. Resolve it to a member id where it matches a
-- live member's public_code; leave NULL otherwise (unresolvable/organic). Only
-- fills rows that are still NULL, so it is safe to re-run and never overwrites a
-- link set at registration. Runs BEFORE the cycle trigger is created.
UPDATE members m
   SET referred_by_member_id = p.id
  FROM members p
 WHERE m.referred_by_member_id IS NULL
   AND m.referral IS NOT NULL
   AND btrim(m.referral) <> ''
   AND p.public_code = btrim(m.referral)
   AND p.id <> m.id
   AND p.deleted_at IS NULL;

-- ---------- Cycle prevention (FR-O8) ----------
-- A recruitment tree must stay acyclic: re-parenting a node under one of its own
-- descendants would make it its own ancestor and send every recursive walk into an
-- infinite loop. The walk up from the proposed parent is depth-capped (64) so even
-- already-corrupt data cannot hang the trigger.
CREATE OR REPLACE FUNCTION fn_prevent_referral_cycle() RETURNS trigger AS $$
BEGIN
  IF NEW.referred_by_member_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.referred_by_member_id = NEW.id THEN
    RAISE EXCEPTION 'A member cannot be referred by themselves';
  END IF;
  IF EXISTS (
    WITH RECURSIVE up AS (
      SELECT id, referred_by_member_id, 0 AS depth
        FROM members WHERE id = NEW.referred_by_member_id
      UNION ALL
      SELECT m.id, m.referred_by_member_id, up.depth + 1
        FROM members m JOIN up ON m.id = up.referred_by_member_id
       WHERE up.depth < 64
    )
    SELECT 1 FROM up WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Referral change would create a recruitment cycle';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS members_prevent_referral_cycle ON members;
CREATE TRIGGER members_prevent_referral_cycle
  BEFORE INSERT OR UPDATE OF referred_by_member_id ON members
  FOR EACH ROW EXECUTE FUNCTION fn_prevent_referral_cycle();

-- ---------- Feature module registration (module registry, migration 016) ----------
-- `recruitment` owns recruitment:read + recruitment:report (see
-- backend/src/auth/permissions.ts MODULE_PERMISSIONS). Seeded enabled=TRUE for
-- every applicable role (each holds ≥1 of the module's permissions); an
-- applicable-but-unseeded cell defaults to enabled, so this only makes the
-- registry's initial state explicit — it strips nothing.
INSERT INTO modules (key, label, description, sort) VALUES
  ('recruitment', 'Recruitment', 'Recruitment genealogy: referral links, the member recruitment tree, lineage-to-source and the national growth report.', 95)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_module_gates (role, module_key, enabled) VALUES
  ('national_admin',     'recruitment', TRUE),
  ('regional_organizer', 'recruitment', TRUE),
  ('local_coordinator',  'recruitment', TRUE),
  ('ward_councillor',    'recruitment', TRUE),
  ('analyst',            'recruitment', TRUE),
  ('member',             'recruitment', TRUE)
ON CONFLICT (role, module_key) DO NOTHING;

-- ---------- Kill-switch flags (PRD-growth Appendix C) ----------
INSERT INTO feature_flags (key, enabled, description) VALUES
  ('recruitment.tree',   true, 'Members/staff may view the recruitment tree + trace to source (FR-O4/O5).'),
  ('recruitment.report', true, 'Leadership may view the ranked recruitment growth report (FR-O6).')
ON CONFLICT (key) DO NOTHING;
