-- ---------- Patrol ward entries (GPS-derived ward crossings) ----------
-- Each saved track point is resolved against the ward geometry and the ward it
-- falls in is recorded here (the patrol's own ward included). Rows with a
-- ward_code different from the patrol's ward_code are the crossings: a patrol
-- that walked over into a neighbouring ward shows up as live in that ward.
-- ward_code resolves to NULL if the region is later removed, so history is
-- kept readable without blocking region edits.
CREATE TABLE IF NOT EXISTS patrol_ward_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patrol_id     UUID NOT NULL REFERENCES patrols(id) ON DELETE CASCADE,
  ward_code     TEXT NOT NULL REFERENCES regions(code) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  point_count   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (patrol_id, ward_code)
);
CREATE INDEX IF NOT EXISTS pwe_patrol_idx ON patrol_ward_entries (patrol_id);
CREATE INDEX IF NOT EXISTS pwe_ward_idx   ON patrol_ward_entries (ward_code);
