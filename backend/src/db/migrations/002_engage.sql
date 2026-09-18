-- ============================================================
-- 002_engage.sql — Party engagement layer
-- Events, communications (news / press / highlights / community notes),
-- appointments & mandates (position catalog), notifications, and
-- membership confirmation tokens (public register / mandate links).
-- Idempotent: safe to run multiple times.
-- ============================================================

-- ---------- Enumerations ----------
DO $$ BEGIN
  CREATE TYPE event_kind AS ENUM
    ('rally','meeting','training','canvass','debate','fundraiser','service','webinar');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE event_status AS ENUM
    ('scheduled','live','done','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE post_kind AS ENUM
    ('news','press_release','highlight','statement','community_note','service_delivery');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE post_status AS ENUM ('draft','published','taken_down');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE appointment_status AS ENUM ('proposed','confirmed','revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE member_token_kind AS ENUM ('register','mandate');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Events ----------
CREATE TABLE IF NOT EXISTS events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  kind        event_kind NOT NULL DEFAULT 'rally',
  summary     TEXT,
  body        TEXT,
  region_code TEXT REFERENCES regions(code) ON DELETE SET NULL,
  ward        TEXT,
  venue       TEXT,
  lat         NUMERIC,
  lng         NUMERIC,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ,
  capacity    INTEGER,
  rsvp_count  INTEGER NOT NULL DEFAULT 0,
  status      event_status NOT NULL DEFAULT 'scheduled',
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_starts_idx  ON events (starts_at DESC);
CREATE INDEX IF NOT EXISTS events_region_idx  ON events (region_code);
CREATE INDEX IF NOT EXISTS events_status_idx  ON events (status);

-- ---------- Posts: news, press releases, highlights, statements,
--            community notes / service-delivery reports (take-downable) ----------
CREATE TABLE IF NOT EXISTS posts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           post_kind NOT NULL DEFAULT 'news',
  title          TEXT NOT NULL,
  excerpt        TEXT,
  body           TEXT NOT NULL DEFAULT '',
  region_code    TEXT REFERENCES regions(code) ON DELETE SET NULL,  -- NULL = national
  ward           TEXT,
  author         TEXT,                    -- publishing desk / spokesperson
  service_area   TEXT,                    -- water|power|roads|health|education|sanitation|housing|other
  severity       TEXT,                    -- info|report|urgent
  status         post_status NOT NULL DEFAULT 'published',
  take_down_reason TEXT,                  -- moderation trail for community notes
  taken_down_at  TIMESTAMPTZ,
  taken_down_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_kind_idx    ON posts (kind);
CREATE INDEX IF NOT EXISTS posts_status_idx  ON posts (status);
CREATE INDEX IF NOT EXISTS posts_region_idx  ON posts (region_code);
CREATE INDEX IF NOT EXISTS posts_pub_idx     ON posts (published_at DESC);

-- ---------- Position catalog: roles for various member types ----------
CREATE TABLE IF NOT EXISTS positions (
  code        TEXT PRIMARY KEY,            -- WARD_CHAIR, CANDIDATE, ...
  name        TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'ward',-- national|region|district|ward|branch
  tier        TEXT NOT NULL DEFAULT 'any', -- member tier that typically holds it
  description TEXT,
  term_months INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO positions (code, name, level, tier, description, term_months) VALUES
  ('PRESIDENT',        'Party President',           'national', 'staff',     'National leadership and party mandate holder', 60),
  ('SECRETARY_GENERAL','Secretary General',         'national', 'staff',     'Runs the national secretariat', 60),
  ('SPOKESPERSON',     'National Spokesperson',     'national', 'staff',     'Issues press releases and party statements', 36),
  ('REGIONAL_CHAIR',   'Regional Chairperson',      'region',   'activist',  'Chairs the regional executive committee', 48),
  ('REGIONAL_ORGANIZER','Regional Organizer',       'region',   'activist',  'Coordinates structures and mobilisation', 48),
  ('DISTRICT_COORD',   'District Coordinator',      'district', 'volunteer', 'Links wards to the district executive', 36),
  ('WARD_CHAIR',       'Ward Chairperson',          'ward',     'volunteer', 'Leads the ward branch', 36),
  ('WARD_CANDIDATE',   'Ward Candidate',            'ward',     'candidate', 'Official party candidate for the ward', 60),
  ('BRANCH_SECRETARY', 'Branch Secretary',          'branch',   'volunteer', 'Membership records, minutes and dues', 36),
  ('MOBILIZER',        'Field Mobilizer',           'ward',     'activist',  'Door-to-door canvassing and rallies', 24),
  ('YOUTH_LEAD',       'Youth League Lead',         'region',   'activist',  'Youth structures and campaigns', 36),
  ('WOMEN_LEAD',       'Women League Lead',         'region',   'activist',  'Women structures and campaigns', 36),
  ('OBSERVER',         'Polling Station Observer',  'ward',     'volunteer', 'Election-day monitoring and reporting', 12),
  ('COMMS_OFFICER',    'Communications Officer',    'region',   'staff',     'Regional media, social and community notes', 36)
ON CONFLICT (code) DO NOTHING;

-- ---------- Appointments & mandates ----------
CREATE TABLE IF NOT EXISTS appointments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id           UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  position_code       TEXT REFERENCES positions(code) ON DELETE SET NULL,
  title               TEXT,                        -- display override, e.g. "Ward Candidate — Ward 12"
  region_code         TEXT REFERENCES regions(code) ON DELETE SET NULL,
  ward                TEXT,
  appointed_by        TEXT,                        -- appointing body / officer
  term_start          DATE,
  term_end            DATE,
  status              appointment_status NOT NULL DEFAULT 'proposed',
  mandate_accepted_at TIMESTAMPTZ,                 -- set when the member confirms the mandate
  notes               TEXT,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appointments_member_idx ON appointments (member_id);
CREATE INDEX IF NOT EXISTS appointments_status_idx ON appointments (status);
CREATE INDEX IF NOT EXISTS appointments_region_idx ON appointments (region_code);

-- ---------- Notifications (in-app; user_id NULL = broadcast) ----------
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'info',        -- event|post|appointment|mandate|member|alert|info
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,                                -- in-app deep link, e.g. tab:events#<id>
  region_code TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx    ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications (created_at DESC);

-- Per-user read state, so a broadcast can be read independently by each user.
CREATE TABLE IF NOT EXISTS notification_reads (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notification_id)
);

-- ---------- Membership / mandate confirmation tokens (public links) ----------
CREATE TABLE IF NOT EXISTS member_tokens (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id      UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
  kind           member_token_kind NOT NULL DEFAULT 'register',
  token          TEXT NOT NULL UNIQUE,             -- unguessable link token
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS member_tokens_member_idx ON member_tokens (member_id);

-- ---------- Member additions ----------
ALTER TABLE members ADD COLUMN IF NOT EXISTS public_code TEXT;      -- short public verify code (QR)
ALTER TABLE members ADD COLUMN IF NOT EXISTS ward        TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS joined_at   TIMESTAMPTZ;
ALTER TABLE members ADD COLUMN IF NOT EXISTS referral    TEXT;      -- join-link / QR referrer code
ALTER TABLE members ADD COLUMN IF NOT EXISTS mandate_accepted_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS members_public_code_uidx ON members (public_code) WHERE public_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS members_ward_idx ON members (ward);

DROP TRIGGER IF EXISTS events_updated_at ON events;
CREATE TRIGGER events_updated_at BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS posts_updated_at ON posts;
CREATE TRIGGER posts_updated_at BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS appointments_updated_at ON appointments;
CREATE TRIGGER appointments_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
