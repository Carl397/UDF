-- ============================================================
-- 016_module_registry.sql — Module-based platform (Wave 2 foundation).
--
-- A module is a whole feature surface (Map, Members, Cases, Patrols, …) that a
-- national administrator can enable or disable PER ROLE. Disabling a module
-- strips every permission the module owns from that role's effective set, so
-- its screens hide (the frontend derives capabilities from the permission list)
-- and its API routes return 403 (requirePermission reads the same stripped set)
-- with zero per-route changes. Enforcement folds into effectivePermissions() in
-- backend/src/auth/permissions.ts — the single funnel for login/refresh and the
-- live re-read in the `authenticate` middleware.
--
-- Two tables:
--   modules           the registry: key, human label, description, sort order.
--   role_module_gates the per-role on/off state. A row with enabled=FALSE is the
--                     ONLY thing that disables a module; an applicable role with
--                     no row defaults to enabled, so the matrix never needs a row
--                     to keep working (it needs one only to record a NON-default).
--
-- Seeding: enabled=TRUE is inserted for every (role, module) whose role holds at
-- least one of the module's owned permissions in the base ROLE_PERMISSIONS matrix
-- (the module → permission map lives in permissions.ts, the single source of
-- truth). This makes the registry explicit without changing anyone's access: an
-- enabled gate strips nothing. `id_cards` owns no permission (it is a UI-only
-- surface that rides on member:read), so it is seeded for exactly the roles that
-- hold member:read. Idempotent: safe to run multiple times.
-- ============================================================

-- ---------- Registry ----------
CREATE TABLE IF NOT EXISTS modules (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT,
  sort        INTEGER NOT NULL DEFAULT 0
);

INSERT INTO modules (key, label, description, sort) VALUES
  ('map',        'Map',            'Movement map: geo layers, choropleth, heat and region drill-down.',                 10),
  ('members',    'Members',        'Member directory: read, register, export and decrypt sealed PII.',                   20),
  ('cases',      'Cases',          'Service-delivery cases: log, update, close, escalate and read.',                     30),
  ('patrols',    'Patrols',        'Ward patrols: start, track and read GPS oversight.',                                 40),
  ('reports',    'Reports',        'Resident → councillor reports: submit a report and read the ward inbox.',            50),
  ('engage',     'Engage',         'Engagement: events, mandates/appointments, participation and notifications.',        60),
  ('bulletins',  'Bulletins',      'Ward bulletins: publish and read the ward news feed.',                               70),
  ('newsroom',   'Newsroom',       'Newsroom & press: author posts and moderate community notes.',                       80),
  ('jobs',       'Jobs',           'Ward work & local economy: interest register, demand view and opportunities.',       90),
  ('overview',   'Overview',       'Metro overview & analytics: cross-ward dashboards and generated reports.',          100),
  ('id_cards',   'Party ID cards', 'Party ID cards & QR. UI-only surface that rides on member-directory access.',       110),
  ('moderation', 'Moderation',     'Member moderation ladder: warn, suspend, ban, reinstate and device bans.',          120),
  ('admin',      'Administration', 'Platform administration: roles, audit log, consent and this module registry.',      130)
ON CONFLICT (key) DO NOTHING;

-- ---------- Per-role gates ----------
CREATE TABLE IF NOT EXISTS role_module_gates (
  role        TEXT NOT NULL,
  module_key  TEXT NOT NULL REFERENCES modules(key) ON DELETE CASCADE,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role, module_key)
);
CREATE INDEX IF NOT EXISTS role_module_gates_role_idx ON role_module_gates (role);

-- Seeded enabled=TRUE for every applicable (role, module) — see the header for
-- the applicability rule. `enabled=TRUE` strips nothing, so access is unchanged
-- until an administrator toggles a cell in CRM → Settings → Module registry.
INSERT INTO role_module_gates (role, module_key, enabled) VALUES
  -- map: geo:read holders (member gains geo:read_own_ward in Wave 4; until then
  -- it holds no map permission, so it is not seeded here — the matrix defaults
  -- an applicable-but-unseeded cell to enabled and can still toggle it).
  ('national_admin',     'map',        TRUE),
  ('regional_organizer', 'map',        TRUE),
  ('local_coordinator',  'map',        TRUE),
  ('ward_councillor',    'map',        TRUE),
  ('analyst',            'map',        TRUE),
  -- members: member:read/write/delete/export/pii_decrypt holders.
  ('national_admin',     'members',    TRUE),
  ('regional_organizer', 'members',    TRUE),
  ('local_coordinator',  'members',    TRUE),
  ('ward_councillor',    'members',    TRUE),
  -- cases: case:log/update/close/escalate/read holders (analyst + member read).
  ('national_admin',     'cases',      TRUE),
  ('regional_organizer', 'cases',      TRUE),
  ('local_coordinator',  'cases',      TRUE),
  ('ward_councillor',    'cases',      TRUE),
  ('analyst',            'cases',      TRUE),
  ('member',             'cases',      TRUE),
  -- patrols: patrol:write/read holders (member reads).
  ('national_admin',     'patrols',    TRUE),
  ('regional_organizer', 'patrols',    TRUE),
  ('local_coordinator',  'patrols',    TRUE),
  ('ward_councillor',    'patrols',    TRUE),
  ('member',             'patrols',    TRUE),
  -- reports: report:write (member + 4 staff) / report:read (4 staff) holders.
  ('national_admin',     'reports',    TRUE),
  ('regional_organizer', 'reports',    TRUE),
  ('local_coordinator',  'reports',    TRUE),
  ('ward_councillor',    'reports',    TRUE),
  ('member',             'reports',    TRUE),
  -- engage: event/appoint/participation/engagement/notify write holders.
  ('national_admin',     'engage',     TRUE),
  ('regional_organizer', 'engage',     TRUE),
  ('local_coordinator',  'engage',     TRUE),
  ('ward_councillor',    'engage',     TRUE),
  ('member',             'engage',     TRUE),
  -- bulletins: bulletin:write/read holders (member reads).
  ('national_admin',     'bulletins',  TRUE),
  ('regional_organizer', 'bulletins',  TRUE),
  ('local_coordinator',  'bulletins',  TRUE),
  ('ward_councillor',    'bulletins',  TRUE),
  ('member',             'bulletins',  TRUE),
  -- newsroom: post:write / post:moderate holders.
  ('national_admin',     'newsroom',   TRUE),
  ('regional_organizer', 'newsroom',   TRUE),
  ('local_coordinator',  'newsroom',   TRUE),
  -- jobs: jobs:* holders (analyst reads demand; member manages own interest).
  ('national_admin',     'jobs',       TRUE),
  ('regional_organizer', 'jobs',       TRUE),
  ('local_coordinator',  'jobs',       TRUE),
  ('ward_councillor',    'jobs',       TRUE),
  ('analyst',            'jobs',       TRUE),
  ('member',             'jobs',       TRUE),
  -- overview: overview:read / report:generate holders.
  ('national_admin',     'overview',   TRUE),
  ('regional_organizer', 'overview',   TRUE),
  ('ward_councillor',    'overview',   TRUE),
  ('analyst',            'overview',   TRUE),
  -- id_cards: UI-only, rides on member:read — seeded for member:read holders.
  ('national_admin',     'id_cards',   TRUE),
  ('regional_organizer', 'id_cards',   TRUE),
  ('local_coordinator',  'id_cards',   TRUE),
  ('ward_councillor',    'id_cards',   TRUE),
  -- moderation: moderate:users holder (national only).
  ('national_admin',     'moderation', TRUE),
  -- admin: role:manage / audit:read / consent:manage / module:manage holders
  -- (national_admin holds all; regional_organizer holds consent:manage).
  ('national_admin',     'admin',      TRUE),
  ('regional_organizer', 'admin',      TRUE)
ON CONFLICT (role, module_key) DO NOTHING;
