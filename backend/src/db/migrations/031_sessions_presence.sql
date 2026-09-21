-- Live-user presence.
--
-- The SuperAdmin dashboard shows "how many users are live" without a separate
-- sessions table: a refresh token IS a session, so presence is tracked as a
-- throttled `last_seen_at` bump on the token row. "Live" = a non-revoked,
-- unexpired token seen inside the presence window (default 5 minutes). The
-- optional device_id lets the dashboard break live users down by device without
-- reading the user_agent string on the hot path.
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_ip INET,
  ADD COLUMN IF NOT EXISTS device_id TEXT;

-- Presence query is `WHERE revoked_at IS NULL AND expires_at > now() AND
-- last_seen_at > now() - interval '5 min'`, grouped by user_id/device_id.
CREATE INDEX IF NOT EXISTS refresh_tokens_presence_idx
  ON refresh_tokens (last_seen_at)
  WHERE revoked_at IS NULL;
