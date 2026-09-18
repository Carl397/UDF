import { query } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import { getOverview, type CouncillorRef, type WardOverview } from '../transparency/service.js';
import type { MemberScope } from '../members/types.js';
import type { Principal } from '../../auth/permissions.js';
import { regionSummarySchema, type GeoQuery, type RegionSummaryQuery } from './schemas.js';

/**
 * Geo module: powers the Map, Heat Map, and choropleth views.
 *
 * These queries return only NON-PII, aggregate/positional data. Member
 * coordinates are considered sensitive at scale, so region scope is always
 * applied and results never include sealed PII.
 */

interface FeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: string; coordinates: unknown };
    properties: Record<string, unknown>;
  }>;
}

interface WhereOpts {
  /** Prefix for every `members` column, e.g. `m.` when the query joins regions. */
  alias?: string;
  /**
   * Point and heat layers need a GPS fix; aggregates must NOT drop members who
   * have none, so they pass `requireLocation: false`.
   */
  requireLocation?: boolean;
}

/**
 * The member-side conditions as a list — no leading `WHERE` — so the exact same
 * predicate can go into a `WHERE` or into a `JOIN … ON` (the region-summary
 * child counts need the latter to keep zero-member wards in the result).
 *
 * Columns are prefixed HERE rather than by rewriting the finished SQL with
 * regexes: a `.replace(/tier/g, 'm.tier')` pass silently corrupts the
 * `member_tier[]` cast below, and `status` matches inside unrelated words.
 */
function memberConditions(
  q: GeoQuery,
  scope: MemberScope,
  params: unknown[],
  opts: WhereOpts = {},
): string[] {
  const a = opts.alias ?? '';
  const conds: string[] = [`${a}deleted_at IS NULL`];
  if (opts.requireLocation !== false) conds.push(`${a}location IS NOT NULL`);

  if (q.regionCode) {
    params.push(q.regionCode);
    conds.push(`${a}region_code = $${params.length}`);
  }
  if (q.districtCode) {
    params.push(q.districtCode);
    conds.push(`${a}district_code = $${params.length}`);
  }
  if (q.tiers && q.tiers.length) {
    // Multi-select legend filter: one tier, several, or (when the caller omits
    // the param entirely) no restriction at all. `members.tier` is the
    // `member_tier` enum, so the array is cast to that type — comparing an enum
    // column against `text[]` fails ("operator does not exist: member_tier =
    // text") and casting the column instead would drop `members_tier_idx`.
    params.push(q.tiers);
    conds.push(`${a}tier = ANY($${params.length}::member_tier[])`);
  } else if (q.tier) {
    params.push(q.tier);
    conds.push(`${a}tier = $${params.length}`);
  }
  if (q.status) {
    params.push(q.status);
    conds.push(`${a}status = $${params.length}`);
  }

  // Scope is AND-ed with any caller-supplied regionCode filter, so asking for a
  // region outside your territory returns an empty set rather than the data.
  if (scope !== null) {
    const scoped: string[] = [];
    if (scope.ward) {
      params.push(scope.ward);
      scoped.push(`${a}ward = $${params.length}`);
    }
    if (scope.regions && scope.regions.length) {
      params.push(scope.regions);
      scoped.push(`${a}region_code = ANY($${params.length}::text[])`);
    }
    conds.push(scoped.length ? `(${scoped.join(' AND ')})` : 'FALSE');
  }
  return conds;
}

function buildWhere(
  q: GeoQuery,
  scope: MemberScope,
  params: unknown[],
  opts: WhereOpts = {},
): string {
  return `WHERE ${memberConditions(q, scope, params, opts).join(' AND ')}`;
}

/** Raw member points for the interactive map / client-side heatmap. */
export async function getPoints(
  q: GeoQuery,
  scope: MemberScope,
): Promise<FeatureCollection> {
  const params: unknown[] = [];
  const where = buildWhere(q, scope, params);
  params.push(q.limit);

  const res = await query<{ lng: number; lat: number; weight: string; tier: string; status: string; region_code: string }>(
    `SELECT ST_X(location::geometry) AS lng,
            ST_Y(location::geometry) AS lat,
            heat_weight AS weight, tier, status, region_code
       FROM members
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
    params,
  );

  return {
    type: 'FeatureCollection',
    features: res.rows.map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(r.lng), Number(r.lat)] },
      properties: {
        weight: Number(r.weight),
        tier: r.tier,
        status: r.status,
        regionCode: r.region_code,
      },
    })),
  };
}

/**
 * Server-side heat aggregation. Snaps points to a lat/lng grid and sums
 * weights per cell — far lighter than shipping every point for dense data.
 */
export async function getHeatmap(
  q: GeoQuery,
  scope: MemberScope,
): Promise<FeatureCollection> {
  const params: unknown[] = [];
  const where = buildWhere(q, scope, params);
  params.push(q.precision);
  const precisionIdx = params.length;

  const res = await query<{ lng: number; lat: number; count: string; weight: string }>(
    `SELECT ST_X(ST_Centroid(cell)) AS lng,
            ST_Y(ST_Centroid(cell)) AS lat,
            count(*)::text AS count,
            sum(heat_weight)::text AS weight
       FROM (
         SELECT ST_SnapToGrid(location::geometry, $${precisionIdx}) AS cell,
                heat_weight
           FROM members
           ${where}
       ) grid
       GROUP BY cell`,
    params,
  );

  return {
    type: 'FeatureCollection',
    features: res.rows.map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(r.lng), Number(r.lat)] },
      properties: { count: Number(r.count), weight: Number(r.weight) },
    })),
  };
}

/** Per-region totals for a choropleth (shaded regions) layer. */
export async function getChoropleth(
  q: GeoQuery,
  scope: MemberScope,
): Promise<FeatureCollection> {
  const level = q.level ?? 'subcouncil';
  // `members.region_code` holds the SUBCOUNCIL code and `members.ward` the ward
  // code, so drilling down is a change of grouping column, not of table. The
  // default keeps the layer exactly as it has always been shaded.
  const keyCol = level === 'ward' ? 'm.ward' : 'm.region_code';

  const params: unknown[] = [];
  // Choropleth ignores region/district point filters but respects scope + tier/status.
  const scopeOnly: GeoQuery = { ...q, regionCode: undefined, districtCode: undefined };
  const where = buildWhere(scopeOnly, scope, params, {
    alias: 'm.',
    requireLocation: false,
  });

  const res = await query<{
    code: string | null;
    name: string | null;
    members: string;
    weight: string;
    avg_weight: string;
    geom: string | null;
  }>(
    `SELECT ${keyCol} AS code,
            r.name,
            count(*)::text AS members,
            COALESCE(sum(m.heat_weight),0)::text AS weight,
            COALESCE(avg(m.heat_weight),0)::text AS avg_weight,
            ST_AsGeoJSON(r.geom) AS geom
       FROM members m
       LEFT JOIN regions r ON r.code = ${keyCol}
       ${where}
       GROUP BY ${keyCol}, r.name, r.geom`,
    params,
  );

  return {
    type: 'FeatureCollection',
    features: res.rows
      // Skip regions with no geometry rather than plotting them at [0,0]
      // ("Null Island" in the Gulf of Guinea) — that showed up as bogus
      // hotspots in the ocean. A region without a polygon simply isn't drawn.
      // A member with no ward/region code has nothing to shade either.
      .filter((r) => r.geom && r.code)
      .map((r) => ({
        type: 'Feature',
        geometry: JSON.parse(r.geom!),
        properties: {
          regionCode: r.code,
          name: r.name,
          members: Number(r.members),
          weight: Number(r.weight),
          avgWeight: Number(r.avg_weight),
          level,
        },
      })),
  };
}

/**
 * Administrative boundaries for wards and subcouncils.
 * Returns region geometries directly from the regions table — no member
 * data required.  Used to draw boundary outlines on the map.
 */
export async function getBoundaries(
  level: 'ward' | 'subcouncil',
  parentCode?: string,
): Promise<FeatureCollection> {
  const params: unknown[] = [level];
  let sql = `SELECT code, name, parent_code, ST_AsGeoJSON(geom) AS geom
             FROM regions
             WHERE level = $1 AND geom IS NOT NULL`;

  if (parentCode) {
    params.push(parentCode);
    sql += ` AND parent_code = $${params.length}`;
  }

  const res = await query<{
    code: string;
    name: string;
    parent_code: string | null;
    geom: string | null;
  }>(sql, params);

  return {
    type: 'FeatureCollection',
    features: res.rows
      .filter((r) => r.geom)
      .map((r) => ({
        type: 'Feature',
        geometry: JSON.parse(r.geom!),
        properties: {
          code: r.code,
          name: r.name,
          parentCode: r.parent_code,
          level,
        },
      })),
  };
}

// ── Region drill-down ───────────────────────────────────────────────────────

/**
 * A councillor as the PUBLIC directory publishes them: the transparency
 * module's own `CouncillorRef` plus the position title. Sourced only from
 * `leaders WHERE is_public` (never sealed member PII), so this stays inside the
 * geo module's "non-PII only" rule.
 */
export interface RegionCouncillor extends CouncillorRef {
  /** `positions.name` for the leader's position code, e.g. "Ward Councillor". */
  position: string | null;
}

export interface RegionChild {
  code: string;
  name: string;
  level: string;
  members: number;
  councillor: RegionCouncillor | null;
}

export interface RegionSummary {
  code: string;
  name: string;
  level: string;
  parentCode: string | null;
  parentName: string | null;
  counts: {
    total: number;
    byTier: Record<string, number>;
    byStatus: Record<string, number>;
  };
  children: RegionChild[];
  /** Set for a ward: the same PII-free overview the public site shows. */
  ward: WardOverview | null;
  /** Set for a ward. `slaBreached` is the one number a councillor acts on. */
  serviceDelivery: WardServiceDelivery | null;
  /** Set for a ward: published projects, unfinished first. */
  projects: WardProject[];
}

/**
 * Case counters for one ward, on exactly the public footing the transparency
 * overview uses (`visibility <> 'private'`, unmerged): the map sheet and the
 * public ward page must never disagree about the same ward.
 *
 * `open` deliberately excludes `in_progress` so the four numbers partition the
 * caseload instead of overlapping — a sheet that showed "12 open" and "5 in
 * progress" where the 5 were also in the 12 would read as a contradiction.
 */
export interface WardServiceDelivery {
  open: number;
  inProgress: number;
  resolved: number;
  /** Still-open cases past `sla_due_at`. Uses the `sr_sla_idx` partial index. */
  slaBreached: number;
}

export interface WardProject {
  id: string;
  title: string;
  stage: string;
  progressPct: number | null;
}

async function wardDelivery(wardCode: string): Promise<{
  serviceDelivery: WardServiceDelivery;
  projects: WardProject[];
}> {
  const [cases, projects] = await Promise.all([
    query<{ open: string; in_progress: string; resolved: string; sla_breached: string }>(
      `SELECT count(*) FILTER (WHERE status IN
                ('reported','triaged','logged','submitted','escalated','reopened'))::text AS open,
              count(*) FILTER (WHERE status = 'in_progress')::text AS in_progress,
              count(*) FILTER (WHERE status IN ('resolved','verified','closed'))::text AS resolved,
              count(*) FILTER (WHERE status NOT IN ('resolved','verified','closed','duplicate')
                               AND sla_due_at IS NOT NULL AND sla_due_at < now())::text AS sla_breached
         FROM service_requests
        WHERE ward_code = $1 AND visibility <> 'private' AND merged_into IS NULL`,
      [wardCode],
    ),
    query<{ id: string; title: string; stage: string; progress_pct: number | null }>(
      `SELECT id, title, stage::text AS stage, progress_pct
         FROM projects
        WHERE ward_code = $1 AND is_published
        ORDER BY (stage = 'delivered'), progress_pct DESC NULLS LAST, updated_at DESC
        LIMIT 5`,
      [wardCode],
    ),
  ]);
  const c = cases.rows[0];
  return {
    serviceDelivery: {
      open: Number(c?.open ?? 0),
      inProgress: Number(c?.in_progress ?? 0),
      resolved: Number(c?.resolved ?? 0),
      slaBreached: Number(c?.sla_breached ?? 0),
    },
    projects: projects.rows.map((p) => ({
      id: p.id,
      title: p.title,
      stage: p.stage,
      progressPct: p.progress_pct,
    })),
  };
}

/**
 * Everything the map's drill-down sheet shows about one region: its own member
 * counts, its children (subcouncil → wards, region → subcouncils) each with a
 * member count and its published councillor, and — for a ward — the public
 * service-delivery overview.
 *
 * One recursive descendant set makes this work at every level of the tree
 * without special-casing: a ward matches itself, a subcouncil matches itself and
 * its wards, a region or municipality matches everything below it. Both
 * `members.ward` and `members.region_code` are tested against that set because
 * the seeded geography stores the subcouncil in `region_code`.
 *
 * Caller filters (tier/status) and the principal's territory scope apply exactly
 * as they do to the other geo queries, so a councillor outside their ward gets
 * zeros rather than data.
 */
export async function getRegionSummary(
  q: RegionSummaryQuery,
  scope: MemberScope,
): Promise<RegionSummary> {
  const regionRes = await query<{
    code: string;
    name: string;
    level: string;
    parent_code: string | null;
    parent_name: string | null;
  }>(
    `SELECT r.code, r.name, r.level, r.parent_code, p.name AS parent_name
       FROM regions r
       LEFT JOIN regions p ON p.code = r.parent_code
      WHERE r.code = $1`,
    [q.code],
  );
  const region = regionRes.rows[0];
  if (!region) throw ApiError.notFound('Region not found');

  const treeCte = `WITH RECURSIVE tree AS (
         SELECT code FROM regions WHERE code = $1
         UNION ALL
         SELECT r.code FROM regions r JOIN tree t ON r.parent_code = t.code)`;

  // Own counts, broken down by tier and status in one pass.
  const countParams: unknown[] = [q.code];
  const countConds = memberConditions(q, scope, countParams, {
    alias: 'm.',
    requireLocation: false,
  });
  const countsRes = await query<{ tier: string; status: string; n: string }>(
    `${treeCte}
     SELECT m.tier::text AS tier, m.status::text AS status, count(*)::text AS n
       FROM members m
      WHERE (m.ward IN (SELECT code FROM tree)
             OR m.region_code IN (SELECT code FROM tree))
        AND ${countConds.join(' AND ')}
      GROUP BY m.tier, m.status`,
    countParams,
  );

  const byTier: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of countsRes.rows) {
    const n = Number(r.n);
    total += n;
    byTier[r.tier] = (byTier[r.tier] ?? 0) + n;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + n;
  }

  // Children with their own counts. The member conditions go in the JOIN's ON
  // clause (not a WHERE) so a child with zero members is still listed — an empty
  // ward is exactly what an organiser needs to see.
  const childParams: unknown[] = [q.code];
  const childConds = memberConditions(q, scope, childParams, {
    alias: 'm.',
    requireLocation: false,
  });
  const childrenRes = await query<{
    code: string;
    name: string;
    level: string;
    members: string;
  }>(
    `WITH RECURSIVE child_tree AS (
        SELECT code AS root, code FROM regions WHERE parent_code = $1
        UNION ALL
        SELECT ct.root, r.code FROM regions r JOIN child_tree ct ON r.parent_code = ct.code)
     SELECT c.code, c.name, c.level, COALESCE(mc.members, 0)::text AS members
       FROM regions c
       LEFT JOIN (
         SELECT ct.root AS code, count(*) AS members
           FROM child_tree ct
           JOIN members m ON (m.ward = ct.code OR m.region_code = ct.code)
                AND ${childConds.join(' AND ')}
          GROUP BY ct.root
       ) mc ON mc.code = c.code
      WHERE c.parent_code = $1
      ORDER BY c.level, c.name`,
    childParams,
  );

  // Published councillors for the ward children, one per ward. `ward_profiles`
  // wins over a plain `leaders.ward_code` match, mirroring
  // transparency/councillorForWard so the map and the public site agree.
  const wardCodes = childrenRes.rows.filter((c) => c.level === 'ward').map((c) => c.code);
  const councillors = new Map<string, RegionCouncillor>();
  if (wardCodes.length) {
    const leadersRes = await query<{
      ward_code: string | null;
      member_id: string | null;
      full_name: string;
      bio: string | null;
      photo_id: string | null;
      position: string | null;
      contact_public: Record<string, unknown> | null;
    }>(
      `SELECT ward_code, member_id, full_name, bio, photo_id, position, contact_public
         FROM (
           SELECT wp.ward_code AS ward_code, l.member_id, l.full_name, l.bio, l.photo_id,
                  p.name AS position, l.contact_public, 1 AS prio, l.updated_at
             FROM ward_profiles wp
             JOIN leaders l ON l.member_id = wp.councillor_member_id AND l.is_public
             LEFT JOIN positions p ON p.code = l.position_code
            WHERE wp.ward_code = ANY($1::text[]) AND l.ward_code = wp.ward_code
              AND (l.user_id IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id = l.user_id AND u.is_active AND u.role = 'ward_councillor' AND u.ward_code = l.ward_code))
           UNION ALL
           SELECT l.ward_code, l.member_id, l.full_name, l.bio, l.photo_id,
                  p.name AS position, l.contact_public, CASE WHEN l.user_id IS NOT NULL THEN 0 ELSE 2 END AS prio, l.updated_at
             FROM leaders l
             LEFT JOIN positions p ON p.code = l.position_code
            WHERE l.is_public AND l.ward_code = ANY($1::text[])
              AND (l.user_id IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id = l.user_id AND u.is_active AND u.role = 'ward_councillor' AND u.ward_code = l.ward_code))
         ) x
        ORDER BY ward_code, prio, updated_at DESC`,
      [wardCodes],
    );
    for (const r of leadersRes.rows) {
      // Rows arrive ordered by priority, so the first one seen for a ward wins.
      if (!r.ward_code || councillors.has(r.ward_code)) continue;
      councillors.set(r.ward_code, {
        memberId: r.member_id,
        fullName: r.full_name,
        bio: r.bio,
        photoId: r.photo_id,
        position: r.position,
        contactPublic: r.contact_public ?? {},
      });
    }
  }

  const children: RegionChild[] = childrenRes.rows.map((c) => ({
    code: c.code,
    name: c.name,
    level: c.level,
    members: Number(c.members),
    councillor: councillors.get(c.code) ?? null,
  }));

  const isWard = region.level === 'ward';
  const delivery = isWard ? await wardDelivery(region.code) : null;

  return {
    code: region.code,
    name: region.name,
    level: region.level,
    parentCode: region.parent_code,
    parentName: region.parent_name,
    counts: { total, byTier, byStatus },
    children,
    ward: isWard ? await getOverview(region.code) : null,
    serviceDelivery: delivery?.serviceDelivery ?? null,
    projects: delivery?.projects ?? [],
  };
}

// ── Wave 4: the restricted member map ───────────────────────────────────────

/** One administrative shape as the member map needs it: code, name, GeoJSON. */
export interface MyWardBoundary {
  code: string;
  name: string;
  /** Parsed GeoJSON geometry, or null when the region has no polygon. */
  geom: unknown | null;
}

export interface MyWard {
  /** The ward's parent subcouncil, so the map can show the ward in context. */
  subcouncil: MyWardBoundary | null;
  ward: MyWardBoundary;
  /** The same PII-free drill-down the full map uses, scoped to the member. */
  summary: RegionSummary;
}

/**
 * The restricted member map (Wave 4): ONLY the caller's own ward.
 *
 * Hard-scoped to `principal.wardCode` — the request names no ward, so a member
 * can never receive anyone else's geography, and a member asking for another
 * ward's code simply gets their own (the parameter does not exist). Returns the
 * ward's shape, its parent subcouncil's shape, and the PII-free
 * `getRegionSummary` for the ward (councillor bio from `leaders WHERE is_public`,
 * service-delivery progress, published projects) scoped to the member.
 *
 * A principal with no ward on record — e.g. a national admin, who is over-
 * entitled for this surface and would use the full map instead — gets 404 rather
 * than the whole country: this endpoint only ever answers "my ward".
 */
export async function getMyWard(principal: Principal): Promise<MyWard> {
  const wardCode = principal.wardCode;
  if (!wardCode) throw ApiError.notFound('No ward on record');

  const wardRes = await query<{
    code: string;
    name: string;
    parent_code: string | null;
    geom: string | null;
  }>(
    `SELECT code, name, parent_code, ST_AsGeoJSON(geom) AS geom
       FROM regions
      WHERE code = $1 AND level = 'ward'`,
    [wardCode],
  );
  const wardRow = wardRes.rows[0];
  if (!wardRow) throw ApiError.notFound('Ward not found');

  let subcouncil: MyWardBoundary | null = null;
  if (wardRow.parent_code) {
    const scRes = await query<{ code: string; name: string; geom: string | null }>(
      `SELECT code, name, ST_AsGeoJSON(geom) AS geom FROM regions WHERE code = $1`,
      [wardRow.parent_code],
    );
    const sc = scRes.rows[0];
    if (sc) {
      subcouncil = { code: sc.code, name: sc.name, geom: sc.geom ? JSON.parse(sc.geom) : null };
    }
  }

  // Parse through the schema so the caller-filter defaults (no tier/status/
  // region restriction) are applied; the scope below is what pins it to the ward.
  const summaryQuery = regionSummarySchema.parse({ code: wardCode });
  const scope: MemberScope = { ward: wardCode, regions: principal.regionCodes ?? [] };
  const summary = await getRegionSummary(summaryQuery, scope);

  return {
    subcouncil,
    ward: {
      code: wardRow.code,
      name: wardRow.name,
      geom: wardRow.geom ? JSON.parse(wardRow.geom) : null,
    },
    summary,
  };
}

/* ── Case counts per map layer (`GET /api/geo/case-stats`) ─── */

/** The three bars the static map draws, for one area. */
export interface AreaCaseStats {
  code: string;
  open: number;
  resolved: number;
  followUps: number;
}

/** Counts for every area of every layer, in one payload. */
export interface CaseStatsResponse {
  region: AreaCaseStats[];
  subcouncil: AreaCaseStats[];
  ward: AreaCaseStats[];
}

/**
 * Open / resolved / follow-up case counts for every region, subcouncil and ward.
 *
 * The status buckets are copied from the ward overview in
 * `transparency/service.ts` on purpose: a member can see both surfaces, and if
 * the map disagreed with the ward page about how many cases are open, one of
 * them would simply be wrong. Same exclusions too — private logs and cases
 * merged into a duplicate are counted nowhere.
 *
 * `service_requests` only carries `ward_code`, so the parent levels are rolled
 * up through the `regions` hierarchy rather than queried separately; that also
 * guarantees a subcouncil's total is exactly the sum of its wards.
 *
 * Aggregate and PII-free by construction — no reporter, no coordinate, no title,
 * just counts — which is why this is served to a member holding only
 * `geo:read_own_ward`. The same numbers are already published per ward by the
 * transparency module.
 */
export async function getCaseStats(): Promise<CaseStatsResponse> {
  const res = await query<{
    ward_code: string;
    sub_code: string | null;
    region_code: string | null;
    open: string;
    resolved: string;
    follow_ups: string;
  }>(
    `SELECT w.code AS ward_code,
            w.parent_code AS sub_code,
            s.parent_code AS region_code,
            COALESCE(c.open, 0)::text AS open,
            COALESCE(c.resolved, 0)::text AS resolved,
            COALESCE(c.follow_ups, 0)::text AS follow_ups
       FROM regions w
       LEFT JOIN regions s
              ON s.code = w.parent_code AND s.level = 'subcouncil'
       LEFT JOIN (
         SELECT ward_code,
                count(*) FILTER (
                  WHERE status IN ('reported','triaged','logged','submitted',
                                   'in_progress','escalated','reopened')
                ) AS open,
                count(*) FILTER (
                  WHERE status IN ('resolved','verified','closed')
                ) AS resolved,
                count(*) FILTER (
                  WHERE follow_up_state IN ('awaiting','engaged')
                ) AS follow_ups
           FROM service_requests
          WHERE visibility <> 'private'
            AND merged_into IS NULL
          GROUP BY ward_code
       ) AS c ON c.ward_code = w.code
      WHERE w.level = 'ward'
      ORDER BY w.code`,
  );

  const ward: AreaCaseStats[] = [];
  const subTotals = new Map<string, AreaCaseStats>();
  const regionTotals = new Map<string, AreaCaseStats>();

  /** Add a ward's counts into its parent's running total. */
  function accumulate(into: Map<string, AreaCaseStats>, code: string, row: AreaCaseStats): void {
    const total = into.get(code) ?? { code, open: 0, resolved: 0, followUps: 0 };
    total.open += row.open;
    total.resolved += row.resolved;
    total.followUps += row.followUps;
    into.set(code, total);
  }

  for (const row of res.rows) {
    const stats: AreaCaseStats = {
      code: row.ward_code,
      open: Number(row.open),
      resolved: Number(row.resolved),
      followUps: Number(row.follow_ups),
    };
    ward.push(stats);
    if (row.sub_code) accumulate(subTotals, row.sub_code, stats);
    if (row.region_code) accumulate(regionTotals, row.region_code, stats);
  }

  const byCode = (a: AreaCaseStats, b: AreaCaseStats) => a.code.localeCompare(b.code);
  return {
    region: [...regionTotals.values()].sort(byCode),
    subcouncil: [...subTotals.values()].sort(byCode),
    ward,
  };
}
