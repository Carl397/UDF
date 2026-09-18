-- ============================================================
-- 007_jobs.sql — Ward Job Interest Register & Opportunity Relay (PRD-jobs).
-- Adds: work-type taxonomy, member job-interest register (minimal PII),
-- ward demand rollup (aggregates only), opportunities, delivery stats and an
-- INTERNAL relay outbox (never exposed by any API).
-- POPIA: job_interests holds ONLY name + email + work types + experience.
-- No CV / document / photo columns exist by design (PRD-jobs NG1).
-- Idempotent: safe to run multiple times.
-- ============================================================

-- ---------- Work-type taxonomy (national-owned, editable) ----------
CREATE TABLE IF NOT EXISTS work_types (
  code   TEXT PRIMARY KEY,
  label  TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  sort   INTEGER NOT NULL DEFAULT 0
);

INSERT INTO work_types (code, label, sort) VALUES
  ('labourer',     'General labourer',   1),
  ('catering',     'Catering',           2),
  ('cleaning',     'Cleaning',           3),
  ('security',     'Security',           4),
  ('driving',      'Driving / delivery', 5),
  ('construction', 'Construction',       6),
  ('plumbing',     'Plumbing',           7),
  ('electrical',   'Electrical',         8),
  ('painting',     'Painting',           9),
  ('gardening',    'Gardening / grounds',10),
  ('retail',       'Retail',            11),
  ('admin',        'Admin / clerical',  12),
  ('healthcare',   'Healthcare',        13),
  ('teaching',     'Teaching / tutoring',14),
  ('it',           'IT / digital',      15),
  ('other',        'Other',             16)
ON CONFLICT (code) DO NOTHING;

-- ---------- Member job-interest register (FR-K) ----------
-- One ACTIVE row per member (partial unique index). Withdrawal hard-deletes.
CREATE TABLE IF NOT EXISTS job_interests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ward_code   TEXT NOT NULL REFERENCES regions(code) ON DELETE CASCADE,
  region_code TEXT REFERENCES regions(code) ON DELETE SET NULL,
  first_name  TEXT NOT NULL,
  surname     TEXT NOT NULL,
  -- Communication-only. Never exposed except to the owner; never aggregated
  -- with identity; hard-deleted on withdrawal.
  email       TEXT NOT NULL,
  work_types  TEXT[] NOT NULL DEFAULT '{}',
  experience  TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ji_status_chk CHECK (status IN ('active','withdrawn')),
  CONSTRAINT ji_experience_len CHECK (experience IS NULL OR char_length(experience) <= 240),
  CONSTRAINT ji_work_types_nonempty CHECK (array_length(work_types, 1) >= 1)
);
-- Only one active interest per member.
CREATE UNIQUE INDEX IF NOT EXISTS ji_member_active_uniq
  ON job_interests (member_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ji_ward_status_idx ON job_interests (ward_code, status);
CREATE INDEX IF NOT EXISTS ji_region_idx ON job_interests (region_code);
CREATE INDEX IF NOT EXISTS ji_work_types_gin ON job_interests USING GIN (work_types);

-- ---------- Ward demand rollup (FR-L: aggregates only, no personal rows) ----------
-- work_type '*' stores the DISTINCT active-member count for the ward/day.
CREATE TABLE IF NOT EXISTS job_demand_daily (
  ward_code    TEXT NOT NULL REFERENCES regions(code) ON DELETE CASCADE,
  region_code  TEXT REFERENCES regions(code) ON DELETE SET NULL,
  work_type    TEXT NOT NULL,
  day          DATE NOT NULL DEFAULT CURRENT_DATE,
  active_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ward_code, work_type, day)
);
CREATE INDEX IF NOT EXISTS jdd_day_idx ON job_demand_daily (day DESC);
CREATE INDEX IF NOT EXISTS jdd_region_idx ON job_demand_daily (region_code);

-- ---------- Opportunities (FR-M) ----------
CREATE TABLE IF NOT EXISTS job_opportunities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no        TEXT NOT NULL UNIQUE,
  ward_code     TEXT NOT NULL REFERENCES regions(code) ON DELETE CASCADE,
  region_code   TEXT REFERENCES regions(code) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  company       TEXT NOT NULL,
  work_types    TEXT[] NOT NULL DEFAULT '{}',
  description   TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  contact_url   TEXT,
  project_id    UUID REFERENCES projects(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at  TIMESTAMPTZ,
  closes_at     DATE,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jo_status_chk CHECK (status IN ('draft','published','closed','expired')),
  CONSTRAINT jo_desc_len CHECK (description IS NULL OR char_length(description) <= 600),
  CONSTRAINT jo_contact_present CHECK (
    contact_email IS NOT NULL OR contact_phone IS NOT NULL OR contact_url IS NOT NULL
  ),
  CONSTRAINT jo_work_types_nonempty CHECK (array_length(work_types, 1) >= 1)
);
CREATE INDEX IF NOT EXISTS jo_ward_status_idx ON job_opportunities (ward_code, status);
CREATE INDEX IF NOT EXISTS jo_region_idx ON job_opportunities (region_code);
CREATE INDEX IF NOT EXISTS jo_work_types_gin ON job_opportunities USING GIN (work_types);
CREATE INDEX IF NOT EXISTS jo_status_idx ON job_opportunities (status);

-- ---------- Delivery stats (FR-M4: counts only, no recipient rows) ----------
CREATE TABLE IF NOT EXISTS job_opportunity_stats (
  opportunity_id UUID PRIMARY KEY REFERENCES job_opportunities(id) ON DELETE CASCADE,
  matched        INTEGER NOT NULL DEFAULT 0,
  notified_inapp INTEGER NOT NULL DEFAULT 0,
  emailed        INTEGER NOT NULL DEFAULT 0,
  email_failed   INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- INTERNAL relay outbox (dev email capture; NEVER exposed) ----------
-- Transient recipient list used to send + count the relay. No API returns it.
CREATE TABLE IF NOT EXISTS job_relay_outbox (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES job_opportunities(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel        TEXT NOT NULL,
  to_email       TEXT,
  status         TEXT NOT NULL DEFAULT 'queued',
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jro_channel_chk CHECK (channel IN ('inapp','email')),
  CONSTRAINT jro_status_chk CHECK (status IN ('queued','sent','failed'))
);
CREATE INDEX IF NOT EXISTS jro_opp_idx ON job_relay_outbox (opportunity_id);
