#!/usr/bin/env node
/**
 * role-audit.mjs — runner for the role × endpoint audit.
 *
 * See role-audit-lib.mjs for the harness primitives and the full rationale.
 *
 *   npm run role:audit                 # assert + write artifacts, exit 1 on any failure
 *   npm run role:audit -- --record     # capture actual behaviour only (no assertions)
 *   npm run role:audit -- --only crm   # restrict to routes whose path contains "crm"
 *   npm run role:audit -- --tag after  # artifact filename tag
 *   TARGET_BASE=https://origin npm run role:audit   # run against production, unchanged
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  BASE, ARTIFACTS, ROUTES, IDS, FIXTURES, MATRIX, PRINCIPALS,
  call, classify, expectFor, satisfied, scanPii, scanScope,
  has, loginAll, fillPath, forbiddenTokensFor, buildPublicBaseline, isPublicBaseline,
  accountIdentityAllowed,
  DESTRUCTIVE, MUTATING, INVALID_BODY, PROBE_BODY_OVERRIDES, skipDuplicateProbe,
  RECORD_ONLY, ONLY, TAG, SKIP_ACCURACY, say, C, PII_DECRYPT,
} from './role-audit-lib.mjs';
import { runAccuracyChecks } from './role-audit-accuracy.mjs';

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const suffix = TAG ? `-${TAG}` : '';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Authorization matrix
// ─────────────────────────────────────────────────────────────────────────────

async function runMatrix() {
  const routes = ONLY ? ROUTES.filter((r) => r.path.includes(ONLY)) : ROUTES;
  // Expand to (route, principal) pairs up front so the reported call count is the
  // number ACTUALLY made. The IP-limited credential routes are probed once rather
  // than once per principal (see SINGLE_PROBE in role-audit-lib.mjs); silently
  // omitting them from a "130 × 8 = 1040" headline would overstate coverage.
  const plan = [];
  for (const route of routes) {
    for (const p of PRINCIPALS) {
      if (skipDuplicateProbe(route, p)) continue;
      plan.push([route, p]);
    }
  }
  const results = [];
  let done = 0;
  const total = plan.length;
  const withheld = routes.length * PRINCIPALS.length - total;

  say(C.bold(`\n① Authorization matrix — ${routes.length} routes × ${PRINCIPALS.length} principals = ${total} calls\n`));
  if (withheld > 0) {
    say(C.grey(`   ${withheld} duplicate probes withheld on IP-limited credential routes (SINGLE_PROBE)`));
  }

  for (const [route, p] of plan) {
    const key = `${route.method} ${route.path}`;
    const rel = fillPath(route, p);
    const expected = expectFor(route, p);

    // Destructive routes are only probed where the answer must be "denied".
    const denyOnly = DESTRUCTIVE.has(key) && expected === 'allow';
    const body = MUTATING.has(route.method) ? (PROBE_BODY_OVERRIDES[key] ?? INVALID_BODY) : undefined;

    let res;
    if (denyOnly) {
      res = { status: null, skipped: true };
    } else {
      res = await call(route.method, rel, { token: p.token, body });
    }

    const rec = {
      route: key,
      method: route.method,
      path: route.path,
      url: res.url ?? rel,
      principal: p.key,
      role: p.role,
      scope: p.wardCode ? `ward:${p.wardCode}` : p.regionCodes?.length ? `region:${p.regionCodes.join('+')}` : p.token ? 'national' : 'anonymous',
      permission: route.permission,
      authenticated: route.authenticated,
      expected,
      status: res.status,
      actual: res.skipped ? 'skipped' : classify(res.status),
      // A 429 is the server's rate limiter, not an authorization decision.
      // Scoring it as a failure would attribute the harness's own traffic to the
      // product, so it is left unscored — but counted separately below so that it
      // can never quietly disappear from the report either.
      pass: res.skipped || classify(res.status) === 'rate-limited' ? null : satisfied(expected, res.status),
      rateLimited: !res.skipped && classify(res.status) === 'rate-limited',
      timedOut: Boolean(res.timedOut),
      piiHits: [],
      scopeHits: [],
      error: res.error ?? null,
      bytes: res.text?.length ?? 0,
    };

    if (!res.skipped && res.json && !RECORD_ONLY) {
      // ── POPIA: sealed values must never surface here ──
      // The matrix never sends ?pii=true, so a sealed value in ANY response is
      // a disclosure — including for the roles that hold `member:pii_decrypt`,
      // which are entitled to it only on an explicit, audited, per-record
      // request. Two classes of hit are reclassified rather than failed, and
      // each carries a `via` tag in the artifact so a human can see exactly why
      // it was excused:
      //   • `public-baseline`  — anonymous can already read it;
      //   • `account-admin`    — a staff ACCOUNT identifier on one of the two
      //                          account-administration routes, to a caller
      //                          holding every permission that route declares.
      // Resident PII is never excused by either, and an account identifier on
      // any other route is still a hard leak (H5).
      {
        const hits = [];
        scanPii(res.json, hits);
        const real = [];
        const baseline = [];
        for (const h of hits) {
          if (isPublicBaseline(h.value)) baseline.push({ ...h, via: 'public-baseline' });
          else if (accountIdentityAllowed(h.value, p, route)) baseline.push({ ...h, via: 'account-admin' });
          else real.push(h);
        }
        rec.piiHits = real.slice(0, 12);
        rec.piiBaselineHits = baseline.slice(0, 12);
        rec.piiLeak = real.length > 0;
        rec.piiEntitled = has(p.role, PII_DECRYPT);
      }
      // ── Scope: rows from outside the caller's territory must never surface ──
      // Skipped on unauthenticated routes: if anonymous can read the surface,
      // territory is not the control that governs it (published civic content
      // such as /api/events and /api/public/meta is national by design).
      // The route is passed so that `forbiddenTokensFor` can lift the TERRITORY
      // rule on the routes governed by publication or open civic process
      // instead — see NON_TERRITORIAL_ROUTES (H6). The `draft`, `private` and
      // `own` rules still apply on every route.
      if (route.authenticated) {
        const forbidden = forbiddenTokensFor(p, route);
        if (forbidden.length) {
          const hits = [];
          scanScope(res.json, forbidden, hits);
          rec.scopeHits = hits.slice(0, 12);
          rec.scopeLeak = hits.length > 0;
        }
      }
    }

    results.push(rec);
    done++;
    if (done % 50 === 0) process.stderr.write(`  ${done}/${total} calls\r`);
  }
  process.stderr.write(`  ${total}/${total} calls\n`);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Targeted scope / POPIA probes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A member id that IS inside the named principal's declared territory.
 *
 * Needed because the positive PII-decrypt probe must not be aimed at an
 * arbitrary fixture: `IDS.members[0]` sits in CPT-W009 (Table View), outside
 * every Mitchell's Plain principal, so a 403 there would prove nothing about
 * decryption. Territory is resolved from the corpus the seeder published
 * (`wardParents` + the account's own regionCodes/wardCode), not from a ward code
 * written into this file, so the probe cannot drift from the fixtures.
 */
function memberInTerritory(key) {
  const acct = PRINCIPALS.find((p) => p.key === key);
  const rows = IDS.members ?? [];
  if (!acct || rows.length === 0) return '00000000-0000-0000-0000-000000000000';
  const national = !acct.regionCodes?.length && !acct.wardCode;
  if (national) return rows[0].id;
  const holds = (ward) =>
    acct.wardCode ? ward === acct.wardCode : (acct.regionCodes ?? []).includes(FIXTURES.wardParents?.[ward]);
  return (rows.find((r) => holds(r.ward)) ?? rows[0]).id;
}

/**
 * Every `title` in a response, for EXACT set-membership assertions.
 *
 * The scope scanner can only say "a forbidden string appeared". For the posts
 * publication gate (D41) that is not enough: the control has a positive half —
 * a regional organizer MUST still see the drafts inside their own subcouncils —
 * and a scanner that only looks for absence would pass just as happily if the
 * endpoint returned nothing at all. `expectTitles` / `forbidTitles` pin both
 * halves against the fixture rows the seeder published, so neither the gate nor
 * the legitimate access can be removed without a red probe.
 */
function titlesIn(json) {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (typeof n.title === 'string') out.push(n.title);
      for (const v of Object.values(n)) walk(v);
    }
  };
  walk(json);
  return out;
}

/** Resolve a fixture post by predicate. `null` ⇒ the fixture is missing, which
 *  makes any probe that names it fail loudly instead of passing vacuously. */
function postBy(pred) {
  return (IDS.posts ?? []).find(pred) ?? null;
}
const postTitle = (pred) => postBy(pred)?.title ?? null;
const postId = (pred) => postBy(pred)?.id ?? 'missing-fixture';
/** Trim the `[MP-VAL] ` fixture prefix so failure reasons stay readable. */
const shortTitle = (t) => (t == null ? '(MISSING FIXTURE)' : String(t).replace(/^\[MP-VAL\]\s*/, ''));

const W_PRIMARY = IDS.wards?.primary;
const W_CONTROL = IDS.wards?.control;
const W_OUTSIDE = IDS.wards?.outside ?? [];

/** Draft in the councillor's own ward — visible to `post:moderate` holders in CPT-SC17. */
const POST_DRAFT_OWN = postTitle((p) => p.status === 'draft' && p.ward === W_PRIMARY);
/** Draft in the ADJACENT control ward: same subcouncil, different ward. */
const POST_DRAFT_CTRL = postTitle((p) => p.status === 'draft' && p.ward === W_CONTROL);
/** Draft outside the regional organizer's subcouncils entirely — national only. */
const POST_DRAFT_OUT = postTitle((p) => p.status === 'draft' && W_OUTSIDE.includes(p.ward));
/** Taken-down note: carries an internal moderation reason. */
const POST_TAKEDOWN = postTitle((p) => p.status === 'taken_down');
/** Published row outside Mitchell's Plain: public to everyone, including anonymous. */
const POST_PUB_OUT = postTitle((p) => p.status === 'published' && W_OUTSIDE.includes(p.ward));
/** Every non-published title — the set that must never reach a non-moderator. */
const POST_ALL_UNPUBLISHED = [POST_DRAFT_OWN, POST_DRAFT_CTRL, POST_DRAFT_OUT, POST_TAKEDOWN];

/**
 * Resident reports, which are gated on AUTHORSHIP rather than territory
 * (migration 009: "the report is private to the author and the ward's staff").
 * Each row carries `owner_email` so the probes below can pick a report a given
 * principal did or did not write.
 */
const REPORT_PRIMARY = (IDS.reports ?? []).find((r) => r.ward_code === W_PRIMARY);
const REPORT_CONTROL = (IDS.reports ?? []).find((r) => r.ward_code === W_CONTROL);
// Fail loudly rather than vacuously. Without a row to point at the URL would
// resolve to `/reports/undefined`, the resulting 404 would SATISFY the three
// denial probes, and the authorship gate would be reported as proven while never
// having been exercised — the same trap as a `limit` above the schema maximum
// turning every list into an empty one.
if (!REPORT_PRIMARY || !REPORT_CONTROL) {
  throw new Error(
    `resident-report fixtures missing (primary=${REPORT_PRIMARY?.ref_no ?? 'none'}, ` +
      `control=${REPORT_CONTROL?.ref_no ?? 'none'}) — authorship probes R1–R6 cannot run. ` +
      'Re-run `npm run seed:validation`.',
  );
}

/**
 * The matrix proves the gate. These probes prove the DATA: a ward-scoped
 * principal must not receive another ward's rows even when the route allows
 * them through, and PII must stay sealed without an explicit `?pii=true`.
 */
const SCOPE_PROBES = [
  {
    id: 'S1',
    // CPT-W043 is deliberately the ADJACENT control ward: it shares subcouncil
    // CPT-SC17 with the councillor's own CPT-W079, so a region-only scope check
    // (`principal.regionCodes.includes(...)`) passes it and the ward detail
    // leaks. Only a ward-aware check returns 403/404 here. This probe is the
    // regression pin for that whole defect class.
    title: "Ward councillor cannot read another ward's detail in its OWN subcouncil",
    principal: 'councillor',
    method: 'GET',
    url: `/api/transparency/wards/${IDS.wards.control}/detail`,
    expectStatus: [403, 404],
  },
  {
    id: 'S2',
    title: 'Out-of-scope member cannot read the primary ward detail',
    principal: 'memberOutside',
    method: 'GET',
    url: `/api/transparency/wards/${IDS.wards.primary}/detail`,
    expectStatus: [403, 404],
  },
  {
    id: 'S3',
    title: 'Own-ward member CAN read their own ward detail (positive control)',
    principal: 'member',
    method: 'GET',
    url: `/api/transparency/wards/${IDS.wards.primary}/detail`,
    expectStatus: [200],
    forbidTokens: true,
  },
  {
    id: 'S4',
    title: 'Ward councillor case list excludes the control ward',
    principal: 'councillor',
    method: 'GET',
    url: '/api/service-requests?limit=200',
    expectStatus: [200],
    forbidTokens: true,
  },
  {
    id: 'S5',
    title: 'Regional organizer cannot read a region outside its scope',
    principal: 'regional',
    method: 'GET',
    url: '/api/service-requests?regionCode=CPT-SC1&limit=200',
    expectStatus: [200, 403],
    forbidTokens: true,
  },
  {
    id: 'S6',
    title: 'CRM engagements are ward-scoped for a councillor',
    principal: 'councillor',
    method: 'GET',
    url: '/api/crm/engagements?limit=200',
    expectStatus: [200, 403],
    forbidTokens: true,
  },
  {
    id: 'S7',
    title: 'CRM member list is ward-scoped for a councillor',
    principal: 'councillor',
    method: 'GET',
    url: '/api/crm/members?limit=200',
    expectStatus: [200, 403],
    forbidTokens: true,
  },
  // ── Resident reports: the AUTHORSHIP gate ────────────────────────────────
  // `GET /api/transparency/reports/:id` declares no permission at all, so the
  // matrix cannot model it: `expectFor` sees an authenticated route with an
  // empty permission set and expects `allow`. The gate lives in the handler
  // (`isOwner || (staff && inTerritory)`), which means the matrix row for a
  // principal with no eligible report resolves to the nil UUID and a 404 — a
  // pass that proves nothing. These probes are what actually pin the control.
  //
  // R1 is the finding that exposed the gap: the national-scope `analyst` is not
  // in STAFF_ROLES, so it must NOT be able to open an individual resident's
  // report (free-text message, GPS fix and photos) even though its territory is
  // the whole country. R2 pins the regression named in the handler's own comment
  // — a coordinator scoped to one branch ward previously reached every report in
  // the country. R4/R5/R6 are the positive controls: without them R1–R3 would
  // also pass if the endpoint were simply broken for everyone.
  {
    id: 'R1',
    title: 'Non-staff analyst cannot read an individual resident report',
    principal: 'analyst',
    method: 'GET',
    url: `/api/transparency/reports/${REPORT_PRIMARY.id}`,
    expectStatus: [403, 404],
  },
  {
    id: 'R2',
    title: 'Coordinator cannot read a resident report outside its ward',
    principal: 'coordinator',
    method: 'GET',
    url: `/api/transparency/reports/${REPORT_PRIMARY.id}`,
    expectStatus: [403, 404],
  },
  {
    id: 'R3',
    title: "Out-of-scope member cannot read another ward's resident report",
    principal: 'memberOutside',
    method: 'GET',
    url: `/api/transparency/reports/${REPORT_PRIMARY.id}`,
    expectStatus: [403, 404],
  },
  {
    id: 'R4',
    title: 'Author CAN read their own resident report (positive control)',
    principal: 'member',
    method: 'GET',
    url: `/api/transparency/reports/${REPORT_PRIMARY.id}`,
    expectStatus: [200],
    forbidTokens: true,
  },
  {
    id: 'R5',
    title: 'Ward staff CAN read a report from their own ward (positive control)',
    principal: 'councillor',
    method: 'GET',
    url: `/api/transparency/reports/${REPORT_PRIMARY.id}`,
    expectStatus: [200],
    forbidTokens: true,
  },
  {
    id: 'R6',
    title: 'Out-of-scope member CAN read their OWN report (positive control)',
    principal: 'memberOutside',
    method: 'GET',
    url: `/api/transparency/reports/${REPORT_CONTROL.id}`,
    expectStatus: [200],
    forbidTokens: true,
  },
  {
    id: 'P1',
    title: 'Member cannot decrypt sealed PII',
    principal: 'member',
    method: 'GET',
    url: '/api/members?pii=true&limit=50',
    expectStatus: [403],
  },
  {
    id: 'P2',
    title: 'Ward councillor cannot decrypt sealed PII',
    principal: 'councillor',
    method: 'GET',
    url: '/api/members?pii=true&limit=50',
    expectStatus: [403],
  },
  {
    id: 'P3',
    title: 'Analyst cannot decrypt sealed PII and cannot list members',
    principal: 'analyst',
    method: 'GET',
    url: '/api/members?pii=true&limit=50',
    expectStatus: [403],
  },
  {
    id: 'P4',
    title: 'Analyst is barred from the CRM member directory',
    principal: 'analyst',
    method: 'GET',
    url: '/api/crm/members?limit=50',
    expectStatus: [403],
  },
  {
    id: 'P5',
    title: 'Analyst is barred from the CRM audit log',
    principal: 'analyst',
    method: 'GET',
    url: '/api/crm/audit?limit=50',
    expectStatus: [403],
  },
  {
    id: 'P6',
    title: 'Member is barred from the CRM member directory',
    principal: 'member',
    method: 'GET',
    url: '/api/crm/members?limit=50',
    expectStatus: [403],
  },
  {
    id: 'P7',
    // Corrected: this used to call the LIST endpoint with ?pii=true and expect
    // 200. Bulk decryption is deliberately refused for EVERY role — including
    // national_admin — so that each disclosure is one audited record
    // (members/routes.ts). The old probe therefore asserted behaviour the system
    // intentionally forbids, and "failed" against a correct backend. The positive
    // control now targets a single in-territory member, and `requireSealed`
    // ensures a 200 with no decrypted values cannot pass.
    title: 'Regional organizer CAN decrypt a single member (permission held, audited)',
    principal: 'regional',
    method: 'GET',
    url: `/api/members/${memberInTerritory('regional')}?pii=true`,
    expectStatus: [200],
    requireSealed: true,
  },
  {
    id: 'P8',
    title: 'Without ?pii=true the member list carries no sealed values',
    principal: 'regional',
    method: 'GET',
    url: '/api/members?limit=50',
    expectStatus: [200],
    forbidSealed: true,
  },
  {
    id: 'P9',
    // Pins POPIA data minimisation: no role, not even national_admin, may
    // bulk-decrypt the directory in one request. Without this probe the control
    // could be quietly removed and every other PII assertion would still pass.
    title: 'Bulk ?pii=true is refused even for national_admin (data minimisation)',
    principal: 'admin',
    method: 'GET',
    url: '/api/members?pii=true&limit=5',
    expectStatus: [400],
  },
  {
    id: 'P10',
    // Single-record decrypt for a role that lacks PII_DECRYPT: must be denied
    // outright, not returned with the sealed fields merely blanked.
    title: 'Ward councillor is denied single-member decryption',
    principal: 'councillor',
    method: 'GET',
    url: `/api/members/${memberInTerritory('councillor')}?pii=true`,
    expectStatus: [403],
  },
  {
    id: 'A1',
    title: 'Anonymous cannot reach the CRM',
    principal: 'anonymous',
    method: 'GET',
    url: '/api/crm/dashboard',
    expectStatus: [401],
  },
  {
    id: 'A2',
    title: 'Anonymous cannot reach the audit log',
    principal: 'anonymous',
    method: 'GET',
    url: '/api/audit/entries',
    expectStatus: [401],
  },
  {
    id: 'A3',
    title: 'Local coordinator is barred from the moderation ladder',
    principal: 'coordinator',
    method: 'GET',
    url: '/api/moderation/users',
    expectStatus: [403],
  },
  {
    id: 'A4',
    title: 'Analyst is barred from role management',
    principal: 'analyst',
    method: 'GET',
    url: '/api/crm/users',
    expectStatus: [403],
  },

  // ── W2: the module registry (module:manage) ──────────────────────────────
  // `GET/PUT /api/crm/modules*` sit behind the router-level `overview:read` AND
  // a route-level `module:manage`. The matrix auto-derives the allow/deny from
  // those tags, but M2 is the distinction worth pinning in words: a
  // regional_organizer HOLDS `overview:read` (so it reaches the rest of the CRM)
  // and must STILL be refused the registry — the power to strip a whole module's
  // permissions from a role is national-admin only. The PUT probes are sent with
  // no body, so an entitled caller is rejected by the handler's `enabled`
  // validation (400) and never mutates a gate; a non-entitled caller is refused
  // at the permission layer (403) before the handler runs.
  {
    id: 'M1',
    title: 'National admin CAN read the module registry',
    principal: 'admin',
    method: 'GET',
    url: '/api/crm/modules',
    expectStatus: [200],
  },
  {
    id: 'M2',
    title: 'Regional organizer is barred from the module registry despite CRM access',
    principal: 'regional',
    method: 'GET',
    url: '/api/crm/modules',
    expectStatus: [403],
  },
  {
    id: 'M3',
    title: 'Member is barred from the module registry',
    principal: 'member',
    method: 'GET',
    url: '/api/crm/modules',
    expectStatus: [403],
  },
  {
    id: 'M4',
    title: 'National admin reaches the gate-change endpoint (invalid body, no mutation)',
    principal: 'admin',
    method: 'PUT',
    url: '/api/crm/modules/member/cases',
    expectStatus: [400],
  },
  {
    id: 'M5',
    title: 'Local coordinator is barred from changing a module gate',
    principal: 'coordinator',
    method: 'PUT',
    url: '/api/crm/modules/member/cases',
    expectStatus: [403],
  },

  // ── W2: the resident-report surface (report:write / report:read) ─────────
  // `POST /api/transparency/reports` is tagged `report:write`, so the matrix
  // covers it. `GET /api/transparency/reports` is NOT: its `report:read` guard
  // fires only for `?scope=inbox` (an inline arrow, deliberately untagged so the
  // matrix keeps reading the default `?scope=mine` as open-to-authenticated). A
  // query-conditional guard is exactly what the matrix cannot model, so these
  // probes pin the ward-inbox half: staff read the inbox, a member (who holds
  // `report:write` but NOT `report:read`) and an analyst (neither) are refused,
  // and the analyst is refused the submit surface too.
  {
    id: 'RG1',
    title: 'Analyst cannot read the ward report inbox',
    principal: 'analyst',
    method: 'GET',
    url: '/api/transparency/reports?scope=inbox',
    expectStatus: [403],
  },
  {
    id: 'RG2',
    title: 'Member cannot read the ward report inbox (report:write, not report:read)',
    principal: 'member',
    method: 'GET',
    url: '/api/transparency/reports?scope=inbox',
    expectStatus: [403],
  },
  {
    id: 'RG3',
    title: 'Ward councillor CAN read the ward report inbox (positive control)',
    principal: 'councillor',
    method: 'GET',
    url: '/api/transparency/reports?scope=inbox',
    expectStatus: [200],
  },
  {
    id: 'RG4',
    title: 'Analyst cannot submit a resident report (no report:write)',
    principal: 'analyst',
    method: 'POST',
    url: '/api/transparency/reports',
    expectStatus: [403],
  },
  {
    id: 'RG5',
    title: 'Member reaches the report-submit endpoint (invalid body, no mutation)',
    principal: 'member',
    method: 'POST',
    url: '/api/transparency/reports',
    expectStatus: [400, 422],
  },

  // ── D41: the posts publication gate ──────────────────────────────────────
  // `/api/posts` is a MIXED surface — anonymous may read it — so the matrix's
  // scope scanner skips it and these probes are the only thing covering it.
  // Before the fix, `?status=draft` was honoured verbatim for EVERY caller: an
  // unauthenticated visitor could enumerate all four unpublished posts in the
  // country plus the moderation reason on the taken-down one, and any
  // `post:moderate` holder could read another subcouncil's internal drafts.
  {
    id: 'D1',
    title: 'Anonymous cannot list draft posts',
    principal: 'anonymous',
    method: 'GET',
    url: '/api/posts?status=draft&limit=100',
    expectStatus: [200],
    forbidTitles: POST_ALL_UNPUBLISHED,
  },
  {
    id: 'D2',
    title: 'Anonymous cannot list taken-down posts (moderation reasons)',
    principal: 'anonymous',
    method: 'GET',
    url: '/api/posts?status=taken_down&limit=100',
    expectStatus: [200],
    forbidTitles: [POST_TAKEDOWN],
  },
  {
    id: 'D3',
    // Positive half: `status=all` for a non-moderator must still return the
    // PUBLISHED rows, including one outside Mitchell's Plain — publication, not
    // territory, is what makes civic content public. Without this the gate could
    // be "fixed" by returning nothing to everybody.
    title: 'Anonymous status=all returns published rows only, from any ward',
    principal: 'anonymous',
    method: 'GET',
    url: '/api/posts?status=all&limit=100',
    expectStatus: [200],
    expectTitles: [POST_PUB_OUT],
    forbidTitles: POST_ALL_UNPUBLISHED,
  },
  {
    id: 'D4',
    title: 'Member cannot list draft posts',
    principal: 'member',
    method: 'GET',
    url: '/api/posts?status=draft&limit=100',
    expectStatus: [200],
    forbidTitles: POST_ALL_UNPUBLISHED,
  },
  {
    id: 'D5',
    title: 'Analyst cannot list draft posts',
    principal: 'analyst',
    method: 'GET',
    url: '/api/posts?status=draft&limit=100',
    expectStatus: [200],
    forbidTitles: POST_ALL_UNPUBLISHED,
  },
  {
    id: 'D6',
    // A local_coordinator is STAFF but holds neither post:write nor
    // post:moderate, so the publication gate is not theirs to lift — not even for
    // a draft sitting in their own ward.
    title: 'Local coordinator cannot list draft posts (no post:moderate)',
    principal: 'coordinator',
    method: 'GET',
    url: '/api/posts?status=draft&limit=100',
    expectStatus: [200],
    forbidTitles: POST_ALL_UNPUBLISHED,
  },
  {
    id: 'D7',
    title: 'Ward councillor cannot list drafts, not even in their own ward',
    principal: 'councillor',
    method: 'GET',
    url: '/api/posts?status=draft&limit=100',
    expectStatus: [200],
    forbidTitles: POST_ALL_UNPUBLISHED,
  },
  {
    id: 'D8',
    // THE D41 PIN. A regional_organizer holds post:moderate for CPT-SC17/SC12
    // only. The CPT-W009 draft belongs to CPT-SC4: receiving it means the
    // moderator's view was national rather than territorial. The two in-territory
    // drafts must still arrive, so a blanket deny cannot pass this probe either.
    title: 'Regional organizer sees in-territory drafts but NOT another subcouncil\'s',
    principal: 'regional',
    method: 'GET',
    url: '/api/posts?status=draft&limit=100',
    expectStatus: [200],
    expectTitles: [POST_DRAFT_OWN, POST_DRAFT_CTRL],
    forbidTitles: [POST_DRAFT_OUT],
  },
  {
    id: 'D9',
    title: 'Regional organizer status=all excludes the out-of-region draft',
    principal: 'regional',
    method: 'GET',
    url: '/api/posts?status=all&limit=100',
    expectStatus: [200],
    expectTitles: [POST_PUB_OUT, POST_DRAFT_OWN],
    forbidTitles: [POST_DRAFT_OUT],
  },
  {
    id: 'D10',
    // Positive control for national scope: if this ever fails, D8/D9 could be
    // passing because nobody can see drafts at all.
    title: 'National admin sees every draft, in every subcouncil',
    principal: 'admin',
    method: 'GET',
    url: '/api/posts?status=draft&limit=100',
    expectStatus: [200],
    expectTitles: [POST_DRAFT_OWN, POST_DRAFT_CTRL, POST_DRAFT_OUT],
  },
  {
    id: 'D11',
    title: 'Ward councillor cannot read a control-ward draft by id (404, no oracle)',
    principal: 'councillor',
    method: 'GET',
    url: `/api/posts/${postId((p) => p.status === 'draft' && p.ward === W_CONTROL)}`,
    expectStatus: [404],
  },
  {
    id: 'D12',
    title: 'Regional organizer cannot read an out-of-region draft by id',
    principal: 'regional',
    method: 'GET',
    url: `/api/posts/${postId((p) => p.status === 'draft' && W_OUTSIDE.includes(p.ward))}`,
    expectStatus: [404],
  },
  {
    id: 'D13',
    title: 'National admin CAN read the out-of-region draft by id',
    principal: 'admin',
    method: 'GET',
    url: `/api/posts/${postId((p) => p.status === 'draft' && W_OUTSIDE.includes(p.ward))}`,
    expectStatus: [200],
  },
  {
    id: 'D14',
    title: 'Anonymous cannot read a taken-down post by id (moderation reason)',
    principal: 'anonymous',
    method: 'GET',
    url: `/api/posts/${postId((p) => p.status === 'taken_down')}`,
    expectStatus: [404],
  },
];

async function runProbes() {
  const out = [];
  say(C.bold(`\n② Targeted scope / POPIA probes — ${SCOPE_PROBES.length}\n`));
  for (const probe of SCOPE_PROBES) {
    const p = PRINCIPALS.find((x) => x.key === probe.principal);
    if (!p) {
      out.push({ ...probe, status: null, pass: false, reason: 'unknown principal' });
      continue;
    }
    const res = await call(probe.method, probe.url, { token: p.token });
    const statusOk = probe.expectStatus.includes(res.status);

    const forbidden = probe.forbidTokens ? forbiddenTokensFor(p) : [];
    const scopeHits = [];
    const piiHits = [];
    let sealedFound = 0;
    if (res.json) {
      if (forbidden.length) scanScope(res.json, forbidden, scopeHits);
      if (probe.forbidSealed && !has(p.role, PII_DECRYPT)) scanPii(res.json, piiHits);
      if (probe.forbidSealed && has(p.role, PII_DECRYPT)) {
        // Holds the permission but did NOT ask for it: sealed values must still
        // be absent from a plain list call.
        scanPii(res.json, piiHits);
      }
      if (probe.requireSealed) {
        // Positive control. A 200 alone proves nothing: if decryption silently
        // returned nothing the probe would pass while the feature is broken, the
        // same vacuous-pass trap the seeder's corpus check guards against.
        const found = [];
        scanPii(res.json, found);
        sealedFound = found.length;
      }
    }

    const sealedOk = !probe.requireSealed || sealedFound > 0;

    // Exact set-membership assertions (D41). `titles` is only meaningful for a
    // list response; a missing fixture resolves to null, which no title equals,
    // so the probe fails loudly rather than passing on an empty set.
    const titles = res.json ? titlesIn(res.json) : [];
    const missingTitles = (probe.expectTitles ?? []).filter((t) => !titles.includes(t));
    const leakedTitles = (probe.forbidTitles ?? []).filter((t) => t != null && titles.includes(t));

    const pass =
      statusOk && scopeHits.length === 0 && piiHits.length === 0 && sealedOk &&
      missingTitles.length === 0 && leakedTitles.length === 0;
    const rec = {
      ...probe,
      principalRole: p.role,
      status: res.status,
      statusOk,
      sealedFound: probe.requireSealed ? sealedFound : undefined,
      scopeHits: scopeHits.slice(0, 10),
      piiHits: piiHits.slice(0, 10),
      missingTitles,
      leakedTitles,
      titlesReturned: probe.expectTitles || probe.forbidTitles ? titles.length : undefined,
      pass: RECORD_ONLY ? null : pass,
      reason: !statusOk
        ? `expected HTTP ${probe.expectStatus.join('|')}, got ${res.status}`
        : leakedTitles.length
          ? `unpublished rows disclosed (${leakedTitles.length}): ${leakedTitles.map(shortTitle).join(', ')}`
          : missingTitles.length
            ? `expected rows ABSENT (${missingTitles.length}): ${missingTitles.map(shortTitle).join(', ')} — the control may be denying legitimate access, or the fixture is missing`
            : scopeHits.length
              ? `out-of-scope rows returned (${scopeHits.length})`
              : piiHits.length
                ? `sealed PII returned (${piiHits.length})`
                : !sealedOk
                  ? 'decryption returned no sealed values — control unproven'
                  : probe.requireSealed
                    ? `ok (decrypted ${sealedFound} sealed value(s))`
                    : probe.expectTitles
                      ? `ok (${titles.length} row(s), all ${probe.expectTitles.length} expected present)`
                      : 'ok',
    };
    out.push(rec);
    const mark = RECORD_ONLY ? C.grey('·') : pass ? C.green('✓') : C.red('✗');
    say(`  ${mark} ${probe.id.padEnd(4)} ${probe.title.padEnd(62)} ${String(res.status).padEnd(4)} ${C.grey(rec.reason)}`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Report
// ─────────────────────────────────────────────────────────────────────────────

function summarize(matrix, probes, accuracy) {
  const scored = matrix.filter((r) => r.pass !== null);
  const authFails = scored.filter((r) => !r.pass);
  const piiFails = matrix.filter((r) => r.piiLeak);
  const scopeFails = matrix.filter((r) => r.scopeLeak);
  const probeFails = probes.filter((r) => r.pass === false);
  const accFails = (accuracy ?? []).filter((r) => r.pass === false);
  // Reported separately rather than folded into `skipped`: a rate-limited call
  // was attempted and yielded no verdict, whereas a destructive-allow call was
  // deliberately never sent. Conflating them would hide which one happened.
  const rateLimited = matrix.filter((r) => r.rateLimited);
  const timeouts = matrix.filter((r) => r.timedOut);
  const destructiveSkips = matrix.filter((r) => r.actual === 'skipped');

  return {
    totals: {
      routes: new Set(matrix.map((r) => r.route)).size,
      principals: PRINCIPALS.length,
      calls: matrix.length,
      scored: scored.length,
      skipped: destructiveSkips.length,
      rateLimited: rateLimited.length,
      timeouts: timeouts.length,
    },
    authorizationFailures: authFails.length,
    piiLeaks: piiFails.length,
    scopeLeaks: scopeFails.length,
    probeFailures: probeFails.length,
    accuracyFailures: accFails.length,
    // A timeout is a genuine server-side defect (an endpoint that never answers),
    // so unlike a 429 it DOES block a clean run.
    clean:
      authFails.length === 0 && piiFails.length === 0 && scopeFails.length === 0 &&
      probeFails.length === 0 && accFails.length === 0 && timeouts.length === 0,
  };
}

function renderMarkdown(matrix, probes, accuracy, summary, meta) {
  const L = [];
  L.push(`# Role × Endpoint Audit — ${meta.tag ?? 'run'} ${meta.ts}`);
  L.push('');
  L.push(`- target: \`${meta.base}\``);
  L.push(`- routes: **${summary.totals.routes}**  principals: **${summary.totals.principals}**  calls: **${summary.totals.calls}** (${summary.totals.scored} scored, ${summary.totals.skipped} skipped as destructive-allow, ${summary.totals.rateLimited} rate-limited/no verdict, ${summary.totals.timeouts} timed out)`);
  L.push(`- authorization failures: **${summary.authorizationFailures}**`);
  L.push(`- PII leaks: **${summary.piiLeaks}**`);
  L.push(`- scope leaks: **${summary.scopeLeaks}**`);
  L.push(`- probe failures: **${summary.probeFailures}**`);
  L.push(`- accuracy failures: **${summary.accuracyFailures}**`);
  L.push('');

  // Permission matrix
  L.push('## Permission matrix (source of truth for every expectation)');
  L.push('');
  L.push('| role | permissions |');
  L.push('| --- | --- |');
  for (const role of MATRIX.roles) L.push(`| \`${role}\` | ${(MATRIX.rolePermissions[role] ?? []).map((x) => `\`${x}\``).join(' ')} |`);
  L.push('');

  // Authorization matrix as a compact grid
  const roles = PRINCIPALS.map((p) => p.key);
  L.push('## Authorization matrix');
  L.push('');
  L.push('Legend: ✓ allowed · ✗ denied as expected · **!** mismatch · · skipped');
  L.push('');
  L.push(`| route | ${roles.map((r) => `\`${r}\``).join(' | ')} |`);
  L.push(`| --- | ${roles.map(() => '---').join(' | ')} |`);
  const byRoute = new Map();
  for (const r of matrix) {
    if (!byRoute.has(r.route)) byRoute.set(r.route, {});
    byRoute.get(r.route)[r.principal] = r;
  }
  for (const [route, cells] of [...byRoute].sort()) {
    const marks = roles.map((k) => {
      const c = cells[k];
      if (!c) return '';
      if (c.pass === null) return '·';
      if (c.piiLeak || c.scopeLeak) return `**${c.status}☠**`;
      return c.pass ? (c.expected === 'allow' ? '✓' : '✗') : `**${c.status}!**`;
    });
    L.push(`| \`${route}\` | ${marks.join(' | ')} |`);
  }
  L.push('');

  const fails = matrix.filter((r) => r.pass === false);
  if (fails.length) {
    L.push('## Authorization mismatches');
    L.push('');
    L.push('| route | principal | role | permission | expected | actual | status |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const f of fails) L.push(`| \`${f.route}\` | ${f.principal} | \`${f.role}\` | \`${f.permission ?? '-'}\` | ${f.expected} | ${f.actual} | ${f.status} |`);
    L.push('');
  }

  const pii = matrix.filter((r) => r.piiLeak);
  if (pii.length) {
    L.push('## POPIA — sealed PII disclosed');
    L.push('');
    for (const f of pii) {
      L.push(`- \`${f.route}\` as **${f.principal}** (\`${f.role}\`, no \`${PII_DECRYPT}\`)`);
      for (const h of f.piiHits.slice(0, 5)) L.push(`  - ${h.kind} at \`${h.at}\`: \`${h.value}\``);
    }
    L.push('');
  }

  const scope = matrix.filter((r) => r.scopeLeak);
  if (scope.length) {
    L.push('## Scope — out-of-scope rows disclosed');
    L.push('');
    for (const f of scope) {
      L.push(`- \`${f.route}\` as **${f.principal}** (scope \`${f.scope}\`)`);
      for (const h of f.scopeHits.slice(0, 5)) L.push(`  - token \`${h.token}\` at \`${h.at}\``);
    }
    L.push('');
  }

  L.push('## Targeted probes');
  L.push('');
  L.push('| id | probe | principal | expected | actual | result |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const p of probes) {
    const mark = p.pass === null ? '·' : p.pass ? '✓' : '✗';
    L.push(`| ${p.id} | ${p.title} | \`${p.principal}\` | ${p.expectStatus.join('\\|')} | ${p.status ?? '-'} | ${mark} ${p.reason ?? ''} |`);
  }
  L.push('');

  if (accuracy?.length) {
    L.push('## Data accuracy — API vs direct SQL');
    L.push('');
    L.push('| figure | principal | api | sql | result |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const a of accuracy) {
      const mark = a.pass === null ? '·' : a.pass ? '✓' : '✗';
      L.push(`| ${a.figure} | \`${a.principal}\` | ${JSON.stringify(a.api)} | ${JSON.stringify(a.sql)} | ${mark} ${a.note ?? ''} |`);
    }
    L.push('');
  }

  return `${L.join('\n')}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  say(C.bold('UDF role × endpoint audit'));
  say(C.grey(`  target      ${BASE}`));
  say(C.grey(`  mode        ${RECORD_ONLY ? 'RECORD (no assertions)' : 'ASSERT'}`));
  say(C.grey(`  artifacts   ${ARTIFACTS}`));

  const health = await call('GET', '/healthz');
  if (health.status !== 200) {
    say(C.red(`\n  target is not healthy (HTTP ${health.status}). Start the API or set TARGET_BASE.`));
    process.exit(2);
  }

  say(C.grey('\n  logging in…'));
  await loginAll();

  say(C.grey('\n  calibrating against published content…'));
  await buildPublicBaseline();

  const matrix = await runMatrix();
  const probes = await runProbes();

  let accuracy = [];
  if (!SKIP_ACCURACY) {
    accuracy = await runAccuracyChecks({ BASE, IDS, PRINCIPALS, call, RECORD_ONLY, say, C });
  }

  const summary = summarize(matrix, probes, accuracy);
  const meta = { ts, tag: TAG, base: BASE, recordOnly: RECORD_ONLY, only: ONLY };

  mkdirSync(ARTIFACTS, { recursive: true });
  const jsonFile = path.join(ARTIFACTS, `role-audit${suffix}-${ts}.json`);
  const mdFile = path.join(ARTIFACTS, `role-audit${suffix}-${ts}.md`);
  writeFileSync(jsonFile, `${JSON.stringify({ meta, summary, matrix, probes, accuracy }, null, 2)}\n`, 'utf8');
  writeFileSync(mdFile, renderMarkdown(matrix, probes, accuracy, summary, meta), 'utf8');

  say(C.bold('\n④ Result'));
  say(`  calls scored        ${summary.totals.scored}/${summary.totals.calls}`);
  say(`  authorization fails ${summary.authorizationFailures}`);
  say(`  PII leaks           ${summary.piiLeaks}`);
  say(`  scope leaks         ${summary.scopeLeaks}`);
  say(`  probe failures      ${summary.probeFailures}`);
  say(`  accuracy failures   ${summary.accuracyFailures}`);
  if (summary.totals.timeouts > 0) {
    say(C.red(`  request timeouts    ${summary.totals.timeouts}  (endpoint never answered — treated as a failure)`));
  }
  if (summary.totals.rateLimited > 0) {
    // Not a product defect, but it IS lost coverage, so it is surfaced rather
    // than absorbed into the skip count.
    say(C.yellow(`  rate-limited        ${summary.totals.rateLimited}  (no verdict — re-run after the limiter window)`));
  }
  say(C.grey(`\n  json  ${jsonFile}`));
  say(C.grey(`  report ${mdFile}\n`));

  if (RECORD_ONLY) {
    say(C.yellow('  RECORD mode — no assertions were made.'));
    process.exit(0);
  }
  if (!summary.clean) {
    say(C.red('  ✗ AUDIT FAILED'));
    process.exit(1);
  }
  say(C.green('  ✓ AUDIT CLEAN'));
  process.exit(0);
}

main().catch((err) => {
  say(C.red(`\nfatal: ${err?.stack ?? err}`));
  process.exit(2);
});
