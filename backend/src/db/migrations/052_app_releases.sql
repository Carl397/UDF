-- Immutable artifact identity, separate announcement state and durable audit.
CREATE TABLE app_release_artifacts (
  id text PRIMARY KEY,
  version_code integer NOT NULL UNIQUE CHECK (version_code > 0),
  artifact jsonb NOT NULL,
  CHECK (artifact->>'packageId' = 'com.udf.party'),
  CHECK ((artifact->>'versionCode')::integer = version_code),
  CHECK (id = version_code::text || '-' || (artifact->>'sha256'))
);
CREATE TABLE app_release_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id text NOT NULL UNIQUE REFERENCES app_release_artifacts(id),
  notes text NOT NULL CHECK (length(notes) BETWEEN 1 AND 2000),
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid NOT NULL REFERENCES users(id),
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES users(id),
  CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL))
);
CREATE TABLE app_release_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_id uuid REFERENCES app_release_announcements(id),
  highest_version integer NOT NULL DEFAULT 0
);
INSERT INTO app_release_state(singleton) VALUES (true);
CREATE TABLE app_release_events (
  seq bigserial PRIMARY KEY,
  announcement_id uuid NOT NULL REFERENCES app_release_announcements(id),
  action text NOT NULL CHECK (action IN ('publish', 'withdraw', 'supersede')),
  actor_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION app_release_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'App release artifacts and audit events are immutable';
END;
$$;
CREATE TRIGGER app_release_artifacts_immutable BEFORE UPDATE OR DELETE ON app_release_artifacts
  FOR EACH ROW EXECUTE FUNCTION app_release_immutable();
CREATE TRIGGER app_release_events_immutable BEFORE UPDATE OR DELETE ON app_release_events
  FOR EACH ROW EXECUTE FUNCTION app_release_immutable();
