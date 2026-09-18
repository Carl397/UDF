-- ============================================================
-- 001_init.sql — Party platform base schema (PostgreSQL + PostGIS)
-- Idempotent: safe to run multiple times.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------- Enumerations ----------
DO $$ BEGIN
  CREATE TYPE member_tier AS ENUM
    ('voter','volunteer','activist','donor','candidate','staff');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE member_status AS ENUM
    ('active','inactive','lapsed','suspended','pending');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Users (authentication / staff accounts) ----------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lookup by email uses a blind index (HMAC), so the raw email need not be
  -- stored in the clear. The sealed email lives in sealed_pii.
  email_bidx    BYTEA UNIQUE,               -- HMAC-SHA256(lower(email), blind_key)
  password_hash TEXT NOT NULL,              -- argon2id
  role          TEXT NOT NULL DEFAULT 'member',
  region_codes  TEXT[] NOT NULL DEFAULT '{}', -- empty => national scope
  sealed_pii    JSONB,                       -- { wrappedDek, keyId, fields:{email,...} }
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Regions (for map layers / choropleth / scoping) ----------
CREATE TABLE IF NOT EXISTS regions (
  code        TEXT PRIMARY KEY,             -- e.g. 'US-CA' or party constituency code
  name        TEXT NOT NULL,
  parent_code TEXT REFERENCES regions(code) ON DELETE SET NULL,
  level       TEXT NOT NULL DEFAULT 'region', -- country|region|district|ward
  geom        GEOMETRY(MultiPolygon, 4326),  -- boundary for choropleth
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS regions_geom_idx ON regions USING GIST (geom);

-- ---------- Members ----------
CREATE TABLE IF NOT EXISTS members (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_no  TEXT UNIQUE,
  tier           member_tier NOT NULL DEFAULT 'voter',
  status         member_status NOT NULL DEFAULT 'pending',
  region_code    TEXT REFERENCES regions(code) ON DELETE SET NULL,
  district_code  TEXT,

  -- Geographic location for map / heat map.
  location       GEOGRAPHY(Point, 4326),
  -- Numeric weight driving heat-map intensity (engagement/donation/turnout).
  heat_weight    NUMERIC NOT NULL DEFAULT 1,

  -- Layer-3 sealed PII: { wrappedDek, keyId, fields:{email,phone,address,...} }
  sealed_pii     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Blind index for deterministic lookup without decryption.
  email_bidx     BYTEA,
  phone_bidx     BYTEA,

  tags           TEXT[] NOT NULL DEFAULT '{}',
  notes_cipher   TEXT,                       -- optional sealed free-text
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ                 -- soft delete / right-to-erasure
);
CREATE INDEX IF NOT EXISTS members_region_idx   ON members (region_code);
CREATE INDEX IF NOT EXISTS members_district_idx ON members (district_code);
CREATE INDEX IF NOT EXISTS members_status_idx   ON members (status);
CREATE INDEX IF NOT EXISTS members_tier_idx     ON members (tier);
CREATE INDEX IF NOT EXISTS members_location_idx ON members USING GIST (location);
CREATE INDEX IF NOT EXISTS members_email_bidx   ON members (email_bidx);
CREATE INDEX IF NOT EXISTS members_tags_idx     ON members USING GIN (tags);

-- ---------- Consent / data-subject preferences ----------
CREATE TABLE IF NOT EXISTS member_consents (
  member_id   UUID PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  email_optin BOOLEAN NOT NULL DEFAULT FALSE,
  sms_optin   BOOLEAN NOT NULL DEFAULT FALSE,
  phone_optin BOOLEAN NOT NULL DEFAULT FALSE,
  data_share  BOOLEAN NOT NULL DEFAULT FALSE,  -- share with affiliated orgs
  gdpr_basis  TEXT,                            -- consent|contract|legitimate_interest
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Refresh tokens (revocable) ----------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,           -- SHA-256(token); never store raw
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip         INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);

-- ---------- Append-only, hash-chained audit log ----------
CREATE TABLE IF NOT EXISTS audit_log (
  seq         BIGSERIAL PRIMARY KEY,
  id          UUID NOT NULL UNIQUE,
  prev_hash   CHAR(64) NOT NULL,
  entry_hash  CHAR(64) NOT NULL,
  action      TEXT NOT NULL,
  actor_id    UUID,
  actor_role  TEXT,
  target_type TEXT,
  target_id   TEXT,
  region_code TEXT,
  metadata    JSONB,
  ip          INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_action_idx  ON audit_log (action);
CREATE INDEX IF NOT EXISTS audit_actor_idx   ON audit_log (actor_id);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log (created_at);

-- ---------- Migration bookkeeping ----------
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- updated_at trigger ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS members_updated_at ON members;
CREATE TRIGGER members_updated_at BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS member_consents_updated_at ON member_consents;
CREATE TRIGGER member_consents_updated_at BEFORE UPDATE ON member_consents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
