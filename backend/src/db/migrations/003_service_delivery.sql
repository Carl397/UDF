-- ============================================================
-- 003_service_delivery.sql — Service-delivery, public participation,
-- ward bulletins, patrols, ratings, projects, petitions, documents,
-- leadership directory, enquiries, marketing.
-- Idempotent: safe to run multiple times.
-- ============================================================

-- ---------- Enumerations ----------
DO $$ BEGIN
  CREATE TYPE sr_status AS ENUM
    ('reported','triaged','logged','submitted','in_progress',
     'resolved','verified','closed','escalated','duplicate','reopened');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sr_category AS ENUM
    ('water','power','roads','sanitation','housing','safety','health','education','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE bulletin_kind AS ENUM
    ('news','vacancy','completed_work','vote','announcement');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE project_stage AS ENUM
    ('idea','concept','approved','funded','in_progress','delivered','blocked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE patrol_mode AS ENUM ('walk','drive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE patrol_status AS ENUM ('planned','active','completed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE engagement_type AS ENUM
    ('meeting','site_visit','complaint_escalation','home_visit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE engagement_status AS ENUM
    ('requested','acknowledged','scheduled','completed','declined');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE participation_scope AS ENUM ('ward','region','metro','national');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE participation_status AS ENUM ('open','closed','submitted','answered');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE petition_status AS ENUM ('open','closed','submitted','answered');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE verification_verdict AS ENUM ('fixed','not_fixed','partial');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE vacancy_type AS ENUM ('job','tender','public_participation');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE document_category AS ENUM
    ('constitution','manifesto','petition_form','policy','ward_structure','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE capture_mode AS ENUM ('photo','video','voice_note','audio');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rating_target_type AS ENUM ('service_request','councillor','project');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE petition_target AS ENUM ('municipality','province','national');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE project_scope AS ENUM ('ward','district','region','national');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE marketing_status AS ENUM ('draft','active','completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Media assets (photos, video, audio — with EXIF + reverse geocode) ----------
CREATE TABLE IF NOT EXISTS media_assets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key       TEXT NOT NULL,
  content_type      TEXT NOT NULL,             -- image/jpeg | video/mp4 | audio/m4a | audio/ogg
  capture_mode      capture_mode NOT NULL DEFAULT 'photo',
  exif_geo          GEOGRAPHY(Point, 4326),
  exif_time         TIMESTAMPTZ,
  accuracy_m        NUMERIC,                   -- GPS accuracy (target: 2-3m)
  street_address    TEXT,                      -- reverse geocoded from exif_geo
  duration_seconds  INTEGER,                   -- for video/audio
  hash              CHAR(64) NOT NULL,         -- SHA-256 integrity hash
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_assets_geo_idx ON media_assets USING GIST (exif_geo);
CREATE INDEX IF NOT EXISTS media_assets_hash_idx ON media_assets (hash);

-- ---------- Documents library (constitution, manifesto, petition forms, policies) ----------
CREATE TABLE IF NOT EXISTS documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  category      document_category NOT NULL DEFAULT 'other',
  version       TEXT,
  storage_key   TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'application/pdf',
  published     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Ward profiles (councillor seat, municipality, scorecard cache) ----------
-- Ward rows live in `regions` with level='ward'. This table adds ward-specific metadata.
CREATE TABLE IF NOT EXISTS ward_profiles (
  ward_code             TEXT PRIMARY KEY REFERENCES regions(code) ON DELETE CASCADE,
  municipality          TEXT NOT NULL DEFAULT '',
  councillor_member_id  UUID REFERENCES members(id) ON DELETE SET NULL,
  population            INTEGER,
  registered_voters     INTEGER,
  scorecard_cache       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Leadership directory (president, mayoral candidate, councillors) ----------
CREATE TABLE IF NOT EXISTS leaders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id       UUID REFERENCES members(id) ON DELETE SET NULL,
  position_code   TEXT REFERENCES positions(code) ON DELETE SET NULL,
  ward_code       TEXT REFERENCES regions(code) ON DELETE SET NULL,
  region_code     TEXT REFERENCES regions(code) ON DELETE SET NULL,
  photo_id        UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  full_name       TEXT NOT NULL,
  bio             TEXT,
  contact_public  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {whatsapp, email, phone}
  socials         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {twitter, facebook, instagram}
  is_public       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leaders_ward_idx ON leaders (ward_code);
CREATE INDEX IF NOT EXISTS leaders_region_idx ON leaders (region_code);

-- ---------- Service requests (the core of service delivery) ----------
CREATE TABLE IF NOT EXISTS service_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no              TEXT UNIQUE NOT NULL,       -- UDF-W09-000123
  category            sr_category NOT NULL DEFAULT 'other',
  severity            TEXT NOT NULL DEFAULT 'report', -- info|report|urgent
  title               TEXT NOT NULL,
  description         TEXT,
  status              sr_status NOT NULL DEFAULT 'reported',
  location            GEOGRAPHY(Point, 4326),
  street_address      TEXT,                       -- reverse geocoded
  ward_code           TEXT REFERENCES regions(code) ON DELETE SET NULL,
  reporter_member_id  UUID REFERENCES members(id) ON DELETE SET NULL,
  reporter_sealed     JSONB,                      -- sealed PII for anonymous reporters
  councillor_member_id UUID REFERENCES members(id) ON DELETE SET NULL,
  municipality_ref    TEXT,                       -- municipal CRM reference
  municipal_confirm   UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  sla_due_at          TIMESTAMPTZ,
  report_count        INTEGER NOT NULL DEFAULT 1, -- duplicate merge count
  merged_into         UUID REFERENCES service_requests(id) ON DELETE SET NULL,
  resolved_at         TIMESTAMPTZ,
  verified_at         TIMESTAMPTZ,
  closed_at           TIMESTAMPTZ,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sr_ref_idx ON service_requests (ref_no);
CREATE INDEX IF NOT EXISTS sr_status_idx ON service_requests (status);
CREATE INDEX IF NOT EXISTS sr_ward_idx ON service_requests (ward_code);
CREATE INDEX IF NOT EXISTS sr_category_idx ON service_requests (category);
CREATE INDEX IF NOT EXISTS sr_reporter_idx ON service_requests (reporter_member_id);
CREATE INDEX IF NOT EXISTS sr_councillor_idx ON service_requests (councillor_member_id);
CREATE INDEX IF NOT EXISTS sr_location_idx ON service_requests USING GIST (location);
CREATE INDEX IF NOT EXISTS sr_sla_idx ON service_requests (sla_due_at) WHERE status NOT IN ('verified','closed','duplicate');

-- ---------- Service request events (append-only timeline) ----------
CREATE TABLE IF NOT EXISTS service_request_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id    UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  from_status           sr_status,
  to_status             sr_status NOT NULL,
  actor_member_id       UUID REFERENCES members(id) ON DELETE SET NULL,
  actor_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  note                  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sre_sr_idx ON service_request_events (service_request_id);
CREATE INDEX IF NOT EXISTS sre_created_idx ON service_request_events (created_at DESC);

-- ---------- Service request ↔ media links ----------
CREATE TABLE IF NOT EXISTS service_request_media (
  service_request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  media_asset_id     UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service_request_id, media_asset_id)
);

-- ---------- Public participations (ward-scoped resident input) ----------
CREATE TABLE IF NOT EXISTS public_participations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  subject       TEXT,
  body          TEXT,
  scope         participation_scope NOT NULL DEFAULT 'ward',
  ward_code     TEXT REFERENCES regions(code) ON DELETE SET NULL,
  region_code   TEXT REFERENCES regions(code) ON DELETE SET NULL,
  opens_at      TIMESTAMPTZ NOT NULL,
  closes_at     TIMESTAMPTZ NOT NULL,
  status        participation_status NOT NULL DEFAULT 'open',
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pp_ward_idx ON public_participations (ward_code);
CREATE INDEX IF NOT EXISTS pp_status_idx ON public_participations (status);
CREATE INDEX IF NOT EXISTS pp_opens_idx ON public_participations (opens_at DESC);

-- ---------- Participation comments (structured resident input) ----------
CREATE TABLE IF NOT EXISTS participation_comments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participation_id  UUID NOT NULL REFERENCES public_participations(id) ON DELETE CASCADE,
  member_id         UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  ward_code         TEXT REFERENCES regions(code) ON DELETE SET NULL,
  comment           TEXT NOT NULL,
  rating            INTEGER CHECK (rating BETWEEN 1 AND 5),
  reason_if_low     TEXT,                       -- mandatory if rating <= 2
  event_timestamp   TIMESTAMPTZ,                -- when something happened (if not current)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pc_participation_idx ON participation_comments (participation_id);
CREATE INDEX IF NOT EXISTS pc_member_idx ON participation_comments (member_id);

-- ---------- Ratings (1-5 scale on councillor work, cases, projects) ----------
CREATE TABLE IF NOT EXISTS ratings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type   rating_target_type NOT NULL,
  target_id     UUID NOT NULL,
  member_id     UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  reason        TEXT,                           -- mandatory if rating <= 2
  event_timestamp TIMESTAMPTZ,                  -- when something happened
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS ratings_target_idx ON ratings (target_type, target_id);
CREATE INDEX IF NOT EXISTS ratings_member_idx ON ratings (member_id);

-- ---------- Verifications (member follow-up on closed cases) ----------
CREATE TABLE IF NOT EXISTS verifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id  UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  member_id           UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  verdict             verification_verdict NOT NULL,
  photo_id            UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  note                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_request_id, member_id)
);
CREATE INDEX IF NOT EXISTS verifications_sr_idx ON verifications (service_request_id);

-- ---------- Projects (ward & metro programme) ----------
CREATE TABLE IF NOT EXISTS projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  description   TEXT,
  scope         project_scope NOT NULL DEFAULT 'ward',
  ward_code     TEXT REFERENCES regions(code) ON DELETE SET NULL,
  region_code   TEXT REFERENCES regions(code) ON DELETE SET NULL,
  stage         project_stage NOT NULL DEFAULT 'idea',
  progress_pct  INTEGER CHECK (progress_pct BETWEEN 0 AND 100),
  budget        NUMERIC,
  owner         TEXT,
  is_published  BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_ward_idx ON projects (ward_code);
CREATE INDEX IF NOT EXISTS projects_stage_idx ON projects (stage);
CREATE INDEX IF NOT EXISTS projects_scope_idx ON projects (scope);

-- ---------- Project milestones ----------
CREATE TABLE IF NOT EXISTS project_milestones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  due_date    DATE,
  completed_at TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|in_progress|done|blocked
  seq         INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pm_project_idx ON project_milestones (project_id);

-- ---------- Project votes (resident voting on projects) ----------
CREATE TABLE IF NOT EXISTS project_votes (
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_id   UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  vote        TEXT NOT NULL,  -- for|against|abstain
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, member_id)
);

-- ---------- Petitions ----------
CREATE TABLE IF NOT EXISTS petitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  body            TEXT,
  target          petition_target NOT NULL DEFAULT 'municipality',
  scope           participation_scope NOT NULL DEFAULT 'ward',
  ward_code       TEXT REFERENCES regions(code) ON DELETE SET NULL,
  region_code     TEXT REFERENCES regions(code) ON DELETE SET NULL,
  opens_at        TIMESTAMPTZ,
  closes_at       TIMESTAMPTZ,
  signature_goal  INTEGER,
  status          petition_status NOT NULL DEFAULT 'open',
  document_id     UUID REFERENCES documents(id) ON DELETE SET NULL,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS petitions_ward_idx ON petitions (ward_code);
CREATE INDEX IF NOT EXISTS petitions_status_idx ON petitions (status);

-- ---------- Petition signatures ----------
CREATE TABLE IF NOT EXISTS petition_signatures (
  petition_id UUID NOT NULL REFERENCES petitions(id) ON DELETE CASCADE,
  member_id   UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  ward_code   TEXT REFERENCES regions(code) ON DELETE SET NULL,
  signed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (petition_id, member_id)
);

-- ---------- Patrols (councillor oversight walks) ----------
CREATE TABLE IF NOT EXISTS patrols (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  councillor_member_id  UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  ward_code             TEXT REFERENCES regions(code) ON DELETE SET NULL,
  mode                  patrol_mode NOT NULL DEFAULT 'walk',
  purpose               TEXT,                     -- oversight|fault_visit|community_meeting|canvass
  planned_route         JSONB,                    -- GeoJSON LineString
  planned_date          DATE,
  started_at            TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  distance_m            NUMERIC,
  summary               TEXT,
  status                patrol_status NOT NULL DEFAULT 'planned',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS patrols_councillor_idx ON patrols (councillor_member_id);
CREATE INDEX IF NOT EXISTS patrols_ward_idx ON patrols (ward_code);
CREATE INDEX IF NOT EXISTS patrols_status_idx ON patrols (status);
CREATE INDEX IF NOT EXISTS patrols_date_idx ON patrols (planned_date DESC);

-- ---------- Patrol track points (GPS breadcrumb) ----------
CREATE TABLE IF NOT EXISTS patrol_track_points (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patrol_id   UUID NOT NULL REFERENCES patrols(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  location    GEOGRAPHY(Point, 4326) NOT NULL,
  accuracy_m  NUMERIC,                        -- GPS accuracy (target: 2-3m)
  speed       NUMERIC,
  street_address TEXT,                        -- reverse geocoded
  recorded_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS ptp_patrol_idx ON patrol_track_points (patrol_id);
CREATE INDEX IF NOT EXISTS ptp_location_idx ON patrol_track_points USING GIST (location);

-- ---------- Patrol stops (linked to service requests) ----------
CREATE TABLE IF NOT EXISTS patrol_stops (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patrol_id           UUID NOT NULL REFERENCES patrols(id) ON DELETE CASCADE,
  location            GEOGRAPHY(Point, 4326) NOT NULL,
  street_address      TEXT,
  service_request_id  UUID REFERENCES service_requests(id) ON DELETE SET NULL,
  note                TEXT,
  photo_id            UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  arrived_at          TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS ps_patrol_idx ON patrol_stops (patrol_id);

-- ---------- Engagement requests (member asks for councillor time) ----------
CREATE TABLE IF NOT EXISTS engagement_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id             UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  councillor_member_id  UUID REFERENCES members(id) ON DELETE SET NULL,
  type                  engagement_type NOT NULL,
  preferred_slots       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{date, time_range}]
  ward_code             TEXT REFERENCES regions(code) ON DELETE SET NULL,
  status                engagement_status NOT NULL DEFAULT 'requested',
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS er_member_idx ON engagement_requests (member_id);
CREATE INDEX IF NOT EXISTS er_councillor_idx ON engagement_requests (councillor_member_id);
CREATE INDEX IF NOT EXISTS er_status_idx ON engagement_requests (status);

-- ---------- Ward bulletins (councillor's ward-specific news feed) ----------
CREATE TABLE IF NOT EXISTS ward_bulletins (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ward_code               TEXT NOT NULL REFERENCES regions(code) ON DELETE CASCADE,
  councillor_member_id    UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind                    bulletin_kind NOT NULL DEFAULT 'news',
  title                   TEXT NOT NULL,
  body                    TEXT,
  -- Linked entities (optional, depending on kind)
  service_request_id      UUID REFERENCES service_requests(id) ON DELETE SET NULL,
  public_participation_id UUID REFERENCES public_participations(id) ON DELETE SET NULL,
  project_id              UUID REFERENCES projects(id) ON DELETE SET NULL,
  -- Vacancy metadata
  vacancy_type            vacancy_type,
  vacancy_deadline        DATE,
  vacancy_contact         JSONB,
  -- Status / moderation
  status                  TEXT NOT NULL DEFAULT 'published',  -- draft|published|taken_down
  take_down_reason        TEXT,
  taken_down_at           TIMESTAMPTZ,
  taken_down_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wb_ward_idx ON ward_bulletins (ward_code);
CREATE INDEX IF NOT EXISTS wb_kind_idx ON ward_bulletins (kind);
CREATE INDEX IF NOT EXISTS wb_status_idx ON ward_bulletins (status);
CREATE INDEX IF NOT EXISTS wb_published_idx ON ward_bulletins (published_at DESC);

-- ---------- Enquiries (non-member leads — "I need more information") ----------
CREATE TABLE IF NOT EXISTS enquiries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  ward_code   TEXT REFERENCES regions(code) ON DELETE SET NULL,
  subject     TEXT NOT NULL,
  message     TEXT NOT NULL,
  source      TEXT,                           -- website|qr|referral|walk_in
  status      TEXT NOT NULL DEFAULT 'new',    -- new|contacted|converted|closed
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enquiries_status_idx ON enquiries (status);
CREATE INDEX IF NOT EXISTS enquiries_ward_idx ON enquiries (ward_code);

-- ---------- Marketing campaigns ----------
CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title             TEXT NOT NULL,
  description       TEXT,
  target_audience   JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {wards, tiers, regions}
  start_date        DATE,
  end_date          DATE,
  status            marketing_status NOT NULL DEFAULT 'draft',
  promoted_documents UUID[] NOT NULL DEFAULT '{}',
  promoted_events   UUID[] NOT NULL DEFAULT '{}',
  engagement_metrics JSONB NOT NULL DEFAULT '{}'::jsonb, -- {clicks, shares, conversions}
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Triggers ----------
DROP TRIGGER IF EXISTS projects_updated_at ON projects;
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS patrols_updated_at ON patrols;
CREATE TRIGGER patrols_updated_at BEFORE UPDATE ON patrols
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS ward_bulletins_updated_at ON ward_bulletins;
CREATE TRIGGER ward_bulletins_updated_at BEFORE UPDATE ON ward_bulletins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS engagement_requests_updated_at ON engagement_requests;
CREATE TRIGGER engagement_requests_updated_at BEFORE UPDATE ON engagement_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS public_participations_updated_at ON public_participations;
CREATE TRIGGER public_participations_updated_at BEFORE UPDATE ON public_participations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS petitions_updated_at ON petitions;
CREATE TRIGGER petitions_updated_at BEFORE UPDATE ON petitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS enquiries_updated_at ON enquiries;
CREATE TRIGGER enquiries_updated_at BEFORE UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS marketing_campaigns_updated_at ON marketing_campaigns;
CREATE TRIGGER marketing_campaigns_updated_at BEFORE UPDATE ON marketing_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS ward_profiles_updated_at ON ward_profiles;
CREATE TRIGGER ward_profiles_updated_at BEFORE UPDATE ON ward_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS leaders_updated_at ON leaders;
CREATE TRIGGER leaders_updated_at BEFORE UPDATE ON leaders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS service_requests_updated_at ON service_requests;
CREATE TRIGGER service_requests_updated_at BEFORE UPDATE ON service_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
