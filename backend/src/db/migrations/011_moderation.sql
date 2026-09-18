-- Phase 4: Terms & Conditions acceptance, moderation ladder (warn/suspend/ban),
-- immediate token revocation, and device bans.

-- ── users: moderation state, immediate-revocation counter, T&C acceptance ──
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version    INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tc_version       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tc_accepted_at   TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_moderation_status_chk;
  ALTER TABLE users ADD CONSTRAINT users_moderation_status_chk
    CHECK (moderation_status IN ('active','warned','suspended','banned'));
END $$;

CREATE INDEX IF NOT EXISTS users_moderation_idx ON users (moderation_status);

-- Bumping token_version invalidates every already-issued access token for the
-- user (the JWT carries the version it was minted with; authenticate compares).

-- ── members: T&C captured at public registration ──────────────────────────
ALTER TABLE members ADD COLUMN IF NOT EXISTS tc_version     TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS tc_accepted_at TIMESTAMPTZ;

-- ── moderation history (hash-chained audit log is written separately) ─────
CREATE TABLE IF NOT EXISTS moderation_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT,
  action      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  expires_at  TIMESTAMPTZ,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ma_action_chk CHECK
    (action IN ('warn','suspend','ban','reinstate','device_ban','device_unban')),
  CONSTRAINT ma_target_chk CHECK (user_id IS NOT NULL OR device_id IS NOT NULL),
  CONSTRAINT ma_reason_len CHECK (char_length(reason) BETWEEN 1 AND 1000)
);
CREATE INDEX IF NOT EXISTS ma_user_idx   ON moderation_actions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ma_device_idx ON moderation_actions (device_id, created_at DESC);

-- ── banned devices (keyed by the mobile x-device-id) ──────────────────────
CREATE TABLE IF NOT EXISTS banned_devices (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  TEXT NOT NULL UNIQUE,
  reason     TEXT NOT NULL,
  banned_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bd_reason_len CHECK (char_length(reason) BETWEEN 1 AND 1000)
);
CREATE INDEX IF NOT EXISTS bd_active_idx ON banned_devices (device_id) WHERE active;
