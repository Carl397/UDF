-- ============================================================
-- 021_councillor_ratings.sql — Councillor performance scorecards (PRD-growth FR-S, Wave 5 Phase D).
--
-- A member rates THEIR OWN ward councillor every calendar month across five
-- fixed categories (1–5). A score of 1 or 2 is a complaint, so it must carry a
-- reason of at least 100 words explaining what is wrong and how to improve; 3–5
-- need no reason. The councillor sees the reasons aggregated by category,
-- acknowledges them, and the member is notified. Identity stays hidden unless the
-- member opts in (`share_name`).
--
--   rating_category           the five fixed dimensions (FR-S1), a real enum so a
--                             mistyped category is rejected by the database.
--   rating_category_config    national-owned label/order/active per category — an
--                             admin can relabel, reorder or retire one WITHOUT a
--                             migration, but the fixed set lives in the enum.
--   councillor_scorecards     one row per member per calendar month (FR-S2), with
--                             the acknowledgement lifecycle submitted→viewed→
--                             acknowledged (FR-S6) and the share-name opt-in (FR-S7).
--   councillor_scorecard_items the per-category score + reason; UNIQUE per
--                             (scorecard, category). The 100-word rule (FR-S3) is
--                             enforced in the service (modules/scorecards), which
--                             counts words on the trimmed reason — a SQL word-count
--                             CHECK is brittle on empty/whitespace reasons.
--
-- Rollups (FR-S8: per-ward/per-councillor category averages, distribution and the
-- ≤2 reasons queue) are computed LIVE by aggregation over these two tables rather
-- than materialised — the same call Phase A made for the recruitment report
-- (migration 019 walked the tree live instead of building recruitment_rollup). At
-- party scale (a few hundred wards × 12 months × 5 categories) an indexed
-- aggregate is well under the 200 ms budget and can never drift from the source
-- rows. A materialised rollup can be layered on later if the national report needs
-- it; nothing here blocks that.
--
-- The existing item-level `ratings` table (cases/projects/patrols/councillors,
-- migration 003) is UNCHANGED — this is a separate monthly scorecard surface.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ---------- Rating categories (FR-S1) ----------
DO $$ BEGIN
  CREATE TYPE rating_category AS ENUM
    ('accessibility','service_delivery','communication','accountability','presence');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- National-owned taxonomy: label, order and active flag per fixed category. The
-- codes are the enum above (a new category is a code+migration change; retiring or
-- relabelling one is a row update). Seeded once; later edits go through the CRM.
CREATE TABLE IF NOT EXISTS rating_category_config (
  code       rating_category PRIMARY KEY,
  label      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO rating_category_config (code, label, position) VALUES
  ('accessibility',    'Availability & accessibility',     1),
  ('service_delivery', 'Responsiveness to service issues', 2),
  ('communication',    'Communication & feedback',         3),
  ('accountability',   'Accountability & transparency',    4),
  ('presence',         'Ward presence & attendance',       5)
ON CONFLICT (code) DO NOTHING;

-- ---------- Scorecards (FR-S2 / S6 / S7) ----------
CREATE TABLE IF NOT EXISTS councillor_scorecards (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The rating member. CASCADE: exercising the right to erasure removes their
  -- scorecards (the reasons are theirs, not a party record to retain).
  member_id            UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- The councillor being rated, resolved from the ward at submit time. SET NULL
  -- keeps the scorecard if that member row is later erased.
  councillor_member_id UUID REFERENCES members(id) ON DELETE SET NULL,
  -- Ward code (regions.code, level='ward'). Plain text like members.ward /
  -- service_requests.ward_code — no FK, so ward scoping stays a simple equality.
  ward_code            TEXT NOT NULL,
  -- First day of the calendar month this scorecard covers (FR-S2).
  period_month         DATE NOT NULL,
  status               TEXT NOT NULL DEFAULT 'submitted',
  -- FR-S7: reveal the member's identity to the councillor so they can follow up.
  -- Default anonymous.
  share_name           BOOLEAN NOT NULL DEFAULT FALSE,
  ack_note             TEXT,
  ack_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  ack_at               TIMESTAMPTZ,
  viewed_at            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT councillor_scorecards_status_chk
    CHECK (status IN ('submitted','viewed','acknowledged')),
  -- One scorecard per member per calendar month; a re-submit updates it (FR-S2).
  CONSTRAINT councillor_scorecards_period_uq UNIQUE (member_id, period_month)
);
-- Councillor/staff inbox + CRM rollups scan by ward and month.
CREATE INDEX IF NOT EXISTS idx_scorecards_ward_period ON councillor_scorecards (ward_code, period_month);
CREATE INDEX IF NOT EXISTS idx_scorecards_councillor  ON councillor_scorecards (councillor_member_id);
CREATE INDEX IF NOT EXISTS idx_scorecards_status      ON councillor_scorecards (status);

-- ---------- Per-category scores + reasons (FR-S1 / S3) ----------
CREATE TABLE IF NOT EXISTS councillor_scorecard_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scorecard_id UUID NOT NULL REFERENCES councillor_scorecards(id) ON DELETE CASCADE,
  category     rating_category NOT NULL,
  score        INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  -- Free text. Compulsory (≥100 words) when score ≤ 2 — enforced in the service.
  reason       TEXT,
  CONSTRAINT scorecard_items_cat_uq UNIQUE (scorecard_id, category)
);
CREATE INDEX IF NOT EXISTS idx_scorecard_items_scorecard ON councillor_scorecard_items (scorecard_id);
-- The ≤2 reasons queue (FR-S8) filters on low scores across wards.
CREATE INDEX IF NOT EXISTS idx_scorecard_items_low ON councillor_scorecard_items (category, score);

-- ---------- Feature module registration (module registry, migration 016) ----------
-- `scorecards` owns rating:scorecard_write + rating:scorecard_read +
-- rating:acknowledge (see backend/src/auth/permissions.ts MODULE_PERMISSIONS).
-- Seeded enabled=TRUE for every applicable role (each holds ≥1 of the module's
-- permissions); an applicable-but-unseeded cell defaults to enabled, so this only
-- makes the registry's initial state explicit — it strips nothing.
INSERT INTO modules (key, label, description, sort) VALUES
  ('scorecards', 'Scorecards', 'Monthly councillor performance scorecards: member ratings by category, the 100-word reason rule, the acknowledgement lifecycle and the accountability rollups.', 96)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_module_gates (role, module_key, enabled) VALUES
  ('national_admin',     'scorecards', TRUE),
  ('regional_organizer', 'scorecards', TRUE),
  ('local_coordinator',  'scorecards', TRUE),
  ('ward_councillor',    'scorecards', TRUE),
  ('analyst',            'scorecards', TRUE),
  ('member',             'scorecards', TRUE)
ON CONFLICT (role, module_key) DO NOTHING;

-- ---------- Kill-switch flag (PRD-growth Appendix C) ----------
INSERT INTO feature_flags (key, enabled, description) VALUES
  ('rating.scorecard', true, 'Members may rate their ward councillor monthly by category (100-word rule for scores ≤2) and councillors may acknowledge submissions (FR-S1–S9).')
ON CONFLICT (key) DO NOTHING;
