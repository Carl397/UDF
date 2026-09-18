#!/usr/bin/env node
/**
 * role-audit-accuracy.mjs — the "is the data that pulls through ACTUAL data?"
 * check.
 *
 * Every dashboard and analytics figure the API returns is independently
 * recomputed here with direct SQL against the same database, and the two are
 * compared. This catches the class of bug where a screen renders a plausible
 * number that does not correspond to any query — hardcoded counts, a missing
 * `deleted_at IS NULL`, or an aggregation that silently ignores the caller's
 * scope.
 *
 * Requires DATABASE_URL (loaded from backend/.env by dotenv). When the harness
 * is pointed at a remote TARGET_BASE whose database is not reachable, pass
 * --no-accuracy.
 */
import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;
const one = async (text, params = []) => (await sql(text, params))[0] ?? {};

/** Wards whose parent subcouncil is in `codes`. */
const WARDS_IN = `(SELECT code FROM regions WHERE level = 'ward' AND parent_code = ANY($1::text[]))`;

async function expectedDashboard(scope) {
  const params = [];
  let memberScope = '';
  let caseScope = '';
  let petitionScope = '';
  let partScope = '';

  if (scope.ward) {
    params.push(scope.ward);
    const i = params.length;
    memberScope = ` AND ward = $${i}`;
    caseScope = ` AND ward_code = $${i}`;
    petitionScope = ` AND ward_code = $${i}`;
    partScope = ` AND ward_code = $${i}`;
  } else if (scope.regions?.length) {
    params.push(scope.regions);
    const i = params.length;
    memberScope = ` AND region_code = ANY($${i}::text[])`;
    caseScope = ` AND ward_code IN ${WARDS_IN.replace('$1', `$${i}`)}`;
    petitionScope = caseScope;
    partScope = caseScope;
  }

  const r = await one(
    `SELECT
       (SELECT count(*) FROM members WHERE status = 'active' AND deleted_at IS NULL${memberScope})::int AS "activeMembers",
       (SELECT count(*) FROM members WHERE status = 'active'${memberScope})::int AS "activeMembersIgnoringSoftDelete",
       (SELECT count(*) FROM service_requests WHERE status NOT IN ('closed','verified')${caseScope})::int AS "openCases",
       (SELECT count(*) FROM petitions WHERE status = 'open'${petitionScope})::int AS "openPetitions",
       (SELECT count(*) FROM public_participations WHERE status = 'open'${partScope})::int AS "openParticipations"`,
    params,
  );
  return r;
}

async function expectedEscalations(scope) {
  const params = [];
  let where = '';
  if (scope.ward) {
    params.push(scope.ward);
    where = ` AND ward_code = $${params.length}`;
  } else if (scope.regions?.length) {
    params.push(scope.regions);
    where = ` AND ward_code IN ${WARDS_IN.replace('$1', `$${params.length}`)}`;
  }
  const r = await one(
    `SELECT count(*)::int AS total FROM service_requests
      WHERE status IN ('submitted','in_progress','logged')
        AND (sla_due_at < now() OR created_at < now() - interval '30 days')${where}`,
    params,
  );
  return r.total ?? 0;
}

async function expectedOverview(wardCode) {
  const r = await one(
    `SELECT
       (SELECT count(*) FROM patrols WHERE ward_code = $1 AND visibility <> 'private'
          AND COALESCE(started_at, planned_date::timestamptz) >= now() - interval '30 days')::int AS "patrols30d",
       (SELECT count(*) FROM patrols WHERE ward_code = $1 AND visibility <> 'private'
          AND COALESCE(started_at, planned_date::timestamptz) >= now() - interval '90 days')::int AS "patrols90d",
       (SELECT count(*) FROM service_requests WHERE ward_code = $1 AND visibility <> 'private' AND merged_into IS NULL
          AND status IN ('reported','triaged','logged','submitted','in_progress','escalated','reopened'))::int AS "casesActive",
       (SELECT count(*) FROM service_requests WHERE ward_code = $1 AND visibility <> 'private' AND merged_into IS NULL
          AND status IN ('resolved','verified','closed'))::int AS "casesResolved",
       (SELECT count(*) FROM service_requests WHERE ward_code = $1 AND visibility = 'private')::int AS "privateLogs",
       (SELECT count(*) FROM projects WHERE ward_code = $1 AND is_published AND stage <> 'delivered')::int AS "projectsActive",
       (SELECT count(*) FROM projects WHERE ward_code = $1 AND is_published AND stage = 'delivered')::int AS "projectsDelivered",
       (SELECT count(*) FROM ward_bulletins WHERE ward_code = $1 AND status = 'published')::int AS "bulletins"`,
    [wardCode],
  );
  return r;
}

async function expectedRatings(councillorMemberId) {
  if (!councillorMemberId) return { ratingCount: 0, ratingMean: null };
  const r = await one(
    `SELECT count(*)::int AS "ratingCount",
            CASE WHEN count(*) = 0 THEN NULL ELSE round(AVG(rating)::numeric, 2)::float END AS "ratingMean"
       FROM ratings WHERE target_type = 'councillor' AND target_id = $1`,
    [councillorMemberId],
  );
  return r;
}

const num = (v) => (v === null || v === undefined ? null : Number(v));
const same = (a, b) => num(a) === num(b);

/**
 * @returns {Promise<Array>} accuracy check records
 */
export async function runAccuracyChecks({ IDS, PRINCIPALS, call, RECORD_ONLY, say, C }) {
  const out = [];
  const push = (figure, principal, api, expected, note = '') => {
    const pass = RECORD_ONLY ? null : same(api, expected);
    out.push({ figure, principal, api: api ?? null, sql: expected ?? null, pass, note });
  };

  say(C.bold('\n③ Data accuracy — API vs direct SQL\n'));

  let reachable = true;
  try {
    await one('SELECT 1 AS ok');
  } catch (err) {
    reachable = false;
    say(C.yellow(`  database not reachable (${err.message}) — accuracy checks skipped.`));
    say(C.yellow('  pass --no-accuracy when auditing a remote target.'));
  }

  if (reachable) {
    const admin = PRINCIPALS.find((p) => p.key === 'admin');
    const councillor = PRINCIPALS.find((p) => p.key === 'councillor');
    const regional = PRINCIPALS.find((p) => p.key === 'regional');
    const analyst = PRINCIPALS.find((p) => p.key === 'analyst');

    // ── CRM dashboard, national scope ─────────────────────────────────────
    if (admin?.token) {
      const res = await call('GET', '/api/crm/dashboard', { token: admin.token });
      const exp = await expectedDashboard({});
      for (const k of ['activeMembers', 'openCases', 'openPetitions', 'openParticipations']) {
        push(`crm/dashboard.${k} (national)`, 'admin', res.json?.[k], exp[k]);
      }
      if (exp.activeMembers !== exp.activeMembersIgnoringSoftDelete) {
        push(
          'crm/dashboard.activeMembers honours deleted_at',
          'admin',
          res.json?.activeMembers,
          exp.activeMembers,
          `API counts soft-deleted members: with=${exp.activeMembersIgnoringSoftDelete} without=${exp.activeMembers}`,
        );
      }
    }

    // ── CRM dashboard, ward scope (proves D5 scoping is real, not a filter) ─
    if (councillor?.token) {
      const res = await call('GET', '/api/crm/dashboard', { token: councillor.token });
      const exp = await expectedDashboard({ ward: IDS.wards.primary });
      for (const k of ['activeMembers', 'openCases', 'openPetitions', 'openParticipations']) {
        push(`crm/dashboard.${k} (ward ${IDS.wards.primary})`, 'councillor', res.json?.[k], exp[k]);
      }
    }

    // ── CRM dashboard, regional scope ─────────────────────────────────────
    if (regional?.token) {
      const res = await call('GET', '/api/crm/dashboard', { token: regional.token });
      const exp = await expectedDashboard({ regions: regional.regionCodes });
      for (const k of ['activeMembers', 'openCases', 'openPetitions', 'openParticipations']) {
        push(`crm/dashboard.${k} (region ${regional.regionCodes.join('+')})`, 'regional', res.json?.[k], exp[k]);
      }
    }

    // ── Escalations ───────────────────────────────────────────────────────
    if (admin?.token) {
      const res = await call('GET', '/api/crm/escalations', { token: admin.token });
      push('crm/escalations.total (national)', 'admin', res.json?.total, await expectedEscalations({}));
    }
    if (councillor?.token) {
      const res = await call('GET', '/api/crm/escalations', { token: councillor.token });
      push(`crm/escalations.total (ward ${IDS.wards.primary})`, 'councillor', res.json?.total, await expectedEscalations({ ward: IDS.wards.primary }));
    }

    // ── Member directory totals ───────────────────────────────────────────
    if (admin?.token) {
      const res = await call('GET', '/api/crm/members?limit=1', { token: admin.token });
      const r = await one(`SELECT count(*)::int AS n FROM members WHERE deleted_at IS NULL`);
      push('crm/members.total (national)', 'admin', res.json?.total, r.n);
    }
    if (councillor?.token) {
      const res = await call('GET', '/api/crm/members?limit=1', { token: councillor.token });
      const r = await one(`SELECT count(*)::int AS n FROM members WHERE deleted_at IS NULL AND ward = $1`, [IDS.wards.primary]);
      push(`crm/members.total (ward ${IDS.wards.primary})`, 'councillor', res.json?.total, r.n);
    }

    // ── Engagement (case) list totals ─────────────────────────────────────
    if (admin?.token) {
      const res = await call('GET', '/api/crm/engagements?limit=1', { token: admin.token });
      const r = await one(`SELECT count(*)::int AS n FROM service_requests`);
      push('crm/engagements.total (national)', 'admin', res.json?.total, r.n);
    }
    if (councillor?.token) {
      const res = await call('GET', '/api/crm/engagements?limit=1', { token: councillor.token });
      const r = await one(`SELECT count(*)::int AS n FROM service_requests WHERE ward_code = $1`, [IDS.wards.primary]);
      push(`crm/engagements.total (ward ${IDS.wards.primary})`, 'councillor', res.json?.total, r.n);
    }

    // ── Public ward transparency overview (unauthenticated surface) ───────
    {
      const res = await call('GET', `/api/transparency/wards/${IDS.wards.primary}/overview`);
      const exp = await expectedOverview(IDS.wards.primary);
      for (const k of ['patrols30d', 'patrols90d', 'casesActive', 'casesResolved', 'privateLogs', 'projectsActive', 'projectsDelivered', 'bulletins']) {
        push(`transparency/overview.${k} (${IDS.wards.primary})`, 'anonymous', res.json?.[k], exp[k]);
      }
      const councillorMemberId = IDS.councillors?.[0]?.member_id ?? null;
      const rat = await expectedRatings(councillorMemberId);
      push('transparency/overview.ratingCount', 'anonymous', res.json?.ratingCount, rat.ratingCount);
      push('transparency/overview.ratingMean', 'anonymous', res.json?.ratingMean, rat.ratingMean);
    }

    // ── Geo heatmap: the aggregate must reconcile with the member table ─────
    // /api/geo/heatmap does NOT return one feature per member. `getHeatmap`
    // snaps every coordinate onto a lat/lng grid (`ST_SnapToGrid`, `precision`
    // degrees) and `GROUP BY cell`, so each feature is a CELL carrying
    // `properties.count` and `properties.weight`. Comparing `features.length`
    // against the member count therefore measured grid resolution, not data
    // accuracy: with the whole fixture inside Mitchell's Plain a 0.05° grid
    // legitimately collapses the members into a handful of cells. That is the
    // `api=null sql=18` mismatch this check used to report (H7) — and the `null`
    // half was a second, separate bug, because the extraction probed
    // `.items`/`.points`, neither of which a GeoJSON FeatureCollection has, so
    // it silently fell through to `.total` (absent) and scored `null` against a
    // number the endpoint was never asked to produce.
    //
    // The reconcilable figures are the SUMS over the cells, which must equal the
    // member table's own totals, plus the cell count recomputed here with the
    // same grid expression rather than assumed. Two further corrections:
    //   • the SQL omitted `location IS NOT NULL`, which the endpoint requires —
    //     a member with no coordinates cannot appear in any cell, so counting
    //     them made a correct aggregate look short;
    //   • `limit` is a `/points`-only parameter (see geoQuerySchema) and is
    //     ignored here, so it is dropped and `precision` is pinned instead,
    //     which makes the cell count reproducible between runs.
    if (analyst?.token) {
      const PRECISION = 0.05;
      const GEOLOCATED = 'deleted_at IS NULL AND location IS NOT NULL';
      const res = await call('GET', `/api/geo/heatmap?precision=${PRECISION}`, { token: analyst.token });
      const features = res.json?.features;
      if (!Array.isArray(features)) {
        push('geo/heatmap feature collection', 'analyst', res.json?.type ?? null, 'FeatureCollection', 'expected a GeoJSON FeatureCollection');
      } else {
        const props = features.map((f) => f?.properties ?? {});
        const apiMembers = props.reduce((sum, p) => sum + (Number(p.count) || 0), 0);
        const apiWeight = props.reduce((sum, p) => sum + (Number(p.weight) || 0), 0);
        const r = await one(
          `SELECT count(*)::int AS n, COALESCE(sum(heat_weight),0)::int AS heat
             FROM members WHERE ${GEOLOCATED}`,
        );
        push('geo/heatmap members in cells', 'analyst', apiMembers, r.n, 'aggregate only — no per-member identity expected');
        push('geo/heatmap heat-weight sum', 'analyst', apiWeight, r.heat, 'sum(heat_weight) over the same geolocated set');
        // Recomputed with the endpoint's own grid expression, so a change in
        // bucketing fails here rather than passing by coincidence.
        const g = await one(
          `SELECT count(DISTINCT ST_SnapToGrid(location::geometry, $1))::int AS n
             FROM members WHERE ${GEOLOCATED}`,
          [PRECISION],
        );
        push(`geo/heatmap cells @${PRECISION}°`, 'analyst', features.length, g.n, 'grid resolution, independently recomputed');
        push('geo/heatmap empty cells', 'analyst', props.filter((p) => !(Number(p.count) > 0)).length, 0, 'GROUP BY cell cannot emit a zero-count cell');
      }
    }

    await pool.end().catch(() => undefined);
  }

  const fails = out.filter((r) => r.pass === false).length;
  const mark = (r) => (r.pass === null ? C.grey('·') : r.pass ? C.green('✓') : C.red('✗'));
  for (const r of out) {
    say(`  ${mark(r)} ${r.figure.padEnd(52)} api=${String(r.api).padEnd(6)} sql=${String(r.sql).padEnd(6)} ${r.note ? C.yellow(r.note) : ''}`);
  }
  say(C.grey(`  ${out.length} figures compared, ${fails} mismatched`));
  return out;
}
