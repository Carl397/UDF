#!/usr/bin/env node
/**
 * role-audit.mjs — the role × endpoint authorization / POPIA / scope / accuracy
 * harness for the UDF platform.
 *
 * WHY THIS EXISTS
 *   Reading the routers is how the "national_admin only" comment on /api/crm
 * went unnoticed while the route was actually gated on `overview:read`. This
 * harness does not read anything: it calls every route as every role and
 * records what the server actually did.
 *
 * WHAT IT PROVES
 *   1. AUTHORIZATION  — actual status vs the status the permission matrix says
 *                       the role is entitled to, for all 130 routes × 7
 *                       principals (6 roles + an out-of-scope control member)
 *                       + anonymous.
 *   2. POPIA / PII    — deep-walks every JSON response for the sealed fixture
 *                       corpus (emails, SA phone numbers, street addresses,
 *                       full names). Any hit for a principal without
 *                       `member:pii_decrypt` is a HARD failure.
 *   3. SCOPE          — asserts a ward-scoped principal never receives rows
 *                       from the control ward (CPT-W043) or outside
 *                       Mitchell's Plain (CPT-W009 / CPT-W025).
 *   4. ACCURACY       — recomputes dashboard / analytics figures with direct
 *                       SQL and asserts the API's numbers match.
 *
 * TARGET
 *   TARGET_BASE defaults to http://localhost:4000. Point it at production with
 *   NO code change:  TARGET_BASE=https://<origin> npm run role:audit
 *
 * SAFETY
 *   Mutating verbs (POST/PATCH/PUT/DELETE) are probed with a deliberately
 *   INVALID body. Passing the authorization gate therefore yields 400/404/422
 *   (validation) rather than 2xx, so the audit proves the gate without writing
 *   data. Routes listed in DESTRUCTIVE are only probed in the "must be
 *   forbidden" direction.
 *
 * USAGE
 *   npm run routes:inventory -- --out ../deploy/.artifacts/routes.json \
 *                               --matrix ../deploy/.artifacts/permissions.json
 *   npm run seed:validation
 *   npm run role:audit                     # assert + report
 *   npm run role:audit -- --record         # capture only (before/after diffing)
 *   npm run role:audit -- --only crm       # filter by path substring
 *   npm run role:audit -- --tag before     # artifact filename tag
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.resolve(HERE, '../../deploy/.artifacts');
const BASE = (process.env.TARGET_BASE ?? 'http://localhost:4000').replace(/\/$/, '');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const RECORD_ONLY = flag('--record');
const ONLY = opt('--only', null);
const TAG = opt('--tag', null);
const SKIP_ACCURACY = flag('--no-accuracy');

const load = (file) => JSON.parse(readFileSync(path.join(ARTIFACTS, file), 'utf8'));

let ROUTES, MATRIX, FIXTURES, IDS;
try {
  ROUTES = load('routes.json');
  MATRIX = load('permissions.json');
  FIXTURES = load('validation-fixtures.json');
  IDS = load('validation-ids.json');
} catch (err) {
  console.error(`\nrole-audit: cannot load artifacts from ${ARTIFACTS}\n  ${err.message}`);
  console.error('\nRun these first:\n  npm run routes:inventory -- --out ../deploy/.artifacts/routes.json --matrix ../deploy/.artifacts/permissions.json\n  npm run seed:validation\n');
  process.exit(2);
}

const has = (role, permission) => (MATRIX.rolePermissions[role] ?? []).includes(permission);

/**
 * Refuse to audit against a corpus the scanners cannot actually use.
 *
 * `validation-fixtures.json` was remodelled from a flat `outOfScope` deny-list
 * into attributed `tokens` + `wardParents`. Both scanners read their input with a
 * default (`FIXTURES.tokens ?? []`) — correct for robustness, CATASTROPHIC for
 * honesty: pointed at a stale corpus they receive an empty list, have nothing to
 * look for, and report zero leaks. An audit that silently stops checking is worse
 * than no audit at all, because it emits a green artifact everyone will believe.
 * So the shape is asserted up front and a stale corpus aborts the run.
 */
function assertCorpusShape() {
  const problems = [];
  if (!Array.isArray(FIXTURES.tokens) || FIXTURES.tokens.length === 0) {
    problems.push('tokens[] missing or empty — scope and publication scanning would be DISABLED');
  }
  if (!FIXTURES.wardParents || Object.keys(FIXTURES.wardParents).length === 0) {
    problems.push("wardParents{} missing — a regional principal's territory cannot be resolved");
  }
  if (!Array.isArray(FIXTURES.sealed) || FIXTURES.sealed.length === 0) {
    problems.push('sealed[] missing or empty — PII scanning would be DISABLED');
  }
  // Both of these SUPPRESS findings, so an empty list is not a harmless default:
  // it would quietly turn off the H5 account-admin exception and the H4
  // public-by-design baseline, and the run would fill with false positives that
  // look exactly like real leaks. Guarding them here means a stale corpus fails
  // loudly instead of being reinterpreted.
  if (!Array.isArray(FIXTURES.accountIdentity) || FIXTURES.accountIdentity.length === 0) {
    problems.push('accountIdentity[] missing or empty — the account-admin PII exception (H5) would be DISABLED');
  }
  if (!Array.isArray(FIXTURES.publicByDesign) || FIXTURES.publicByDesign.length === 0) {
    problems.push('publicByDesign[] missing or empty — the declared public baseline (H4) would be DISABLED');
  }
  if (FIXTURES.outOfScope) problems.push('corpus still carries the retired outOfScope{} shape');
  for (const field of ['members', 'cases', 'projects', 'bulletins', 'posts', 'wards']) {
    if (IDS[field] == null) problems.push(`validation-ids.json is missing ${field}`);
  }
  // Without a draft row the publication gate has nothing to hide, so "no draft
  // leaked" would pass vacuously — see assertCorpusIsBacked() in the seeder.
  if (!IDS.projects?.some((p) => p.is_published === false)) {
    problems.push('no UNPUBLISHED project in validation-ids.json — the publication gate is untestable');
  }
  if (!IDS.bulletins?.some((b) => b.status && b.status !== 'published')) {
    problems.push('no DRAFT bulletin in validation-ids.json — the publication gate is untestable');
  }
  // D41 needs the posts spread to be exactly three-level: a draft inside the
  // primary ward, one in the ADJACENT control ward (same subcouncil — the
  // region-only trap) and one outside the regional organizer's subcouncils
  // entirely. Missing any level makes the corresponding probe assert against an
  // empty set, which passes while proving nothing.
  {
    const drafts = (IDS.posts ?? []).filter((p) => p.status !== 'published');
    const primary = IDS.wards?.primary;
    const control = IDS.wards?.control;
    if (drafts.length < 3) {
      problems.push(`only ${drafts.length} unpublished post(s) — the posts publication gate needs at least 3`);
    }
    if (!drafts.some((p) => p.ward === primary)) {
      problems.push(`no unpublished post in the primary ward ${primary} — the positive half of the posts gate is untestable`);
    }
    if (!drafts.some((p) => p.ward === control)) {
      problems.push(`no unpublished post in the control ward ${control} — the subcouncil-trap pin is missing`);
    }
    if (!drafts.some((p) => p.ward && (IDS.wards?.outside ?? []).includes(p.ward))) {
      problems.push('no unpublished post OUTSIDE the regional subcouncils — the national-moderator pin (D41) is missing');
    }
    if (!(IDS.posts ?? []).some((p) => p.status === 'taken_down')) {
      problems.push('no taken_down post — moderation-reason disclosure is untestable');
    }
  }
  // The owner gate on `GET /api/transparency/reports/:id` (declared in
  // OWNER_GATED_ROW_PARAMS below) degrades SILENTLY if the seeder did not publish
  // the owner: with no `owner_email` to match, every principal — including the
  // two members who genuinely wrote these reports — becomes ineligible, the id
  // falls back to the nil UUID, and a 404 still satisfies `allow`. The run would
  // stay green while the member-reads-own-report positive path had quietly
  // disappeared. Spelled out inline because assertCorpusShape() runs at load
  // time, before those consts are initialized.
  {
    const rows = IDS.reports ?? [];
    if (rows.length === 0) {
      problems.push('reports[] missing or empty — the resident-report owner gate is untestable');
    } else if (rows.every((r) => r.owner_email == null)) {
      problems.push('reports[] rows carry no owner_email — the resident-report owner gate is untestable');
    } else if (!rows.some((r) => r.owner_email)) {
      problems.push('reports[] has no row with a resolvable owner — the owner gate is untestable');
    }
  }
  if (problems.length > 0) {
    console.error(`\nrole-audit: fixture artifacts are stale or incomplete:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    console.error('\nRegenerate them before trusting any result:\n  npm run seed:validation\n');
    process.exit(2);
  }
}
assertCorpusShape();

// ─────────────────────────────────────────────────────────────────────────────
// Console helpers
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  grey: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const say = (...a) => process.stdout.write(`${a.join(' ')}\n`);

// ─────────────────────────────────────────────────────────────────────────────
// HTTP with a pacer (the server rate-limits to 300 req/min globally)
// ─────────────────────────────────────────────────────────────────────────────

const BUDGET = Number(process.env.AUDIT_REQ_PER_MIN ?? 260);
/** Hard ceiling on a single request, so one wedged route cannot stall the run. */
const REQUEST_TIMEOUT_MS = Number(process.env.AUDIT_REQ_TIMEOUT_MS ?? 30_000);
/**
 * Even spacing rather than a sliding-window burst.
 *
 * The previous pacer kept a 60 s window and only waited once the window was
 * FULL, so it fired all 260 requests back-to-back in a few milliseconds and then
 * slept for a minute. Against a server with a 300/min global limiter and a
 * 20-per-15-min login limiter that guaranteed a 429 storm: the audit spent its
 * time in backoff, the progress counter crawled, and — because `classify` scores
 * a 429 as neither `allow` nor `forbidden` — the report filled up with
 * "authorization failures" that were purely harness-induced. Spacing every call
 * at 60000/BUDGET keeps the run inside the server's limits AND inside its own.
 */
const MIN_INTERVAL_MS = Math.ceil(60_000 / BUDGET);
let lastSentAt = 0;

async function pace() {
  const wait = lastSentAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSentAt = Date.now();
}

async function call(method, url, { token, body, query, retries = 3 } = {}) {
  await pace();
  const u = new URL(url, BASE);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  const headers = { 'x-device-id': 'role-audit-harness' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res, text;
  try {
    res = await fetch(u, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    // A timeout must be distinguishable from a connection failure: the first is a
    // server-side defect worth reporting, the second usually means the target is
    // simply down.
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 0,
      ok: false,
      error: timedOut ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : err.message,
      timedOut,
      url: u.toString(),
      json: null,
      text: '',
    };
  }
  if (res.status === 429 && retries > 0) {
    const wait = Number(res.headers.get('retry-after') ?? 5) * 1000 + 250;
    await new Promise((r) => setTimeout(r, wait));
    return call(method, url, { token, body, query, retries: retries - 1 });
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null; // binary (media) or empty
  }
  return { status: res.status, ok: res.ok, url: u.toString(), json, text, headers: Object.fromEntries(res.headers) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Principals
// ─────────────────────────────────────────────────────────────────────────────

const PASSWORD = process.env.VALIDATION_PASSWORD ?? FIXTURES.password;

const PRINCIPALS = [
  { key: 'anonymous', label: 'anonymous', role: null, email: null, regionCodes: [], wardCode: null, token: null },
  ...FIXTURES.accounts.map((a) => ({ ...a, label: `${a.role}${a.key === 'memberOutside' ? ' (out-of-scope)' : ''}`, token: null })),
];

async function loginAll() {
  for (const p of PRINCIPALS) {
    if (!p.email) continue;
    const res = await call('POST', '/api/auth/login', { body: { email: p.email, password: PASSWORD } });
    if (res.status !== 200 || !res.json?.accessToken) {
      say(C.red(`  login failed for ${p.email}: HTTP ${res.status} ${res.text?.slice(0, 160) ?? ''}`));
      p.loginError = res.status;
      continue;
    }
    p.token = res.json.accessToken;
    p.refreshToken = res.json.refreshToken;
    p.mustChangePassword = Boolean(res.json.mustChangePassword);
  }
  const ok = PRINCIPALS.filter((p) => p.token).length;
  say(C.grey(`  authenticated ${ok}/${PRINCIPALS.length - 1} principals`));
}

// ─────────────────────────────────────────────────────────────────────────────
// Path parameters → concrete fixture values
// ─────────────────────────────────────────────────────────────────────────────

const NIL_UUID = '00000000-0000-4000-8000-000000000000';
const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);

/** In-scope defaults: a W079 principal SHOULD be able to load these. */
const PARAM_DEFAULTS = {
  id: NIL_UUID,
  code: IDS.wards.primary,
  role: 'member',
  memberId: first(IDS.members)?.id ?? NIL_UUID,
  targetType: 'councillor',
  targetId: first(IDS.councillors)?.member_id ?? NIL_UUID,
  token: 'invalid-confirm-token',
};

/** Route-specific overrides, keyed by `${METHOD} ${path}`. */
const PARAM_OVERRIDES = {
  'GET /api/service-requests/:id': { id: first(IDS.cases)?.id },
  'PATCH /api/service-requests/:id': { id: first(IDS.cases)?.id },
  'POST /api/service-requests/:id/close': { id: first(IDS.cases)?.id },
  'GET /api/projects/:id': { id: first(IDS.projects)?.id },
  'POST /api/projects/:id/milestones': { id: first(IDS.projects)?.id },
  'GET /api/patrols/:id': { id: first(IDS.patrols)?.id },
  'POST /api/patrols/:id/end': { id: first(IDS.patrols)?.id },
  'POST /api/patrols/:id/stops': { id: first(IDS.patrols)?.id },
  'POST /api/patrols/:id/track-points': { id: first(IDS.patrols)?.id },
  'GET /api/ward-bulletins/:id': { id: first(IDS.bulletins)?.id },
  'PATCH /api/ward-bulletins/:id': { id: first(IDS.bulletins)?.id },
  'GET /api/events/:id': { id: first(IDS.events)?.id },
  'PATCH /api/events/:id': { id: first(IDS.events)?.id },
  'DELETE /api/events/:id': { id: first(IDS.events)?.id },
  'POST /api/events/:id/rsvp': { id: first(IDS.events)?.id },
  'GET /api/participations/:id': { id: first(IDS.participations)?.id },
  'POST /api/participations/:id/comments': { id: first(IDS.participations)?.id },
  'GET /api/transparency/reports/:id': { id: first(IDS.reports)?.id },
  'GET /api/transparency/wards/:code/detail': { code: IDS.wards.primary },
  'GET /api/transparency/wards/:code/overview': { code: IDS.wards.primary },
  'GET /api/jobs/opportunities/:id': { id: first(IDS.opportunities)?.id },
  'PATCH /api/jobs/opportunities/:id': { id: first(IDS.opportunities)?.id },
  'POST /api/jobs/opportunities/:id/close': { id: first(IDS.opportunities)?.id },
  'POST /api/jobs/opportunities/:id/publish': { id: first(IDS.opportunities)?.id },
  'PUT /api/jobs/admin/work-types/:code': { code: 'labourer' },
  'GET /api/members/:id': { id: first(IDS.members)?.id },
  'PATCH /api/members/:id': { id: first(IDS.members)?.id },
  'DELETE /api/members/:id': { id: first(IDS.members)?.id },
  'GET /api/public/card/:memberId': { memberId: first(IDS.members)?.id },
  'POST /api/public/card/:memberId/confirm-link': { memberId: first(IDS.members)?.id },
  'POST /api/public/petitions/:id/sign': { id: first(IDS.petitions)?.id },
  'GET /api/crm/users/:id': { id: IDS.users?.member ?? NIL_UUID },
  'PATCH /api/crm/users/:id': { id: IDS.users?.member ?? NIL_UUID },
  'DELETE /api/crm/users/:id': { id: IDS.users?.member ?? NIL_UUID },
  'POST /api/crm/users/:id/reset-password': { id: IDS.users?.member ?? NIL_UUID },
  'GET /api/crm/campaigns/:id': { id: NIL_UUID },
  'PATCH /api/crm/campaigns/:id': { id: NIL_UUID },
  'DELETE /api/crm/campaigns/:id': { id: NIL_UUID },
  'POST /api/crm/campaigns/:id/engagement': { id: NIL_UUID },
  'GET /api/moderation/users/:id': { id: IDS.users?.member ?? NIL_UUID },
  'GET /api/ratings/average/:targetType/:targetId': {
    targetType: 'councillor',
    targetId: first(IDS.councillors)?.member_id ?? NIL_UUID,
  },
  'POST /api/notifications/:id/read': { id: NIL_UUID },
  'GET /api/posts/:id': { id: NIL_UUID },
  'PATCH /api/posts/:id': { id: NIL_UUID },
  'DELETE /api/posts/:id': { id: NIL_UUID },
  'POST /api/posts/:id/take-down': { id: NIL_UUID },
  'POST /api/posts/:id/restore': { id: NIL_UUID },
  'GET /api/appointments/:id': { id: NIL_UUID },
  'PATCH /api/appointments/:id': { id: NIL_UUID },
  'DELETE /api/appointments/:id': { id: NIL_UUID },
  'POST /api/appointments/:id/mandate-link': { id: NIL_UUID },
  'GET /api/transparency/media/:id': { id: NIL_UUID },
  'GET /api/public/verify/:code': { code: 'UDF-000-000-000' },
  'GET /api/public/verify/:code/vcard': { code: 'UDF-000-000-000' },
};

/**
 * Routes that mutate SHARED or GLOBAL state even when the body is invalid, or
 * that have an out-of-band side effect (mail, device ban, config overwrite).
 * These are probed only in the "must be denied" direction; where a principal
 * is entitled through the gate the call is skipped rather than executed.
 *
 * Every other mutating route is made safe by forcing its `:id`/`:memberId`
 * parameters to the nil UUID (see fillPath), so passing the gate produces a
 * 404/400 instead of writing a row.
 */
const DESTRUCTIVE = new Set([
  'POST /api/public/register',
  'POST /api/public/card/:memberId/confirm-link',
  'POST /api/notifications/:id/read',
  'POST /api/notifications/read-all',
  'POST /api/auth/logout',
  'POST /api/auth/change-password',
  'POST /api/auth/terms/accept',
  'PUT /api/jobs/admin/config',
  'PUT /api/jobs/admin/work-types/:code',
  'DELETE /api/jobs/interest',
  'POST /api/moderation/actions',
]);

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Path params that identify a row; forced to nil for mutating probes. */
const ROW_PARAMS = new Set(['id', 'memberId', 'targetId']);

/**
 * Territory-sensitive row parameters: `${METHOD} ${path}` → [IDS collection, ward
 * field, path-param name].
 *
 * `expectFor` models the PERMISSION gate only, but several routes additionally
 * enforce row-level scope. Probing them all with one shared fixture id therefore
 * produced "mismatches" that were the backend being right: `IDS.members[0]` sits
 * in CPT-W009 (Table View), which no Mitchell's Plain principal holds, so the 403
 * from `GET /api/public/card/:memberId` is correct behaviour, not a defect.
 *
 * The alternative — declaring an expected-403 per route per principal — would be
 * a second hand-maintained copy of the backend's scope rules, and would drift
 * exactly as the frontend's `CAPS_BY_ROLE` did. So instead each principal is
 * probed with a row they ARE entitled to reach, which tests the positive path as
 * well. A principal with no eligible row falls back to the nil UUID, which
 * yields 404 and still satisfies `allow`.
 *
 * Only reads are listed: every mutating route already has its row parameter
 * forced to the nil UUID by `fillPath`, so it cannot touch a real record.
 */
const SCOPED_ROW_PARAMS = {
  'GET /api/service-requests/:id': ['cases', 'ward_code'],
  'GET /api/projects/:id': ['projects', 'ward_code'],
  'GET /api/patrols/:id': ['patrols', 'ward_code'],
  'GET /api/ward-bulletins/:id': ['bulletins', 'ward_code'],
  'GET /api/events/:id': ['events', 'ward'],
  'GET /api/participations/:id': ['participations', 'ward_code'],
  'GET /api/transparency/reports/:id': ['reports', 'ward_code'],
  'GET /api/jobs/opportunities/:id': ['opportunities', 'ward_code'],
  'GET /api/members/:id': ['members', 'ward'],
  'GET /api/public/card/:memberId': ['members', 'ward', 'memberId'],
};

/**
 * Territory-sensitive WARD-CODE parameters: `${METHOD} ${path}` → [param name].
 *
 * Same reasoning as `SCOPED_ROW_PARAMS`, for routes whose parameter is a ward
 * code rather than a row id. `GET /api/transparency/wards/:code/detail` declares
 * no permission — its gate is entirely row-level (`principalSeesWard` in the
 * handler) — so probing every principal with the one primary ward code produced
 * a 403 for the W075 coordinator and the W043 control member that was the
 * backend correctly enforcing territory, scored as a product failure (H3).
 *
 * Each principal is therefore probed with a ward it IS entitled to reach, which
 * exercises the positive path. The negative direction — an out-of-territory ward
 * must be refused — is pinned by a dedicated probe rather than by the matrix, so
 * the two cannot cancel each other out.
 */
const SCOPED_CODE_PARAMS = {
  'GET /api/transparency/wards/:code/detail': ['code'],
};

/**
 * Row parameters gated on OWNERSHIP, not territory: `${METHOD} ${path}` → the
 * IDS field naming the row's owner.
 *
 * `reachableRow` decides eligibility from territory plus the visibility tier,
 * which is right for every other scoped read but not for `resident_reports`.
 * Migration 009 states the rule — "POPIA: the report is private to the author
 * and the ward's staff" — and `getResidentReport` implements it as
 * `isOwner || (STAFF_ROLES.includes(role) && principalSeesWard(ward))`.
 *
 * For a NON-STAFF caller territory therefore confers nothing, and the territory
 * filter alone let the national-scope `analyst` (whose `territoryOf` is `null`,
 * so it passes every ward) be handed RR-MP-0001, which belongs to the W079
 * member. The backend correctly answered 403 — an analyst reads aggregates and
 * heatmaps, never an individual resident's message, GPS fix and photos — and the
 * harness scored that as a product authorization failure. This is the third
 * control axis alongside territory and publication: identity of the author.
 *
 * The denial is pinned by dedicated probes rather than left to the matrix, per
 * the `SCOPED_CODE_PARAMS` convention, so keeping the matrix on the positive
 * path cannot mask a regression.
 */
const OWNER_GATED_ROW_PARAMS = {
  'GET /api/transparency/reports/:id': 'owner_email',
};

/** A ward code this principal may legitimately read detail for. */
function reachableWardCode(principal) {
  const territory = territoryOf(principal);
  if (territory === null) return IDS.wards.primary; // national — any ward
  if (principal.wardCode) return principal.wardCode;
  // Regional: prefer a Mitchell's Plain ward inside their subcouncils so the
  // fixture data is what gets read, then fall back to any ward they hold.
  for (const w of IDS.wards.mp ?? []) if (territory.has(w)) return w;
  return [...territory][0] ?? IDS.wards.primary;
}

/** The first fixture row in `collection` this principal may actually reach. */
function reachableRow(collection, wardField, principal, ownerField = null) {
  const rows = IDS[collection] ?? [];
  const territory = territoryOf(principal);
  const staff = STAFF.has(principal.role);
  const eligible = rows.filter((r) => {
    if (territory !== null && !territory.has(r[wardField])) return false;
    // Tier and publication are orthogonal to territory. Never probe a non-staff
    // principal with a private or unpublished row: the 403 that comes back is
    // the gate working, and counting it as a permission failure would hide the
    // real result behind noise.
    if (!staff && (r.visibility === 'private' || r.is_published === false || r.status === 'draft')) {
      return false;
    }
    // OWNERSHIP is a third axis again orthogonal to the other two. Where a route
    // is owner-gated, a non-staff caller reaches a row by having WRITTEN it, and
    // national scope buys nothing — see OWNER_GATED_ROW_PARAMS.
    if (ownerField && !staff && r[ownerField] !== principal.email) return false;
    return true;
  });
  // Fall back to the NIL UUID — never to `rows[0]`.
  //
  // `rows[0]` is precisely the row the filter above just rejected, so falling
  // back to it handed every principal the first fixture regardless of scope:
  // the W075 coordinator was probed with the W079 draft project and a W079
  // patrol, and the resulting 403 was scored as a product authorization failure
  // when it was the backend being right (H1). The nil UUID yields a 404, which
  // `satisfied()` accepts for `allow`, so an out-of-territory principal still
  // exercises the permission gate without tripping the row-level one.
  return eligible[0]?.id ?? NIL_UUID;
}

function fillPath(route, principal) {
  const key = `${route.method} ${route.path}`;
  const params = { ...PARAM_DEFAULTS, ...(PARAM_OVERRIDES[key] ?? {}) };
  const scoped = SCOPED_ROW_PARAMS[key];
  if (scoped) {
    const [collection, wardField, paramName = 'id'] = scoped;
    params[paramName] = reachableRow(collection, wardField, principal, OWNER_GATED_ROW_PARAMS[key] ?? null);
  }
  const scopedCode = SCOPED_CODE_PARAMS[key];
  if (scopedCode) {
    for (const name of scopedCode) params[name] = reachableWardCode(principal);
  }
  const nilRowIds = MUTATING.has(route.method);
  return route.path.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    if (nilRowIds && ROW_PARAMS.has(name)) return NIL_UUID;
    const v = params[name];
    return v === undefined || v === null ? NIL_UUID : encodeURIComponent(String(v));
  });
}

/** Invalid body: guaranteed to fail Zod validation, so a gate pass shows as 400/404. */
const INVALID_BODY = { __roleAuditProbe: true };

/**
 * Per-route probe bodies, for the schemas where `INVALID_BODY` is NOT invalid.
 *
 * `INVALID_BODY` assumes Zod rejects an unknown key. It does not: `z.object()`
 * STRIPS unknown keys, so the body only fails when the schema has a REQUIRED
 * field to be missing. `createPatrolSchema` has none — `wardCode`, `purpose` and
 * `plannedDate` are optional and `mode` defaults to `'walk'` — so the probe body
 * parsed cleanly and the matrix CREATED a real active patrol in the councillor's
 * ward on every run. Three blank `purpose = ''` rows had accumulated in CPT-W079
 * inside the fixture set the user is meant to review by hand (P1e).
 *
 * The override instead names a KNOWN field with an illegal value, which no
 * all-optional schema can accept. The authorization question is unchanged:
 * `requirePermission` runs before body parsing, so a role without the permission
 * still gets 403 and a role with it gets 400 — which `satisfied()` scores as
 * `allow`. The only difference is that a green matrix no longer implies the
 * harness wrote to the database.
 */
const PROBE_BODY_OVERRIDES = {
  'POST /api/patrols': { mode: '__role_audit_probe__' },
  // `cardDesignSchema` gives EVERY field a `.default()`, so the generic
  // INVALID_BODY (`{__roleAuditProbe:true}`) strips to `{}` and PARSES into the
  // complete classic card — the matrix would UPSERT the live design row on every
  // run, and reset a national admin's template to defaults if ever pointed at
  // production (`TARGET_BASE=…`). Name a known field with an illegal value
  // instead: `scalePct` is capped at 1000 (the "up to 1000%" export zoom), so
  // 100000 is rejected. `requirePermission(module:manage)` still runs before the
  // parse, so an entitled admin gets 400 (scored `allow`, no write) and everyone
  // else gets 403.
  'PUT /api/id-card/design': { size: { scalePct: 100000 } },
};

/**
 * Routes that are IP-keyed AND sit behind a long-window limiter, mapped to the
 * single principal they should be probed as.
 *
 * These are deliberately NOT run once per principal. Five endpoints carry a
 * 15-minute per-IP limiter (`auth/login` 20, `auth/change-password` 10,
 * `public/register` 20, `public/petitions/:id/sign` 30, `auth/otp/resend` 5).
 * The limiter fires BEFORE the handler, so it counts a probe even when the body
 * is invalid and the row id is a nil UUID. At eight principals per route the
 * matrix would spend 80% of the change-password budget in a single run — and
 * would EXHAUST the otp/resend budget (5) outright, so the sixth principal's
 * probe collects a 429 whose ~900 s `retry-after` stalls `call`'s backoff for
 * the rest of the window. A second run inside 15 minutes would collect 429s
 * across the board, and because `classify` maps 429 to neither `allow` nor
 * `forbidden`, every one of those would be reported as an AUTHORIZATION FAILURE.
 * That is the harness attacking itself and then scoring the self-inflicted wound
 * as a defect in the product.
 *
 * Nothing is lost: these routes declare no permission and their gate behaviour
 * does not vary by role. `login`/`register` are anonymous by definition;
 * `otp/resend` is public and enumeration-safe (always 202, or 400 on an invalid
 * body, whoever calls it); `change-password` needs only a valid session and
 * rejects the same invalid body for every role. So one representative call each
 * is the complete observation, and the reduction is stated here rather than left
 * implicit in the matrix.
 */
const SINGLE_PROBE = {
  'POST /api/auth/login': 'anonymous',
  'POST /api/public/register': 'anonymous',
  'POST /api/public/petitions/:id/sign': 'anonymous',
  'POST /api/auth/otp/resend': 'anonymous',
  'POST /api/auth/change-password': 'admin',
};

/** True when this (route, principal) pair should be skipped as a duplicate probe. */
function skipDuplicateProbe(route, principal) {
  const only = SINGLE_PROBE[`${route.method} ${route.path}`];
  return only !== undefined && only !== principal.key;
}

// ─────────────────────────────────────────────────────────────────────────────
// Expectation model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expected outcome classes:
 *   allow       — the principal is entitled through the gate; any status that is
 *                 NOT 401/403 counts (2xx, or 400/404/409/422 from validation or
 *                 a missing row).
 *   forbidden   — 403.
 *   unauthorized— 401.
 *   not-found   — 404 (route does not exist for this verb).
 */
/**
 * EVERY permission a route requires, not just the inventory's summary field.
 *
 * `route.permission` records a single permission, but a chain may carry several
 * `requirePermission` guards. `GET /api/crm/members` is
 * `authenticate → requirePermission(overview:read) → requirePermission(member:read)`,
 * and the summary field kept only the LAST one. `local_coordinator` holds
 * `member:read` but not `overview:read`, so modelling the route on the summary
 * alone expected `allow` and scored the correct 403 as a product failure (H2).
 * The desktop CRM is deliberately closed to mobile-only roles.
 */
function permissionsFor(route) {
  const prefix = 'requirePermission:';
  const fromGuards = (route.guards ?? [])
    .filter((g) => typeof g === 'string' && g.startsWith(prefix))
    .map((g) => g.slice(prefix.length));
  const all = route.permission ? [...fromGuards, route.permission] : fromGuards;
  return [...new Set(all)];
}

function expectFor(route, principal) {
  const authed = route.authenticated || route.optionalAuth;

  if (!principal.token) {
    // Anonymous.
    if (route.authenticated) return 'unauthorized';
    return 'allow';
  }
  if (!authed) return 'allow';
  const perms = permissionsFor(route);
  if (perms.length === 0) return 'allow';
  // A chain is conjunctive: every guard must pass, so the caller needs ALL of
  // the permissions it declares.
  return perms.every((p) => has(principal.role, p)) ? 'allow' : 'forbidden';
}

function classify(status) {
  if (status === 0) return 'network-error';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server-error';
  return 'allow';
}

/** True when the observed status satisfies the expected class. */
function satisfied(expected, status) {
  const actual = classify(status);
  if (expected === 'allow') return actual === 'allow' || actual === 'not-found';
  return actual === expected;
}

// ─────────────────────────────────────────────────────────────────────────────
// PII scanner — the POPIA proof
// ─────────────────────────────────────────────────────────────────────────────

const SEALED = new Set(FIXTURES.sealed ?? []);
const PII_DECRYPT = 'member:pii_decrypt';

/**
 * Staff ACCOUNT identifiers (the six test users' email + display name), and the
 * permissions that make administering them legitimate.
 *
 * `SEALED` deliberately still contains these values, so `scanPii` keeps matching
 * them everywhere. What changes is the verdict: an account's own email is the
 * primary key of the record on the two account-administration surfaces, so a
 * national admin reading `/api/crm/users` is not a disclosure — while the same
 * value appearing on ANY other route is, and is still reported (H5).
 *
 * The test is conjunctive on the route's full permission set: the caller must
 * hold every permission the route declares, and at least one of them must be an
 * account-administration permission. That keeps the exception from widening —
 * `role:manage` on a route does not bless resident PII, and an account email on
 * a member list is not blessed by the admin holding `member:read`.
 */
const ACCOUNT_IDENTITY = new Set(FIXTURES.accountIdentity ?? []);
const ACCOUNT_ADMIN_PERMISSIONS = new Set(['role:manage', 'moderate:users']);

function accountIdentityAllowed(value, principal, route) {
  if (!ACCOUNT_IDENTITY.has(value)) return false;
  const perms = permissionsFor(route);
  if (!perms.some((p) => ACCOUNT_ADMIN_PERMISSIONS.has(p))) return false;
  return perms.every((p) => has(principal.role, p));
}

/** Value patterns that indicate personal information regardless of the corpus. */
const PATTERNS = [
  { name: 'sa-phone', re: /(?:\+27|0)\s?[6-8][0-9](?:[\s-]?[0-9]){7}\b/ },
  { name: 'sa-id-number', re: /\b[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{4}(?:0|1|8|9)[0-9]{5}\b/ },
  { name: 'street-address', re: /\b\d{1,5}\s+[A-Z][A-Za-z']+(?:\s+(?:Road|Street|Avenue|Drive|Close|Crescent|Boulevard|Way|Lane|Place))\b/ },
];

/**
 * Deep-walk a parsed JSON body and report every string that is either a known
 * sealed fixture value or matches a personal-information pattern.
 */
function scanPii(node, hits, trail = '$') {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (SEALED.has(node)) hits.push({ kind: 'sealed-value', value: node, at: trail });
    for (const p of PATTERNS) {
      if (p.re.test(node)) hits.push({ kind: p.name, value: node.slice(0, 120), at: trail });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanPii(v, hits, `${trail}[${i}]`));
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      // Encrypted envelopes legitimately carry ciphertext + key ids.
      // Audit-log hash-chain fields (`prev_hash`, `entry_hash`) carry 64-char
      // SHA-256 hex digests by construction. A hex tail can coincidentally
      // match the SA-phone pattern (e.g. `...873680612251349` ends in a run
      // that reads as `0612251349`), which is a scanner artefact, not a
      // disclosure — the digest is derived from the row, not a personal
      // identifier, and is published to `admin` by design.
      // `reqId` is a UUIDv4 request correlation id — its hex groups (e.g.
      // `0944-4650` inside `0a084906-0944-4650-b4eb-…`) can also trip the
      // SA-phone pattern. Not PII.
      if (
        k === 'sealed' || k === 'wrappedDek' || k === 'keyId' || k === 'fields' || k === 'ciphertext' ||
        k === 'prev_hash' || k === 'entry_hash' || k === 'reqId'
      ) continue;
      scanPii(v, hits, `${trail}.${k}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope scanner
// ─────────────────────────────────────────────────────────────────────────────

const TOKENS = FIXTURES.tokens ?? [];
const WARD_PARENTS = FIXTURES.wardParents ?? {};
const STAFF = new Set(['national_admin', 'regional_organizer', 'local_coordinator', 'ward_councillor']);

/**
 * The wards a principal holds. `null` ⇒ national (holds everything).
 *
 * A regional principal's `regionCodes` are SUBCOUNCIL codes, so their territory
 * is every ward whose parent is one of those subcouncils. The earlier flat
 * deny-list compared ward tokens against subcouncil codes and consequently
 * reported CPT-W043 — which IS inside CPT-SC17 — as out of scope for the
 * regional organizer, i.e. it flagged the organizer's own territory as a leak.
 */
function territoryOf(principal) {
  if (!principal.token) return null;
  const national = !principal.regionCodes?.length && !principal.wardCode;
  if (national) return null;
  if (principal.wardCode) return new Set([principal.wardCode]);
  const wards = new Set(
    Object.entries(WARD_PARENTS)
      .filter(([, parent]) => principal.regionCodes.includes(parent))
      .map(([ward]) => ward),
  );
  return wards;
}

/**
 * Routes where the `territory` rule does NOT apply, each with its reason.
 *
 * The scope scanner's `territory` rule asserts that a ward-scoped caller never
 * receives a row from outside their ward. That is the right control for
 * CASEWORK and MEMBER data — a resident's service request, patrol log or member
 * record belongs to their ward's officials and to nobody else.
 *
 * It is the WRONG control for two other kinds of payload, and applying it there
 * produced 11 of the 15 "scope leaks" in the first AFTER run (H6):
 *
 *   • PUBLICATION-GATED CIVIC CONTENT (`projects`, `ward-bulletins`). The
 *     backend's own documented contract — `publishedOrInTerritory()` in
 *     `auth/scope.ts` — is that "PUBLICATION, not territory, is what makes this
 *     content public. Everyone may read whatever has been published, in any
 *     ward; territory governs only the material that is NOT yet published."
 *     Flagging a published control-ward project as a leak asserted the opposite
 *     of the contract the product implements.
 *   • OPEN CIVIC PROCESS (`participations`). `listParticipations()` takes no
 *     principal and applies no scope at all: a public participation process is
 *     open to every resident by design, and the client narrows it with
 *     `?wardCode=`. Restricting it to one ward would defeat its purpose.
 *   • REFERENCE GEOMETRY (`geo/boundaries`). Ward boundary polygons are electoral
 *     reference data containing no personal information; `/api/public/wards`
 *     serves the same ward list to anonymous callers.
 *
 * Only the `territory` rule is lifted. `draft`, `private` and `own` tokens still
 * apply on every one of these routes — which is what keeps the assertion sharp:
 * a DRAFT project or bulletin from another ward is still a hard failure here,
 * and that is exactly the gate D43 fixed.
 */
const NON_TERRITORIAL_ROUTES = new Set([
  'GET /api/geo/boundaries',
  'GET /api/projects',
  'GET /api/projects/:id',
  'GET /api/ward-bulletins',
  'GET /api/ward-bulletins/:id',
  'GET /api/participations',
  'GET /api/participations/:id',
]);

/**
 * Which restricted tokens this principal must never receive.
 *
 *   territory — forbidden unless the token's ward is inside the caller's territory
 *   private   — forbidden to non-staff regardless of territory (FR-E)
 *   own       — forbidden to everyone except the named owner
 *   draft     — forbidden to non-staff everywhere, and to staff outside the
 *               token's ward: publication, not territory, is what makes civic
 *               content public
 *
 * A principal's own records are always allowed to them: the out-of-scope
 * control member legitimately sees their own resident report at
 * `GET /api/transparency/reports?scope=mine`, and treating that as a leak would
 * have hidden the real cross-ward disclosure behind a false positive.
 */
function forbiddenTokensFor(principal, route = null) {
  if (!principal.token) return [];
  const territory = territoryOf(principal);
  const staff = STAFF.has(principal.role);
  const nonTerritorial = route ? NON_TERRITORIAL_ROUTES.has(`${route.method} ${route.path}`) : false;
  const out = [];
  for (const t of TOKENS) {
    if (t.owner && t.owner === principal.key) continue;
    if (t.rule === 'own') { out.push(t.token); continue; }
    if (t.rule === 'private') { if (!staff) out.push(t.token); continue; }
    if (t.rule === 'draft') {
      if (!staff) { out.push(t.token); continue; }
      if (territory !== null && !territory.has(t.ward)) out.push(t.token);
      continue;
    }
    // territory
    if (nonTerritorial) continue; // publication / open process / reference data
    if (territory === null) continue; // national scope legitimately sees all
    if (!territory.has(t.ward)) out.push(t.token);
  }
  return [...new Set(out)];
}

function scanScope(node, forbidden, hits, trail = '$') {
  if (!forbidden.length) return;
  if (typeof node === 'string') {
    for (const t of forbidden) {
      if (t && node.includes(t)) hits.push({ token: t, value: node.slice(0, 160), at: trail });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanScope(v, forbidden, hits, `${trail}[${i}]`));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) scanScope(v, forbidden, hits, `${trail}.${k}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public baseline — calibrating the PII scanner against published content
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strings an ANONYMOUS caller can already read are published by design and are
 * not a disclosure. One fixture value is exactly that: the party's own
 * head-office address in /api/public/manifesto and /api/public/meta — an
 * organisational address, not personal information, which the `street-address`
 * pattern matched.
 *
 * The ward councillor's display name on the transparency overview is the OTHER
 * such value, and it is handled differently on purpose. This comment used to
 * claim the derived baseline covered it, but the overview was never listed in
 * `PUBLIC_SURFACES`, so the name was scored as a sealed-PII leak on all eight
 * principals (H4). Rather than add the surface to this list, it is declared in
 * the corpus as `publicByDesign` and seeded into the baseline below: deriving the
 * baseline by calling an endpoint means a value that endpoint leaked BY ACCIDENT
 * would be absorbed into its own baseline and disappear from the report. The
 * seeder's declaration cannot be corrupted by the thing it is judging.
 *
 * Baseline hits are still counted and listed in the report — as
 * `public-baseline`, not as failures — so a sealed value that ever reached a
 * public surface stays visible to a human reader instead of being silently
 * swallowed.
 */
const PUBLIC_SURFACES = [
  '/api/public/meta',
  '/api/public/manifesto',
  '/api/public/wards',
  '/api/events',
  // A MIXED surface: anonymous may read it, but only its published rows. Listing
  // it here calibrates the baseline against what is genuinely public; the
  // unpublished rows are pinned by dedicated probes (see D41) rather than by the
  // matrix scope scanner, which skips unauthenticated routes on the (otherwise
  // sound) reasoning that territory is not what governs them.
  '/api/posts',
];

let PUBLIC_BASELINE = new Set();

async function buildPublicBaseline() {
  // Declared publications first: they are baseline regardless of what any live
  // endpoint currently returns, and they are not re-derived from one.
  const values = new Set(FIXTURES.publicByDesign ?? []);
  const declared = values.size;
  const walk = (node) => {
    if (typeof node === 'string') { if (node.length > 2) values.add(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  for (const path_ of PUBLIC_SURFACES) {
    const res = await call('GET', path_);
    if (res.json) walk(res.json);
  }
  PUBLIC_BASELINE = values;
  say(C.grey(`  public baseline: ${values.size} published strings from ${PUBLIC_SURFACES.length} surfaces + ${declared} declared`));
}

const isPublicBaseline = (value) => PUBLIC_BASELINE.has(value);

export { call, classify, expectFor, satisfied, scanPii, scanScope, PRINCIPALS, BASE, ARTIFACTS, IDS, FIXTURES, MATRIX, ROUTES, has, loginAll, fillPath, forbiddenTokensFor, territoryOf, buildPublicBaseline, isPublicBaseline, accountIdentityAllowed, permissionsFor, DESTRUCTIVE, MUTATING, INVALID_BODY, PROBE_BODY_OVERRIDES, SINGLE_PROBE, skipDuplicateProbe, RECORD_ONLY, ONLY, TAG, SKIP_ACCURACY, say, C, PII_DECRYPT, PARAM_DEFAULTS };
