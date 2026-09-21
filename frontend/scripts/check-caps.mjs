#!/usr/bin/env node
/**
 * Capability-drift guard.
 *
 * `src/lib/caps.ts` derives the UI's capability flags from the permission list
 * the server sends at login/refresh, so the *role → capability* mapping can no
 * longer drift. Four things still can, and this script fails the build on all
 * of them:
 *
 *   1. The permission VOCABULARY. `Perm` mirrors the backend enum by hand,
 *      because the two packages share no code. A rename on the server would
 *      otherwise turn a capability silently off (fail closed, but invisible),
 *      and a typo would do the same. Both directions are checked.
 *
 *   2. The SECURITY INVARIANTS this campaign actually found. Re-deriving from
 *      the server's matrix only helps if nobody edits that matrix into
 *      re-opening a leak, so the specific defects are pinned here as
 *      regressions: the councillor's phantom publish buttons (D6), the
 *      coordinator's phantom metro overview (D6), and the member/analyst PII
 *      and directory gates (D7/D8).
 *
 *   3. The DESKTOP CRM's NAVIGATION GATE. `CrmShell` declares, per screen, the
 *      permission that screen needs, and hides the ones this session lacks. Same
 *      failure mode as (1) — a mistyped `Perm.X` is `undefined`, which fails
 *      closed and silently deletes a screen for every role — plus the two
 *      ways the gate itself can rot: a page added without a gate, and the
 *      desktop-role list drifting from the product decision it encodes.
 *
 *   4. The MOBILE SHELL's MEMBERS GATE. Not a table, so not derivable: five
 *      JSX conditionals across four components, plus a sweep for any file that
 *      deep-links into the Members tab without consulting `memberRead`. A
 *      component that stops asking gets a correct `false` and ignores it, which
 *      no amount of matrix checking can see (D7/D8/D51).
 *
 * Deliberately a regex parse of source files rather than a runtime import:
 * the frontend package has no TypeScript runner, and pulling one in to check a
 * table would be a bigger dependency than the table. Each parser asserts it
 * found something, so a format change fails loudly instead of passing on two
 * empty sets.
 *
 * Usage: npm run caps:check   (exit 0 = in step, 1 = drift, 2 = parser broke)
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '..');
const BACKEND = resolve(FRONTEND, '..', 'backend');

const PERMISSIONS_TS = resolve(BACKEND, 'src/auth/permissions.ts');
const CAPS_TS = resolve(FRONTEND, 'src/lib/caps.ts');
const CRM_SHELL_TSX = resolve(FRONTEND, 'src/components/CrmShell.tsx');
const CRM_PAGES_DIR = resolve(FRONTEND, 'src/app/crm');
const APP_SHELL_TSX = resolve(FRONTEND, 'src/components/AppShell.tsx');
const MEMBERS_TAB_TSX = resolve(FRONTEND, 'src/components/tabs/MembersTab.tsx');
const MORE_TAB_TSX = resolve(FRONTEND, 'src/components/tabs/MoreTab.tsx');
const HOME_TAB_TSX = resolve(FRONTEND, 'src/components/tabs/HomeTab.tsx');
const ENGAGE_TAB_TSX = resolve(FRONTEND, 'src/components/tabs/EngageTab.tsx');
const MODULES_TS = resolve(FRONTEND, 'src/lib/modules.ts');
const CASE_STATUS_TS = resolve(FRONTEND, 'src/lib/caseStatus.ts');
const MIGRATION_016 = resolve(BACKEND, 'src/db/migrations/016_module_registry.sql');
const MIGRATION_003 = resolve(BACKEND, 'src/db/migrations/003_service_delivery.sql');
const MIGRATION_017 = resolve(BACKEND, 'src/db/migrations/017_field_logging.sql');

const failures = [];
const fatal = [];

/** Grab `NAME = { ... } as const;` (or `= { ... };`) and return the inner body. */
function constBlock(source, header, terminator, file) {
  const re = new RegExp(`${header}([\\s\\S]*?)\\n\\}${terminator}`);
  const m = source.match(re);
  if (!m) {
    fatal.push(`${file}: could not locate a block matching \`${header}\` — has the file been reformatted?`);
    return '';
  }
  return m[1];
}

/** Parse `KEY: 'value',` pairs. */
function stringPairs(body) {
  const out = new Map();
  for (const m of body.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*'([^']+)'/gm)) out.set(m[1], m[2]);
  return out;
}

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    fatal.push(`cannot read ${path}`);
    return '';
  }
}

// ── Backend: the authority ───────────────────────────────────────────────
const backend = read(PERMISSIONS_TS);

const roleNames = stringPairs(constBlock(backend, 'export const Role = \\{', ' as const;', 'permissions.ts'));
const backendPerms = stringPairs(
  constBlock(backend, 'export const Permission = \\{', ' as const;', 'permissions.ts'),
);

/**
 * Resolve the `Permission.X` tokens and any `...NAME` spread in an expression
 * segment to a Set of concrete permission values. `NAME` refers to a shared
 * `readonly Permission[]` const (see `constPerms` below) so a role that extends
 * one — e.g. `superadmin` spreading the national-admin set — is still parsed to
 * the FULL set it actually holds, not just the extra permissions written inline.
 */
function resolvePermRefs(segment, ctx) {
  const set = new Set();
  for (const s of segment.matchAll(/\.\.\.([A-Z][A-Z0-9_]*)/g)) {
    const base = constPerms.get(s[1]);
    if (!base) {
      fatal.push(`permissions.ts: ${ctx} spreads ${s[1]}, which is not a known \`readonly Permission[]\` const`);
      continue;
    }
    for (const v of base) set.add(v);
  }
  for (const p of segment.matchAll(/Permission\.([A-Z][A-Z0-9_]*)/g)) {
    const value = backendPerms.get(p[1]);
    if (!value) fatal.push(`permissions.ts: Permission.${p[1]} is granted (${ctx}) but not defined`);
    else set.add(value);
  }
  return set;
}

// Named permission-set consts (e.g. NATIONAL_ADMIN_PERMISSIONS), so both a role
// that references one directly and one that extends it via spread resolve fully.
const constPerms = new Map();
for (const m of backend.matchAll(/const ([A-Z][A-Z0-9_]*)\s*:\s*readonly Permission\[\]\s*=\s*\[([\s\S]*?)\];/g)) {
  constPerms.set(m[1], resolvePermRefs(m[2], `${m[1]} const`));
}

/** role string → Set<permission string> */
const rolePerms = new Map();
const matrixBody = constBlock(
  backend,
  'export const ROLE_PERMISSIONS[^=]*=\\s*\\{',
  ';',
  'permissions.ts',
);
for (const m of matrixBody.matchAll(/\[Role\.([A-Z][A-Z0-9_]*)\]:\s*(\[[\s\S]*?\]|[A-Z][A-Z0-9_]*)/g)) {
  const role = roleNames.get(m[1]);
  if (!role) {
    fatal.push(`permissions.ts: ROLE_PERMISSIONS references Role.${m[1]}, which the Role enum does not define`);
    continue;
  }
  let held;
  if (m[2].startsWith('[')) {
    held = resolvePermRefs(m[2], `role ${role}`);
  } else {
    // A role whose value is a bare shared const (`[Role.X]: SOME_PERMISSIONS`).
    const base = constPerms.get(m[2]);
    if (!base) {
      fatal.push(`permissions.ts: role ${role} references ${m[2]}, which is not a known \`readonly Permission[]\` const`);
      held = new Set();
    } else {
      held = new Set(base);
    }
  }
  rolePerms.set(role, held);
}

// ── Backend: the module registry (Wave 2) ────────────────────────────────
// `ModuleKey` is the enum of module keys; `MODULE_PERMISSIONS` maps each to the
// permissions it OWNS (disabling the module strips exactly those). Both are
// parsed here so section 6 can pin the map against `Permission` and the seeded
// gates in migration 016 against the applicability rule in `modulesForRole()`.
const moduleKeyPairs = stringPairs(
  constBlock(backend, 'export const ModuleKey = \\{', ' as const;', 'permissions.ts'),
);

/** module value ('map') → Set<permission value> it owns. */
const modulePerms = new Map();
const modulePermsBody = constBlock(
  backend,
  'export const MODULE_PERMISSIONS[^=]*=\\s*\\{',
  ';',
  'permissions.ts',
);
for (const m of modulePermsBody.matchAll(/\[ModuleKey\.([A-Z][A-Z0-9_]*)\]:\s*\[([\s\S]*?)\]/g)) {
  const mod = moduleKeyPairs.get(m[1]);
  if (!mod) {
    fatal.push(`permissions.ts: MODULE_PERMISSIONS references ModuleKey.${m[1]}, which the ModuleKey enum does not define`);
    continue;
  }
  const owned = new Set();
  for (const p of m[2].matchAll(/Permission\.([A-Z][A-Z0-9_]*)/g)) {
    const value = backendPerms.get(p[1]);
    if (!value) fatal.push(`permissions.ts: Permission.${p[1]} is owned by module '${mod}' but not defined`);
    else owned.add(value);
  }
  modulePerms.set(mod, owned);
}

// ── Backend: the seeded role×module gates (migration 016) ────────────────
// Only enabled=TRUE applicable cells are seeded (see the migration header); an
// applicable-but-unseeded cell defaults to enabled at read time. Parsed so
// section 6 can prove the seed never disables access nor seeds an inapplicable
// cell.
const migration016 = read(MIGRATION_016);
/** [{ role, module, enabled }] from the role_module_gates seed INSERT. */
const seededGates = [];
const seedBlock = migration016.match(/INSERT INTO role_module_gates[^;]*?VALUES([\s\S]*?)ON CONFLICT/);
if (seedBlock) {
  for (const m of seedBlock[1].matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(TRUE|FALSE)\s*\)/g)) {
    seededGates.push({ role: m[1], module: m[2], enabled: m[3] === 'TRUE' });
  }
}

// ── Frontend: the mirror ─────────────────────────────────────────────────
const caps = read(CAPS_TS);

const frontendPerms = stringPairs(constBlock(caps, 'export const Perm = \\{', ' as const;', 'caps.ts'));

/** Caps field → Perm KEY (e.g. `pii` → `PII_DECRYPT`) */
const capsToPermKey = new Map();
const mapBody = constBlock(
  caps,
  'const CAPS_PERMISSION[^=]*=\\s*\\{',
  ';',
  'caps.ts',
);
for (const m of mapBody.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):\s*Perm\.([A-Z][A-Z0-9_]*)/gm)) {
  capsToPermKey.set(m[1], m[2]);
}

const capsFields = new Set();
for (const m of constBlock(caps, 'export interface Caps \\{', '', 'caps.ts').matchAll(
  /^\s*([A-Za-z][A-Za-z0-9]*):\s*boolean;/gm,
)) {
  capsFields.add(m[1]);
}

// ── Frontend: the ModuleKey mirror (lib/modules.ts) ──────────────────────
// `moduleOn(enabledModules, key)` gates the UI-only surfaces (`id_cards`) on the
// module keys the server sends. The key set is mirrored by hand, so it can drift
// exactly like `Perm` — a renamed key makes moduleOn() consult a string the
// server never sends, and the surface silently vanishes (fail closed, but
// invisible). Section 6 pins it both directions against the backend enum.
const modulesSrc = read(MODULES_TS);
const frontendModuleKeys = stringPairs(
  constBlock(modulesSrc, 'export const ModuleKey = \\{', ' as const;', 'lib/modules.ts'),
);

// ── Frontend: the desktop CRM's navigation gate ──────────────────────────
// Same drift class as the role table, one level up: `CrmShell` gates each of
// its screens on a permission, and a mistyped `Perm.X` there resolves to
// `undefined` — which fails closed, so the screen vanishes for *every* role
// including national_admin, with no error anywhere. Silence is the failure
// mode, so it has to be checked rather than caught.
const shell = read(CRM_SHELL_TSX);

const desktopRoles = [];
const desktopBlock = shell.match(/const DESKTOP_ROLES[^=]*=\s*\[([\s\S]*?)\];/);
if (desktopBlock) {
  for (const m of desktopBlock[1].matchAll(/'([^']+)'/g)) desktopRoles.push(m[1]);
}

/** { href, label, permissionKey } per nav item, in source order. */
const navItems = [];
for (const m of shell.matchAll(
  /\{\s*href:\s*'([^']+)'[^}]*?label:\s*'([^']+)'[^}]*?permission:\s*Perm\.([A-Z][A-Z0-9_]*)/g,
)) {
  navItems.push({ href: m[1], label: m[2], permissionKey: m[3] });
}

/** Every `/crm/<dir>` route that exists on disk, plus the `/crm` index. */
const crmRoutes = ['/crm'];
if (existsSync(CRM_PAGES_DIR)) {
  for (const entry of readdirSync(CRM_PAGES_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && existsSync(resolve(CRM_PAGES_DIR, entry.name, 'page.tsx'))) {
      crmRoutes.push(`/crm/${entry.name}`);
    }
  }
} else {
  fatal.push(`cannot read ${CRM_PAGES_DIR}`);
}

// ── Frontend: the mobile shell's tab gates ───────────────────────────────
// The desktop gate above is a table, so it can be parsed and compared. The
// mobile one is not: it is a handful of separate JSX conditionals spread over
// five components, and the failure mode is a conditional that simply stops being
// consulted. Nothing about `deriveCaps` would change — `caps.memberRead` would
// still be perfectly correct and still `false` for member and analyst — the
// component would just stop asking. So the guards are pinned as source.
const appShell = read(APP_SHELL_TSX);
const membersTab = read(MEMBERS_TAB_TSX);
const moreTab = read(MORE_TAB_TSX);
const homeTab = read(HOME_TAB_TSX);
const engageTab = read(ENGAGE_TAB_TSX);

// ── Parser self-check ────────────────────────────────────────────────────
// Both sides empty would compare equal and pass, so require substance.
if (backendPerms.size === 0) fatal.push('parsed zero permissions from the backend enum');
if (frontendPerms.size === 0) fatal.push('parsed zero permissions from the frontend Perm mirror');
if (rolePerms.size === 0) fatal.push('parsed zero roles from ROLE_PERMISSIONS');
if (capsFields.size === 0) fatal.push('parsed zero fields from the Caps interface');
if (capsToPermKey.size === 0) fatal.push('parsed zero entries from CAPS_PERMISSION');
if (desktopRoles.length === 0) fatal.push('parsed zero roles from CrmShell DESKTOP_ROLES');
if (navItems.length === 0) fatal.push('parsed zero nav items from CrmShell NAV_SECTIONS');
if (moduleKeyPairs.size === 0) fatal.push('parsed zero module keys from the backend ModuleKey enum');
if (modulePerms.size === 0) fatal.push('parsed zero modules from MODULE_PERMISSIONS');
if (frontendModuleKeys.size === 0) fatal.push('parsed zero module keys from the frontend lib/modules.ts mirror');
if (seededGates.length === 0) fatal.push('parsed zero rows from the migration 016 role_module_gates seed');

// Bail before any comparison runs. On an empty parse every set comparison below
// would agree with every other empty set, and the matrix would print as though
// it meant something — the vacuous pass this guard exists to prevent.
if (fatal.length) {
  console.error(`PARSER FAILURE (${fatal.length}) — this guard cannot see the tables, so it proves nothing:`);
  for (const f of fatal) console.error(`  ✗ ${f}`);
  process.exit(2);
}

// ── 1. Vocabulary agreement, both directions ─────────────────────────────
const backendValues = new Set(backendPerms.values());
const frontendValues = new Set(frontendPerms.values());

for (const value of [...frontendValues].sort()) {
  if (!backendValues.has(value)) {
    failures.push(`caps.ts declares permission '${value}', which the backend does not define — the capability it gates is permanently off`);
  }
}
for (const value of [...backendValues].sort()) {
  if (!frontendValues.has(value)) {
    failures.push(`backend permission '${value}' is not mirrored in caps.ts Perm — no UI can gate on it`);
  }
}
// Same string reachable under two different names is a trap of its own.
for (const [key, value] of frontendPerms) {
  const backendKey = [...backendPerms].find(([, v]) => v === value)?.[0];
  if (backendKey && backendKey !== key) {
    failures.push(`caps.ts Perm.${key} = '${value}' but the backend names it ${backendKey} — rename to match`);
  }
}

// ── 2. The Caps mapping resolves ─────────────────────────────────────────
// `memberMap` is the ONE derived capability: `deriveCaps` computes it as
// `geoRead || geoReadOwn` (Wave 4 — the Map tab opens for a staff role's
// geo:read OR a member's geo:read_own_ward), so it is deliberately absent from
// CAPS_PERMISSION, which maps a cap to a SINGLE permission. Pin it as derived:
// it must be a Caps field, must NOT be in the permission map, and deriveFor()
// below must reproduce the same disjunction the runtime does.
const DERIVED_CAPS = new Set(['memberMap']);
for (const field of [...capsFields].sort()) {
  if (DERIVED_CAPS.has(field)) {
    if (capsToPermKey.has(field)) {
      failures.push(`Caps.${field} is a derived disjunction but CAPS_PERMISSION maps it to a single permission — remove it from the map and compute it in deriveCaps()`);
    }
    continue;
  }
  const key = capsToPermKey.get(field);
  if (!key) failures.push(`Caps.${field} has no CAPS_PERMISSION entry — deriveCaps() would leave it undefined`);
  else if (!frontendPerms.has(key)) failures.push(`Caps.${field} maps to Perm.${key}, which Perm does not define`);
}
for (const field of [...capsToPermKey.keys()].sort()) {
  if (!capsFields.has(field)) failures.push(`CAPS_PERMISSION maps '${field}', which is not a Caps field — dead mapping`);
}
// A derived cap the Caps interface does not declare is a stale allowlist entry.
for (const field of DERIVED_CAPS) {
  if (!capsFields.has(field)) failures.push(`DERIVED_CAPS lists '${field}', which is not a Caps field — stale`);
}

// ── 3. Derived matrix + pinned invariants ────────────────────────────────
/** What the UI will offer `role`, derived exactly as deriveCaps() does. */
function deriveFor(role) {
  const held = rolePerms.get(role) ?? new Set();
  const out = {};
  for (const [field, key] of capsToPermKey) out[field] = held.has(frontendPerms.get(key));
  // Mirror deriveCaps' one derived flag: the Map tab opens for a staff role's
  // geo:read OR a member's geo:read_own_ward. Kept here so the tab pins and the
  // matrix below see the same value the runtime computes.
  out.memberMap = Boolean(out.geoRead || out.geoReadOwn);
  return out;
}

const derived = new Map();
for (const role of rolePerms.keys()) derived.set(role, deriveFor(role));

/**
 * Regression pins, each tied to a defect this campaign found. These are not a
 * copy of the matrix — they are the handful of cells where getting it wrong
 * either leaks a control the server refuses (over-offer) or hides one the
 * server grants (under-offer).
 */
const PINS = [
  { role: 'ward_councillor', cap: 'eventWrite', expect: false, why: 'D6: no event:write — the old table showed a Publish event button that 403d' },
  { role: 'ward_councillor', cap: 'postWrite', expect: false, why: 'D6: no post:write — "Issue a press release" was visible and 403d' },
  { role: 'ward_councillor', cap: 'notify', expect: false, why: 'D6: no notify:write — Settings claimed "Broadcast notifications: allowed"' },
  { role: 'ward_councillor', cap: 'overviewRead', expect: true, why: 'D6 backend: deliberate ward-scoped desktop CRM grant' },
  { role: 'ward_councillor', cap: 'verifyWrite', expect: true, why: 'backend grants verify:write; the old table under-offered it' },
  // D7/D8 turn on this pair. The councillor is the role that proves `memberRead`
  // and `memberWrite` are genuinely two gates and not one: it reads the
  // directory (so the Members tab stays) and cannot add to it (so the FAB goes).
  // Collapsing them back into a single flag would pass every other pin.
  { role: 'ward_councillor', cap: 'memberRead', expect: true, why: 'D7/D8: ward-scoped directory access is what the councillor\'s Members tab is for' },
  { role: 'ward_councillor', cap: 'memberWrite', expect: false, why: 'D7: no member:write — the Add-member FAB rendered and failed on submit' },
  { role: 'local_coordinator', cap: 'memberRead', expect: true, why: 'D7/D8: branch coordinators run the directory day to day' },
  { role: 'local_coordinator', cap: 'overviewRead', expect: false, why: 'D6: coordinator has no overview:read — "Metro Overview" was visible and 403d' },
  { role: 'local_coordinator', cap: 'bulletinWrite', expect: false, why: 'no bulletin:write — the old table showed the bulletin quick action' },
  // W3 §3.4 reverses the old D6 "no patrol quick action" finding: coordinators
  // now walk/drive ward patrols, so patrol:write is granted and the Start-patrol
  // control must render (it would have 403d before this wave). Pinned true so it
  // cannot be silently revoked, and caseLog true so the Log-a-case FAB stays.
  { role: 'local_coordinator', cap: 'patrolWrite', expect: true, why: 'W3 §3.4: coordinators walk ward patrols — patrol:write granted so Start patrol works instead of 403ing' },
  { role: 'local_coordinator', cap: 'caseLog', expect: true, why: 'W3 §3.3: coordinators log cases in their ward — the Log-a-case control must render' },
  { role: 'local_coordinator', cap: 'memberWrite', expect: true, why: 'branch coordinators do register members' },
  // PLAN DEVIATION, pinned so it cannot be "fixed" back: the validation plan
  // read `moderate` as moderate:users and said to remove it from
  // regional_organizer. It is post:moderate, which that role genuinely holds.
  { role: 'regional_organizer', cap: 'moderate', expect: true, why: 'holds post:moderate; caps.moderate gates content take-down, not the member ban ladder' },
  { role: 'regional_organizer', cap: 'pii', expect: true, why: 'regional organisers decrypt PII (audited)' },
  { role: 'analyst', cap: 'pii', expect: false, why: 'POPIA: analyst is aggregate-only, no member:pii_decrypt' },
  { role: 'analyst', cap: 'memberWrite', expect: false, why: 'D7/D8: analyst must not see the Add-member control' },
  { role: 'analyst', cap: 'memberRead', expect: false, why: 'POPIA D8: no member:read — the Members tab, the ID-card shortcut and the home sign-up list all hang off this flag' },
  { role: 'analyst', cap: 'overviewRead', expect: true, why: 'analyst keeps the metro aggregate view' },
  { role: 'analyst', cap: 'jobDemand', expect: true, why: 'analyst reads aggregate ward work-demand' },
  { role: 'member', cap: 'pii', expect: false, why: 'POPIA: a member never decrypts the directory' },
  { role: 'member', cap: 'memberWrite', expect: false, why: 'D7/D8: member must not see the Add-member control' },
  { role: 'member', cap: 'memberRead', expect: false, why: 'POPIA D8: a member sees their own record, never the directory of everyone else\'s' },
  { role: 'member', cap: 'overviewRead', expect: false, why: 'D6: members are mobile-only and hold no overview:read' },
  { role: 'member', cap: 'jobInterest', expect: true, why: 'PRD-jobs: a member manages their own interest row' },
  // W3 field logging is staff work. A member contributes via report:write (the
  // report-to-councillor form), never by logging a case or starting a patrol —
  // pinned false so the two new FABs cannot leak into the member UI.
  { role: 'member', cap: 'caseLog', expect: false, why: 'W3: a member reports to their councillor, never logs a case — the Log-a-case FAB must not render' },
  { role: 'member', cap: 'patrolWrite', expect: false, why: 'W3: patrols are staff field work — a member never starts one' },
  { role: 'analyst', cap: 'patrolWrite', expect: false, why: 'W3: analyst is aggregate-only — no patrol:write, so no Start patrol control' },
  { role: 'national_admin', cap: 'jobDemand', expect: true, why: 'JobsSection orders staff before member; admin holds both' },
  // W4 restricted member map. A member holds geo:read_own_ward and NEVER the
  // full geo:read; memberMap (the derived disjunction) is what opens the Map
  // tab, so it is true for a member while geoRead stays false. Analyst keeps the
  // full geo:read and does not hold the ward-scoped member permission. These
  // three pins are what stop a future edit from either handing a member the
  // full analytics map (member points/choropleth) or taking the restricted map
  // away again.
  { role: 'member', cap: 'geoRead', expect: false, why: 'W4: a member never holds geo:read — the full analytics map (member GPS points, choropleth, municipality drill) stays staff-only' },
  { role: 'member', cap: 'geoReadOwn', expect: true, why: 'W4: a member holds geo:read_own_ward — the restricted own-ward map (subcouncil + ward + councillor + case heat)' },
  { role: 'member', cap: 'memberMap', expect: true, why: 'W4: memberMap = geoRead || geoReadOwn, so the Map tab opens for a member in restricted mode' },
  { role: 'analyst', cap: 'geoReadOwn', expect: false, why: 'W4: analyst holds the full geo:read, not the ward-scoped member permission' },
  { role: 'analyst', cap: 'memberMap', expect: true, why: 'W4: analyst keeps the Map tab via geo:read (memberMap is the disjunction)' },
  { role: 'ward_councillor', cap: 'memberMap', expect: true, why: 'W4: staff hold geo:read, so memberMap is true and the full map renders (never the restricted one)' },
];

for (const pin of PINS) {
  const matrix = derived.get(pin.role);
  if (!matrix) {
    fatal.push(`pin references role '${pin.role}', which ROLE_PERMISSIONS does not define`);
    continue;
  }
  if (!(pin.cap in matrix)) {
    // Two different breakages, and only one of them is a stale pin. Saying
    // "Caps does not define" when the field is there but unmapped sends the
    // reader to the wrong file — the mapping is what deriveCaps() consults.
    fatal.push(
      capsFields.has(pin.cap)
        ? `pin references capability '${pin.cap}', which CAPS_PERMISSION does not map — deriveCaps() would leave it undefined`
        : `pin references capability '${pin.cap}', which Caps does not define`,
    );
    continue;
  }
  if (matrix[pin.cap] !== pin.expect) {
    failures.push(
      `${pin.role}.${pin.cap} derives to ${matrix[pin.cap]}, expected ${pin.expect} — ${pin.why}`,
    );
  }
}

// A pin naming a role or capability that no longer exists means the guard has
// stopped testing what it thinks it is — louder than a failed expectation.
if (fatal.length) {
  console.error(`STRUCTURAL FAILURE (${fatal.length}) — the pins no longer match the tables:`);
  for (const f of fatal) console.error(`  ✗ ${f}`);
  // Sections 1 and 2 have already run and anything they found is still true —
  // and is usually the actionable half. An unmapped Caps field reports both
  // "this pin cannot be evaluated" and "Caps.X has no CAPS_PERMISSION entry",
  // and only the second names the file to edit.
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(2);
}

// ── 4. The desktop CRM's navigation gate ─────────────────────────────────
const navByHref = new Map();
for (const item of navItems) {
  if (navByHref.has(item.href)) {
    failures.push(`CrmShell NAV_SECTIONS lists '${item.href}' twice — which gate applies is ambiguous`);
  }
  navByHref.set(item.href, item);
}

// A gate naming a permission `Perm` does not define is `undefined` at runtime.
// That fails closed, so it cannot leak — but it silently removes the screen from
// every role including national_admin, and nothing anywhere reports it.
for (const item of navItems) {
  if (!frontendPerms.has(item.permissionKey)) {
    failures.push(
      `CrmShell gates '${item.href}' on Perm.${item.permissionKey}, which Perm does not define — the screen is hidden from every role`,
    );
  }
}

// Every CRM page must declare its own gate. An ungated route falls through
// `navPermission`'s overview:read default, which is right for a read-only
// screen and wrong for a management console — so make the author state which.
for (const route of crmRoutes) {
  if (!navByHref.has(route)) {
    failures.push(
      `${route} is a page with no NAV_SECTIONS entry — it is governed only by the overview:read fallback; give it an explicit gate`,
    );
  }
}
for (const href of [...navByHref.keys()].sort()) {
  if (!crmRoutes.includes(href)) {
    failures.push(`CrmShell links to '${href}', which has no page under src/app/crm — dead nav entry`);
  }
}
for (const role of desktopRoles) {
  if (!rolePerms.has(role)) {
    failures.push(`CrmShell DESKTOP_ROLES names '${role}', which ROLE_PERMISSIONS does not define`);
  }
}

/** Which screens `role` would see, computed exactly as CrmShell computes them. */
function screensFor(role) {
  const held = rolePerms.get(role) ?? new Set();
  return navItems
    .filter((item) => held.has(frontendPerms.get(item.permissionKey)))
    .map((item) => item.href);
}

const screensByRole = new Map();
for (const role of rolePerms.keys()) screensByRole.set(role, new Set(screensFor(role)));

const DESKTOP = ['superadmin', 'national_admin', 'regional_organizer', 'ward_councillor'];

/**
 * Nav pins. Deliberately not all 26 rows — a full copy of the gate table would
 * have to be edited for every intentional change and would train reviewers to
 * approve it unread. These are the cells where a wrong answer either hands a
 * role a screen the server refuses (the D4/D6 class) or strips one it is
 * entitled to.
 */
const NAV_PINS = [
  // Structural: superadmin holds every permission (national_admin plus the
  // platform trio), so a screen IT cannot see is a mistyped Perm key rather than
  // an authorisation decision. national_admin is deliberately excluded from this
  // pin: the Platform screens are superadmin-only by design, so national_admin
  // legitimately does NOT see all of them (pinned false further down).
  {
    all: true,
    role: 'superadmin',
    expect: true,
    why: 'superadmin holds every permission — a screen it cannot see is a gate typo, not a policy',
  },
  // The Platform ops surface is superadmin-only: national_admin (the political
  // top role) must NOT reach server/cron/live status, first-party analytics or
  // the website editor. These pins fire if the trio is ever widened upward.
  { href: '/crm/platform', role: 'national_admin', expect: false, why: 'platform:read is superadmin-only — server/cron/live ops is not exposed to a political national admin' },
  { href: '/crm/website-analytics', role: 'national_admin', expect: false, why: 'analytics:read is superadmin-only' },
  { href: '/crm/downloads', role: 'national_admin', expect: false, why: 'analytics:read is superadmin-only' },
  { href: '/crm/website', role: 'national_admin', expect: false, why: 'content:manage is superadmin-only — the website editor is not a national_admin surface' },
  { href: '/crm/platform', role: 'superadmin', expect: true, why: 'superadmin holds platform:read — the ops overview is its primary screen' },
  { href: '/crm/website', role: 'superadmin', expect: true, why: 'superadmin holds content:manage — the website editor' },
  // The public homepage's councillor roster is edited through the same gate as
  // the editor, and for the same reason: it is published site content, not a
  // territory record. These fire if content:manage is ever handed downward.
  { href: '/crm/candidates', role: 'national_admin', expect: false, why: 'content:manage is superadmin-only — the public councillor roster is not a national_admin surface' },
  { href: '/crm/candidates', role: 'superadmin', expect: true, why: 'superadmin holds content:manage — it edits the public councillor roster' },
  { href: '/crm/audit', role: 'regional_organizer', expect: false, why: 'D4: audit:read is national-only; the audit log is the whole platform\'s activity history' },
  { href: '/crm/audit', role: 'ward_councillor', expect: false, why: 'D4: audit:read is national-only' },
  { href: '/crm/users', role: 'regional_organizer', expect: false, why: 'role:manage is national-only; this screen reassigns roles and resets passwords' },
  { href: '/crm/users', role: 'ward_councillor', expect: false, why: 'role:manage is national-only' },
  { href: '/crm/moderation', role: 'regional_organizer', expect: false, why: 'moderate:users (ban ladder + device bans) is national-only' },
  { href: '/crm/moderation', role: 'ward_councillor', expect: false, why: 'moderate:users is national-only' },
  { href: '/crm/settings', role: 'regional_organizer', expect: false, why: 'the settings screen reads crm/roles/:role/permissions, which is role:manage' },
  { href: '/crm/settings', role: 'ward_councillor', expect: false, why: 'the settings screen reads crm/roles/:role/permissions, which is role:manage' },
  // POPIA-adjacent: the member directory. All three desktop roles hold
  // member:read, so all three see it; analyst holds overview:read and would
  // clear a permission-only desktop gate, so this pin also fires if
  // DESKTOP_ROLES is ever widened without reconsidering the directory.
  { href: '/crm/members', role: 'national_admin', expect: true, why: 'member:read — the directory is the CRM\'s core screen' },
  { href: '/crm/members', role: 'regional_organizer', expect: true, why: 'member:read, region-scoped server-side by D5' },
  { href: '/crm/members', role: 'ward_councillor', expect: true, why: 'member:read, ward-scoped server-side by D5' },
  { href: '/crm/members', role: 'analyst', expect: false, why: 'POPIA: analyst has no member:read — aggregate-only, never the directory' },
  { href: '/crm/members', role: 'member', expect: false, why: 'POPIA: a member never reads the directory' },
  // D6 at the navigation layer: the five write permissions the councillor does
  // not hold. Their screens are management consoles, so hiding the link is the
  // same fix as removing the phantom publish buttons in the mobile app.
  { href: '/crm/events', role: 'ward_councillor', expect: false, why: 'D6: no event:write — the console\'s every control would 403' },
  { href: '/crm/posts', role: 'ward_councillor', expect: false, why: 'D6: no post:moderate — take-down/restore would 403' },
  { href: '/crm/campaigns', role: 'ward_councillor', expect: false, why: 'D6: no notify:write — broadcast campaigns would 403' },
  { href: '/crm/notifications', role: 'ward_councillor', expect: false, why: 'D6: no notify:write' },
  { href: '/crm/appointments', role: 'ward_councillor', expect: false, why: 'no appoint:write — scheduling and mandate links would 403' },
  // Under-offer guards: these work for the councillor and must stay visible.
  { href: '/crm/reports', role: 'ward_councillor', expect: true, why: 'report:generate is held by exactly the three desktop roles' },
  { href: '/crm/bulletins', role: 'ward_councillor', expect: true, why: 'bulletin:read/write — publishing a ward bulletin is core councillor work' },
  { href: '/crm/opportunities', role: 'ward_councillor', expect: true, why: 'jobs:opportunity_write — councillors post ward opportunities' },
  { href: '/crm', role: 'ward_councillor', expect: true, why: 'D6 backend: the ward-scoped overview:read grant is what makes desktop access meaningful' },
];

for (const pin of NAV_PINS) {
  if (pin.all) {
    const missing = navItems
      .filter((item) => !screensByRole.get(pin.role)?.has(item.href))
      .map((item) => item.href);
    if (missing.length) {
      failures.push(
        `${pin.role} cannot see ${missing.length} of ${navItems.length} nav items (${missing.join(', ')}) — ${pin.why}`,
      );
    }
    continue;
  }
  if (!navByHref.has(pin.href)) {
    fatal.push(`nav pin references '${pin.href}', which NAV_SECTIONS does not define`);
    continue;
  }
  if (!rolePerms.has(pin.role)) {
    fatal.push(`nav pin references role '${pin.role}', which ROLE_PERMISSIONS does not define`);
    continue;
  }
  const actual = screensByRole.get(pin.role).has(pin.href);
  if (actual !== pin.expect) {
    failures.push(
      `${pin.role} ${actual ? 'can' : 'cannot'} see '${pin.href}', expected ${pin.expect ? 'visible' : 'hidden'} — ${pin.why}`,
    );
  }
}

// The product decision itself: pin the set, not just its members, so widening
// the desktop to analyst or member is a deliberate edit here rather than a
// one-line change that quietly passes every pin above.
const desktopDiff = [
  ...DESKTOP.filter((r) => !desktopRoles.includes(r)).map((r) => `missing ${r}`),
  ...desktopRoles.filter((r) => !DESKTOP.includes(r)).map((r) => `unexpected ${r}`),
];
if (desktopDiff.length) {
  failures.push(
    `CrmShell DESKTOP_ROLES is [${desktopRoles.join(', ')}], expected [${DESKTOP.join(', ')}] (${desktopDiff.join('; ')}) — the desktop/mobile split is an explicit product decision; update NAV_PINS and this list together`,
  );
}

if (fatal.length) {
  console.error(`STRUCTURAL FAILURE (${fatal.length}) — the nav pins no longer match the tables:`);
  for (const f of fatal) console.error(`  ✗ ${f}`);
  // Anything already found is still true and usually more actionable than the
  // structural complaint — a deleted nav entry reports both "this pin cannot be
  // evaluated" and "this page has no gate", and only the second says what to do.
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(2);
}

// ── 5. The mobile shell's tab gates (D7/D8/D51/D52) ──────────────────────
/**
 * Each entry pins a control the server refuses for at least one role to the
 * guard that keeps it out of that role's UI. Written as source patterns because
 * there is nothing to derive here: a component that stops consulting
 * `caps.memberRead` still gets a perfectly correct `false` from `deriveCaps` and
 * then ignores it. The derived matrix cannot see that; only the source can.
 */
const MOBILE_GATES = [
  {
    file: 'AppShell.tsx',
    source: appShell,
    re: /if \(t\.id === 'members'\) return caps\.memberRead;/,
    what: 'tabsFor() filters the Members bottom tab on memberRead',
    why: 'D8: member and analyst hold no member:read, so the tab could only ever render a 403 as an empty directory',
  },
  {
    file: 'AppShell.tsx',
    source: appShell,
    re: /tab === 'members' && caps\.memberRead && <MembersTab \/>/,
    what: '<MembersTab /> is not mounted without memberRead',
    why: 'D8: filtering the tab bar alone leaves a stale `tab` value free to mount the directory anyway',
  },
  {
    file: 'AppShell.tsx',
    source: appShell,
    re: /if \(t\.id === 'map'\) return caps\.memberMap;/,
    what: 'tabsFor() filters the Map bottom tab on memberMap',
    why: 'D52/W4: the Map tab is gated on memberMap (geoRead || geoReadOwn) — a member gets the restricted own-ward map, a role holding neither sees no tab',
  },
  {
    file: 'AppShell.tsx',
    source: appShell,
    re: /tab === 'map' && caps\.memberMap && <MapTab \/>/,
    what: '<MapTab /> is not mounted without memberMap',
    why: 'D52/W4: one render is enough to fire a geo request, so the mount is gated on memberMap as well as the tab bar',
  },
  {
    file: 'HomeTab.tsx',
    source: homeTab,
    re: /\{caps\.memberMap && \(\s*<button className="qa" onClick=\{\(\) => open\('map'\)\}>/,
    what: 'the "Member Map" quick action is gated on memberMap',
    why: 'D52/W4: it deep-links into the Map tab — gated on memberMap so a role without it never sees it',
  },
  {
    file: 'EngageTab.tsx',
    source: engageTab,
    re: /\{caps\.memberMap && \(\s*<button className="btn btn-ghost btn-block btn-sm" onClick=\{\(\) => open\('map'\)\}>/,
    what: 'the "Open movement map" button in the Metro overview is gated on memberMap',
    why: 'D52/W4: tab:engage#overview is deep-linkable by anyone, so this entry point needs the same gate as the tab',
  },
  {
    file: 'MembersTab.tsx',
    source: membersTab,
    re: /caps\.memberWrite && \(\s*<button className="fab"/,
    what: 'the "Add member" FAB is gated on memberWrite, not memberRead',
    why: 'D7: a ward councillor reads the directory and cannot add to it — the FAB rendered and failed on submit',
  },
  {
    file: 'MoreTab.tsx',
    source: moreTab,
    re: /role && role !== 'ward_councillor' && caps\.memberRead && moduleOn\(modules, ModuleKey\.ID_CARDS\) && \(\s*<button className="row" onClick=\{\(\) => open\('members'\)\}>/,
    what: 'the "Party ID cards & QR" shortcut excludes councillors and requires memberRead AND the id_cards module',
    why: 'D8: it deep-links into a tab that no longer exists for member and analyst; W2: it exists to reach party ID cards, so it also hides when an admin switches the id_cards module off',
  },
  {
    file: 'MoreTab.tsx',
    source: moreTab,
    re: /role && role !== 'ward_councillor' && \(\s*<a className="row" href="\/register"/,
    what: 'the Public join page shortcut excludes councillors',
    why: 'Councillor Membership hides the public registration shortcut without removing the public route.',
  },
  {
    file: 'HomeTab.tsx',
    source: homeTab,
    re: /const memberStatsAvailable = caps\.memberRead;/,
    what: 'the home screen derives memberStatsAvailable from memberRead',
    why: 'D51: the unconditional GET /members 403d into an empty array and rendered "Members 0 · Active 0 · Volunteers 0" — figures that look like data and are not',
  },
  {
    file: 'HomeTab.tsx',
    source: homeTab,
    re: /if \(memberStatsAvailable\) \{[\s\S]{0,400}?listMembers/,
    what: 'listMembers is only called when memberStatsAvailable',
    why: 'D51: gating the tiles but still firing the request leaves a guaranteed 403 in the network log',
  },
  {
    file: 'HomeTab.tsx',
    source: homeTab,
    re: /\{memberStatsAvailable && \(/,
    what: 'the "Latest sign-ups" block is gated on memberStatsAvailable',
    why: 'D51: its empty state told member and analyst to add a member from a tab they do not have',
  },
  // W3 field-logging entry points. Both are staff-only FABs in Engage; a member
  // or analyst who saw one would open a form whose submit the server refuses
  // (case:log / patrol:write). Pinned as source because deriveCaps cannot see a
  // conditional that stops being consulted — the same class as the member FAB.
  {
    file: 'EngageTab.tsx',
    source: engageTab,
    re: /\{caps\.caseLog && \(\s*<button className="fab" onClick=\{\(\) => setOpenCase\(null\)\} aria-label="Log a case">/,
    what: 'the "Log a case" FAB in Engage › Cases is gated on caps.caseLog',
    why: 'W3 §3.3: case:log is staff-only — a member reports to their councillor instead, so the FAB must not render for member/analyst',
  },
  {
    file: 'EngageTab.tsx',
    source: engageTab,
    re: /\{caps\.patrolWrite && \(\s*<button className="fab" onClick=\{\(\) => setOpenPatrol\(null\)\} aria-label="Start patrol">/,
    what: 'the "Start patrol" FAB in Engage › Patrols is gated on caps.patrolWrite',
    why: 'W3 §3.4: patrol:write is held by the four staff roles only — a member/analyst must never see the Start-patrol control',
  },
];
for (const gate of MOBILE_GATES) {
  if (!gate.re.test(gate.source)) {
    failures.push(`${gate.file}: ${gate.what} — guard not found. ${gate.why}`);
  }
}

/** Recursively collect every .ts/.tsx under a directory, name-sorted. */
function walkSource(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSource(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Forward-looking half of the same gate. The pins above hold the deep links
// that exist today; this holds the next one, written next year. Swept by file
// rather than by call site because a regex cannot see how far a JSX conditional
// extends — but a file that links into a gated tab without ever naming the cap
// cannot be gating it, whichever way the conditional was meant to go.
const GATED_TABS = [
  { id: 'members', cap: 'memberRead', label: 'Members' },
  { id: 'map', cap: 'memberMap', label: 'Map' },
];
const SRC_DIR = resolve(FRONTEND, 'src');
const deepLinkCount = Object.fromEntries(GATED_TABS.map((t) => [t.id, 0]));
for (const path of walkSource(SRC_DIR)) {
  const source = read(path);
  for (const gated of GATED_TABS) {
    // The trailing quote matters: `open('m` would match both tabs.
    if (!source.includes(`open('${gated.id}'`)) continue;
    deepLinkCount[gated.id] += 1;
    if (!source.includes(gated.cap)) {
      failures.push(
        `${path.replace(`${FRONTEND}/`, '')} deep-links into the ${gated.label} tab with open('${gated.id}') but never consults ${gated.cap} — the link is live for the roles that have no tab to land on`,
      );
    }
  }
}
for (const gated of GATED_TABS) {
  if (deepLinkCount[gated.id] === 0) {
    fatal.push(`swept ${SRC_DIR} and found no open('${gated.id}') call site — the ${gated.label} deep-link guard has nothing to guard`);
  }
}
const deepLinks = GATED_TABS.reduce((n, t) => n + deepLinkCount[t.id], 0);

/** The bottom bar, computed exactly as AppShell's tabsFor() computes it. */
const MOBILE_TABS = ['home', 'map', 'members', 'engage', 'more'];
function tabsForRole(role) {
  const c = derived.get(role) ?? {};
  return MOBILE_TABS.filter((t) => {
    if (t === 'members') return c.memberRead;
    if (t === 'map') return c.memberMap;
    return true;
  });
}

const TAB_PINS = [
  { role: 'member', expect: ['home', 'map', 'engage', 'more'], why: 'W4: member holds geo:read_own_ward so memberMap is true — the restricted own-ward map tab opens (no member:read, so no Members tab)' },
  { role: 'analyst', expect: ['home', 'map', 'engage', 'more'], why: 'D8/W4: aggregate-only — no member:read, but geo:read keeps memberMap true and the map opens' },
  { role: 'ward_councillor', expect: MOBILE_TABS, why: 'D7/D8: reads the ward directory, so the tab stays — but the FAB goes' },
  { role: 'local_coordinator', expect: MOBILE_TABS, why: 'D7/D8: registers members, so both the tab and the FAB' },
];
for (const pin of TAB_PINS) {
  if (!derived.has(pin.role)) {
    fatal.push(`tab pin references role '${pin.role}', which ROLE_PERMISSIONS does not define`);
    continue;
  }
  const actual = tabsForRole(pin.role);
  if (actual.join(',') !== pin.expect.join(',')) {
    failures.push(
      `${pin.role} gets bottom tabs [${actual.join(', ')}], expected [${pin.expect.join(', ')}] — ${pin.why}`,
    );
  }
}

if (fatal.length) {
  console.error(`STRUCTURAL FAILURE (${fatal.length}) — the mobile gate pins no longer match the source:`);
  for (const f of fatal) console.error(`  ✗ ${f}`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(2);
}

// ── 6. The module registry (Wave 2): MODULE_PERMISSIONS + seeded gates ───
// The module → permission map is the single source of truth for what a toggle
// strips, and the drifts that matter here are invisible from the derived
// capability matrix: a permission owned by TWO modules (PERMISSION_MODULE's
// inverse keeps only one, so toggling the other leaves the permission live), and
// a permission owned by NONE that should belong to one (it would survive every
// toggle — an un-killable surface). `rating:write` and `verify:write` are the
// deliberate exceptions: a rating/verification attaches to cases, projects and
// councillors at once, so no single module owns them.
const CROSS_CUTTING_PERMS = new Set(['rating:write', 'verify:write']);

// 6a. The frontend ModuleKey mirror equals the backend enum, both directions —
// the same fail-closed-invisible class as the Perm vocabulary in section 1.
const backendModuleValues = new Set(moduleKeyPairs.values());
const frontendModuleValues = new Set(frontendModuleKeys.values());
for (const value of [...frontendModuleValues].sort()) {
  if (!backendModuleValues.has(value)) {
    failures.push(`lib/modules.ts declares module '${value}', which the backend ModuleKey does not define — moduleOn() can never see it enabled`);
  }
}
for (const value of [...backendModuleValues].sort()) {
  if (!frontendModuleValues.has(value)) {
    failures.push(`backend module '${value}' is not mirrored in lib/modules.ts ModuleKey — no UI can gate the surface on it`);
  }
}
for (const [key, value] of frontendModuleKeys) {
  const backendKey = [...moduleKeyPairs].find(([, v]) => v === value)?.[0];
  if (backendKey && backendKey !== key) {
    failures.push(`lib/modules.ts ModuleKey.${key} = '${value}' but the backend names it ${backendKey} — rename to match`);
  }
}

// 6b. Every permission belongs to AT MOST one module (existence of each module's
// permissions was asserted during the parse). Build the inverse and fail on any
// collision, then fail on any permission owned by none that is not an explicit
// cross-cutting exception.
const permOwners = new Map(); // permission value → [module value]
for (const [mod, owned] of modulePerms) {
  for (const perm of owned) {
    if (!permOwners.has(perm)) permOwners.set(perm, []);
    permOwners.get(perm).push(mod);
  }
}
for (const [perm, owners] of [...permOwners].sort()) {
  if (owners.length > 1) {
    failures.push(`permission '${perm}' is owned by ${owners.length} modules (${owners.join(', ')}) — PERMISSION_MODULE keeps only one, so toggling another leaves it live`);
  }
}
for (const value of [...backendPerms.values()].sort()) {
  if (!permOwners.has(value) && !CROSS_CUTTING_PERMS.has(value)) {
    failures.push(`permission '${value}' belongs to no module and is not a listed cross-cutting exception — assign it in MODULE_PERMISSIONS or add it to CROSS_CUTTING_PERMS deliberately, else it survives every module toggle`);
  }
}
for (const value of [...CROSS_CUTTING_PERMS].sort()) {
  if (!backendValues.has(value)) {
    failures.push(`CROSS_CUTTING_PERMS lists '${value}', which the backend Permission enum does not define — stale allowlist`);
  } else if (permOwners.has(value)) {
    failures.push(`CROSS_CUTTING_PERMS lists '${value}' but it is now owned by module '${permOwners.get(value)[0]}' — remove it from the allowlist`);
  }
}

// 6c. The seeded gates (migration 016) agree with the applicability rule in
// modulesForRole(): a (role, module) cell is applicable when the role's BASE
// matrix holds ≥1 of the module's owned permissions (id_cards, which owns none,
// applies to member:read holders). The seed must be a SUBSET of applicable and
// enabled=TRUE throughout — it only ever makes an applicable cell explicit, so
// it can never strip access on first migrate nor seed a cell no toggle renders.
// Subset (not equality) is deliberate: Wave 4 adds geo:read_own_ward, making
// member→map applicable without a new seed row (an unseeded applicable cell
// defaults to enabled), so equality would break the moment that lands.
function moduleApplicable(role, mod) {
  const held = rolePerms.get(role) ?? new Set();
  const owned = modulePerms.get(mod);
  if (owned === undefined) return false;
  if (owned.size === 0) return mod === 'id_cards' && held.has('member:read');
  for (const p of owned) if (held.has(p)) return true;
  return false;
}
for (const seed of seededGates) {
  if (!rolePerms.has(seed.role)) {
    failures.push(`migration 016 seeds a gate for role '${seed.role}', which ROLE_PERMISSIONS does not define`);
    continue;
  }
  if (!backendModuleValues.has(seed.module)) {
    failures.push(`migration 016 seeds a gate for module '${seed.module}', which ModuleKey does not define`);
    continue;
  }
  if (!seed.enabled) {
    failures.push(`migration 016 seeds (${seed.role}, ${seed.module}) with enabled=FALSE — the seed must only make applicable cells explicit and ENABLED; a FALSE here silently strips that role's access on first migrate`);
  }
  if (!moduleApplicable(seed.role, seed.module)) {
    failures.push(`migration 016 seeds (${seed.role}, ${seed.module}) but that role holds none of the module's permissions — the cell is not applicable, so its toggle would never render`);
  }
}

// ── 7. The case-status vocabulary (Wave 3): caseStatus.ts ↔ the DB enums ──
// `lib/caseStatus.ts` colour-maps the `sr_status` lifecycle and the
// `sr_follow_up` sub-state. Both vocabularies are authored by hand against
// Postgres enums the frontend cannot import, so they drift the same invisible
// way `Perm` does: a status added to the DB without a colour here renders as the
// neutral fallback on every surface (a real workload state painted as "not a
// state"), and a stale colour key for a renamed status silently never matches.
// The compiler already refuses a `Record<SrStatus,…>` that misses a status, but
// ONLY against the `SR_STATUSES` array in the same file — nothing ties that array
// to the enum. So the enum is parsed from the migration and pinned against the
// array AND every colour/label map, both directions (plan §3.5: "a status with
// no colour fails the build").
const caseStatus = read(CASE_STATUS_TS);
const migration003 = read(MIGRATION_003);
const migration017 = read(MIGRATION_017);

/** The `'a','b',…` inside `CREATE TYPE <name> AS ENUM (…)` → ['a','b',…]. */
function enumValues(sql, typeName, file) {
  const m = sql.match(new RegExp(`CREATE TYPE ${typeName} AS ENUM\\s*\\(([^)]*)\\)`));
  if (!m) {
    fatal.push(`${file}: could not locate \`CREATE TYPE ${typeName} AS ENUM (…)\` — has the migration been reformatted?`);
    return [];
  }
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** The `'a', 'b',` inside `export const <name> = [ … ] as const;` → ['a','b',…]. */
function constArray(source, name, file) {
  const m = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  if (!m) {
    fatal.push(`${file}: could not locate \`export const ${name} = [ … ] as const;\``);
    return [];
  }
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** The `key:` names of an `export const <header>… = { … };` record. */
function recordKeys(source, header, file) {
  const m = source.match(new RegExp(`${header}[\\s\\S]*?=\\s*\\{([\\s\\S]*?)\\n\\};`));
  if (!m) {
    fatal.push(`${file}: could not locate a record matching \`${header}\``);
    return [];
  }
  return [...m[1].matchAll(/^\s*([a-z][a-z0-9_]*):/gm)].map((x) => x[1]);
}

const dbSrStatus = enumValues(migration003, 'sr_status', 'migration 003');
const dbFollowUp = enumValues(migration017, 'sr_follow_up', 'migration 017');
const feSrStatuses = constArray(caseStatus, 'SR_STATUSES', 'caseStatus.ts');
const feFollowUps = constArray(caseStatus, 'FOLLOW_UP_STATES', 'caseStatus.ts');
const colorKeys = recordKeys(caseStatus, 'export const SR_STATUS_COLOR', 'caseStatus.ts');
const labelKeys = recordKeys(caseStatus, 'export const SR_STATUS_LABEL', 'caseStatus.ts');
const followColorKeys = recordKeys(caseStatus, 'export const FOLLOW_UP_COLOR', 'caseStatus.ts');

if (dbSrStatus.length === 0) fatal.push('parsed zero values from the sr_status enum');
if (dbFollowUp.length === 0) fatal.push('parsed zero values from the sr_follow_up enum');
if (feSrStatuses.length === 0) fatal.push('parsed zero values from caseStatus.ts SR_STATUSES');
if (feFollowUps.length === 0) fatal.push('parsed zero values from caseStatus.ts FOLLOW_UP_STATES');
if (colorKeys.length === 0) fatal.push('parsed zero keys from SR_STATUS_COLOR');
if (labelKeys.length === 0) fatal.push('parsed zero keys from SR_STATUS_LABEL');
if (followColorKeys.length === 0) fatal.push('parsed zero keys from FOLLOW_UP_COLOR');

if (fatal.length) {
  console.error(`STRUCTURAL FAILURE (${fatal.length}) — the case-status pins no longer match the source:`);
  for (const f of fatal) console.error(`  ✗ ${f}`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(2);
}

// 7a. SR_STATUSES is EXACTLY the DB enum (both directions, order-insensitive).
const dbSrSet = new Set(dbSrStatus);
const feSrSet = new Set(feSrStatuses);
for (const s of dbSrStatus) {
  if (!feSrSet.has(s)) failures.push(`sr_status '${s}' (migration 003) is missing from caseStatus.ts SR_STATUSES — it would render as the neutral fallback on every surface`);
}
for (const s of feSrStatuses) {
  if (!dbSrSet.has(s)) failures.push(`caseStatus.ts SR_STATUSES lists '${s}', which the sr_status enum does not define — a stale status that never matches a real case`);
}

// 7b. Every status has BOTH a colour and a label, and neither map carries a key
// that is not a real status.
for (const s of dbSrStatus) {
  if (!colorKeys.includes(s)) failures.push(`sr_status '${s}' has no SR_STATUS_COLOR entry — a lifecycle state with no colour`);
  if (!labelKeys.includes(s)) failures.push(`sr_status '${s}' has no SR_STATUS_LABEL entry — a lifecycle state with no label`);
}
for (const k of colorKeys) {
  if (!dbSrSet.has(k)) failures.push(`SR_STATUS_COLOR carries key '${k}', which is not an sr_status value — stale colour`);
}
for (const k of labelKeys) {
  if (!dbSrSet.has(k)) failures.push(`SR_STATUS_LABEL carries key '${k}', which is not an sr_status value — stale label`);
}

// 7c. The follow-up sub-state mirrors sr_follow_up the same way. `none` maps to
// an empty tone (renders no chip) but must still be a key, so the map is total.
const dbFuSet = new Set(dbFollowUp);
const feFuSet = new Set(feFollowUps);
for (const s of dbFollowUp) {
  if (!feFuSet.has(s)) failures.push(`sr_follow_up '${s}' (migration 017) is missing from caseStatus.ts FOLLOW_UP_STATES`);
  if (!followColorKeys.includes(s)) failures.push(`sr_follow_up '${s}' has no FOLLOW_UP_COLOR entry`);
}
for (const s of feFollowUps) {
  if (!dbFuSet.has(s)) failures.push(`caseStatus.ts FOLLOW_UP_STATES lists '${s}', which the sr_follow_up enum does not define — stale`);
}
for (const k of followColorKeys) {
  if (!dbFuSet.has(k)) failures.push(`FOLLOW_UP_COLOR carries key '${k}', which is not an sr_follow_up value — stale`);
}

// ── Report ───────────────────────────────────────────────────────────────
const fields = [...capsFields].sort();
const roles = [...rolePerms.keys()].sort();

console.log(`caps:check — ${backendPerms.size} permissions, ${roles.length} roles, ${fields.length} capabilities\n`);

// Capability-major, not role-major: the capability names are the long axis and
// initials alone would be ambiguous (caseLog/caseUpdate, the three job caps).
const SHORT = {
  superadmin: 'superadmin',
  national_admin: 'admin',
  regional_organizer: 'regional',
  local_coordinator: 'coordinator',
  ward_councillor: 'councillor',
  analyst: 'analyst',
  member: 'member',
};
const COL = 13;
console.log('Derived capability matrix — what the UI will offer, computed from the server matrix:');
console.log(`  ${'capability'.padEnd(20)}${roles.map((r) => (SHORT[r] ?? r).padStart(COL)).join('')}`);
for (const field of fields) {
  const row = roles.map((r) => (derived.get(r)?.[field] ? 'Y' : '·').padStart(COL)).join('');
  console.log(`  ${field.padEnd(20)}${row}`);
}
console.log('\n  Y = offered · · = not offered. A Y the server would refuse is the D6 defect class.');

// The nav matrix is printed per desktop role as a screen count plus the hidden
// set: 26 rows × 3 columns is unreadable, and what a reviewer actually needs to
// eyeball is *what each role lost* and whether that loss is intended.
console.log(`\nDesktop CRM — ${navItems.length} screens, gated per item on the permission its page needs:`);
for (const role of DESKTOP) {
  if (!screensByRole.has(role)) {
    console.log(`  ${role}: NOT IN THE PERMISSION MATRIX`);
    continue;
  }
  const seen = screensByRole.get(role);
  const hidden = navItems.filter((i) => !seen.has(i.href)).map((i) => i.label);
  console.log(`  ${role.padEnd(19)} ${String(seen.size).padStart(2)}/${navItems.length} screens`);
  console.log(`  ${''.padEnd(19)} hidden: ${hidden.length ? hidden.join(', ') : '—'}`);
}
const nonDesktop = [...rolePerms.keys()].filter((r) => !DESKTOP.includes(r));
console.log(`  ${'not desktop roles'.padEnd(19)} ${nonDesktop.join(', ')} — refused the whole surface by DESKTOP_ROLES`);

// The mobile bar is five tabs wide for four roles and narrower for two, so it
// fits on a line each — printed in full because the difference *is* the finding.
console.log('\nMobile app — bottom tabs, gated on member:read (D7/D8) and geo:read (D52):');
for (const role of roles) {
  const shown = tabsForRole(role);
  const lost = MOBILE_TABS.filter((t) => !shown.includes(t));
  const label = shown.map((t) => t[0].toUpperCase() + t.slice(1)).join(' · ');
  // Name the missing cap per tab: "map hidden — no member:read" would send the
  // next reader looking in the wrong half of the matrix.
  const why = lost
    .map((t) => {
      const gated = GATED_TABS.find((g) => g.id === t);
      return `${t} (no ${gated ? gated.cap : 'permission?'})`;
    })
    .join(', ');
  console.log(`  ${(SHORT[role] ?? role).padEnd(12)} ${label}${lost.length ? `   (${why} hidden)` : ''}`);
}
const fabRoles = roles.filter((r) => derived.get(r)?.memberWrite).map((r) => SHORT[r] ?? r);
console.log(`  ${''.padEnd(12)} Add-member FAB: ${fabRoles.join(', ')} — member:write, one gate narrower than the tab`);
for (const gated of GATED_TABS) {
  console.log(`  ${''.padEnd(12)} ${deepLinkCount[gated.id]} open('${gated.id}') call site(s) swept, each inside a file that consults ${gated.cap}`);
}

// The module registry: one line per module, showing what a toggle strips and
// which roles it applies to (so a reviewer can eyeball that the applicability
// rule and the seed agree without reading migration 016).
console.log(`\nModule registry — ${modulePerms.size} modules; disabling one strips its permissions from a role:`);
for (const mod of [...modulePerms.keys()].sort()) {
  const owned = modulePerms.get(mod);
  const ownedLabel = owned.size ? `${owned.size} perm${owned.size === 1 ? '' : 's'}` : 'UI-only';
  const applicable = roles.filter((r) => moduleApplicable(r, mod)).map((r) => SHORT[r] ?? r);
  const seeded = seededGates.filter((s) => s.module === mod).length;
  console.log(`  ${mod.padEnd(12)} ${ownedLabel.padEnd(8)} applicable: ${applicable.length ? applicable.join(', ') : '—'}  (seeded ${seeded})`);
}
const unowned = [...backendPerms.values()].filter((v) => !permOwners.has(v)).sort();
console.log(`  ${''.padEnd(12)} cross-cutting (no module, survive every toggle): ${unowned.join(', ') || '—'}`);

// The case-status vocabulary: prove the two hand-authored maps cover the DB
// enums exactly, so a reviewer can eyeball that no lifecycle state is uncoloured.
console.log(`\nCase status — ${dbSrStatus.length} sr_status + ${dbFollowUp.length} sr_follow_up values, all coloured and labelled:`);
console.log(`  ${''.padEnd(12)} status:    ${dbSrStatus.join(', ')}`);
console.log(`  ${''.padEnd(12)} follow-up: ${dbFollowUp.join(', ')}`);

if (failures.length) {
  console.error(`\nDRIFT (${failures.length}):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log(
  `\n✓ vocabulary in step (both directions) · ✓ Caps mapping complete · ✓ ${PINS.length} capability pins hold`
  + ` · ✓ ${navItems.length} nav gates resolve · ✓ ${NAV_PINS.length} nav pins hold`
  + ` · ✓ ${MOBILE_GATES.length} mobile guards present · ✓ ${TAB_PINS.length} tab pins hold · ✓ ${deepLinks} deep links gated`
  + ` · ✓ ${modulePerms.size} modules mapped (ModuleKey mirrored, ≤1 owner/perm) · ✓ ${seededGates.length} seeded gates applicable`
  + ` · ✓ ${dbSrStatus.length} case statuses + ${dbFollowUp.length} follow-up states coloured`,
);
