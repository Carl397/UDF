-- ============================================================
-- 041_event_rsvps.sql — Named event attendance, one row per person.
--
-- RSVP used to be anonymous: `POST /events/:id/rsvp` only incremented
-- `events.rsvp_count`, so the backoffice could see that N people were going
-- but never WHO. Organisers planning a rally need the actual list.
--
-- This records an identified RSVP per authenticated account. The UNIQUE
-- (event_id, user_id) constraint is what makes "one per member" a database
-- guarantee rather than a client courtesy — a repeat RSVP is an idempotent
-- no-op (upsert), never a second row or a second count.
--
--   * `user_id`   the logged-in account that RSVP'd (the dedupe key).
--   * `member_id` the linked member row when the account has one, so the
--                 organiser can resolve the party membership number; NULL for
--                 a staff account with no member binding.
--   * `response`  'going' (counts toward capacity) or 'interested' (a softer
--                 signal the organiser can also see). Defaults to 'going'.
--
-- `events.rsvp_count` is kept as the cached total so the public calendar and
-- capacity checks need no join; it is maintained in step with these rows.
-- ============================================================

CREATE TABLE IF NOT EXISTS event_rsvps (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_id  UUID REFERENCES members(id) ON DELETE SET NULL,
  response   TEXT NOT NULL DEFAULT 'going'
               CHECK (response IN ('going','interested')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_rsvps_one_per_person UNIQUE (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS event_rsvps_event_idx ON event_rsvps (event_id, response);
CREATE INDEX IF NOT EXISTS event_rsvps_user_idx  ON event_rsvps (user_id);
