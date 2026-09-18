import { query } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import { isNationalScope, Role, type Principal } from '../../auth/permissions.js';
import { memberScope, principalSeesMember } from '../../auth/scope.js';
import { ensurePublicCode, joinUrl, publicUrl } from '../memberships/service.js';
import type { LineageQuery, ReportQuery, TreeQuery } from './schemas.js';

/**
 * Recruitment genealogy service (PRD-growth FR-O).
 *
 * PRIVACY INVARIANT. The tree, lineage and report expose member PUBLIC CODES
 * (`UDF-XXX-YYY` — the QR verify token, not secret), tier, status, join date,
 * ward and aggregate counts. They NEVER return sealed PII (names, emails,
 * phones). The only human name that can appear is a PUBLIC ward-councillor name
 * from the `leaders` directory (already served unauthenticated by the
 * transparency module), and it is returned as `displayName` — never `fullName` —
 * so the national report JSON carries no `email`/`fullName` key (AC-O2).
 *
 * SCOPING mirrors `auth/scope.ts`. A member reaches only their OWN downline and
 * may trace only themselves or a member within their own tree; staff reach their
 * ward/region; national reaches everything. Every recursive walk is depth-capped
 * so a deep or corrupt branch cannot run away (the DB trigger keeps edges
 * acyclic; the cap is defence in depth).
 */

/** Hard depth ceiling for every recursive walk (PRD §10). */
const MAX_DEPTH = 16;

// ── Small helpers (same shapes the jobs module uses) ─────────────────────

/** Read a feature flag; unknown keys fall back to `fallback`. */
async function isFlagEnabled(key: string, fallback: boolean): Promise<boolean> {
  const res = await query<{ enabled: boolean }>(
    `SELECT enabled FROM feature_flags WHERE key = $1`,
    [key],
  );
  const row = res.rows[0];
  return row ? row.enabled : fallback;
}

/** Build a typed ApiError so the central handler maps it to the right status. */
function httpError(status: number, message: string): ApiError {
  switch (status) {
    case 400: return ApiError.badRequest(message);
    case 403: return ApiError.forbidden(message);
    case 404: return ApiError.notFound(message);
    case 409: return ApiError.conflict(message);
    default: return new ApiError(status, 'error', message);
  }
}

/** Wards a staff principal may see. `null` ⇒ national (all wards). */
async function scopeWardsFor(p: Principal): Promise<string[] | null> {
  if (p.wardCode) return [p.wardCode];
  if (isNationalScope(p)) return null;
  const codes = p.regionCodes ?? [];
  if (codes.length === 0) return null;
  const res = await query<{ code: string }>(
    `SELECT code FROM regions WHERE level = 'ward' AND (parent_code = ANY($1) OR code = ANY($1))`,
    [codes],
  );
  return res.rows.map((r) => r.code);
}

/** A member's public, scope-relevant fields — no PII. */
interface MemberRef {
  memberId: string;
  publicCode: string | null;
  ward: string | null;
  regionCode: string | null;
}

/**
 * The member row linked to this account. Prefers the explicit `users.member_id`
 * link set at onboarding (FR-P1); falls back to the legacy `created_by` guess for
 * accounts provisioned before Phase B (e.g. a councillor who enrolled their own
 * member row). Returns `null` when the account has no member row (an analyst, or
 * an admin who is not themselves a registered member).
 */
async function memberForPrincipal(p: Principal): Promise<MemberRef | null> {
  const res = await query<{
    id: string; public_code: string | null; ward: string | null; region_code: string | null;
  }>(
    `SELECT m.id, m.public_code, m.ward, m.region_code
       FROM members m
      WHERE m.deleted_at IS NULL
        AND m.id = COALESCE(
          (SELECT u.member_id FROM users u WHERE u.id = $1),
          (SELECT m2.id FROM members m2 WHERE m2.created_by = $1 AND m2.deleted_at IS NULL LIMIT 1)
        )
      LIMIT 1`,
    [p.sub],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    memberId: row.id,
    publicCode: row.public_code,
    ward: row.ward ?? p.wardCode ?? null,
    regionCode: row.region_code,
  };
}

/** Fetch one member's public fields (no PII), or null when absent/deleted. */
async function fetchMember(memberId: string): Promise<MemberRef | null> {
  const res = await query<{
    id: string; public_code: string | null; ward: string | null; region_code: string | null;
  }>(
    `SELECT id, public_code, ward, region_code
       FROM members WHERE id = $1 AND deleted_at IS NULL`,
    [memberId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return { memberId: r.id, publicCode: r.public_code, ward: r.ward, regionCode: r.region_code };
}

/**
 * Public councillor display names for a set of member ids, from the published
 * `leaders` directory only. A member who is not a published leader has no entry,
 * so their node shows a public code and no name — the tree is a shape, not a
 * roster of identities.
 */
async function publicLeaderNames(
  memberIds: string[],
): Promise<Map<string, { name: string; position: string | null }>> {
  const ids = Array.from(new Set(memberIds.filter(Boolean)));
  if (ids.length === 0) return new Map();
  const res = await query<{ member_id: string; full_name: string; position: string | null }>(
    `SELECT DISTINCT ON (l.member_id) l.member_id, l.full_name, pos.name AS position
       FROM leaders l
       LEFT JOIN positions pos ON pos.code = l.position_code
      WHERE l.is_public AND l.member_id = ANY($1::uuid[])
      ORDER BY l.member_id, l.updated_at DESC`,
    [ids],
  );
  return new Map(res.rows.map((r) => [r.member_id, { name: r.full_name, position: r.position }]));
}

// ── FR-O2: invite (own reference number + join link) ─────────────────────

export interface InviteView {
  memberId: string;
  /** The member's own reference number — the recruitment attribution token. */
  publicCode: string;
  /** `/register?ref=<code>` — the link a councillor shows on their phone. */
  joinUrl: string;
  /** The public verify URL the QR encodes (`/v/<code>`). */
  qrPayload: string;
  /** The caller's own upline (who recruited them), as a public code, or null. */
  referredBy: string | null;
  directReferrals: number;
  downline: number;
}

export async function getInvite(p: Principal): Promise<InviteView> {
  const caller = await memberForPrincipal(p);
  // A memberless caller (e.g. a regional organiser, who holds `recruitment:read`
  // for CRM oversight but is not themselves a registered member) is authorised to
  // reach this surface yet has no personal invite resource to return — that is a
  // 404 ("no such resource for you"), not a 403 ("you may not"). Mirrors getTree's
  // graceful staff degradation, so the two member-facing reads behave alike.
  if (!caller) throw httpError(404, 'No member profile is linked to this account');
  const code = caller.publicCode ?? (await ensurePublicCode(caller.memberId));

  const [directRes, downRes, upRes] = await Promise.all([
    query<{ c: string }>(
      `SELECT count(*)::text AS c FROM members
        WHERE referred_by_member_id = $1 AND deleted_at IS NULL`,
      [caller.memberId],
    ),
    query<{ c: string }>(
      `WITH RECURSIVE t AS (
         SELECT id, 1 AS depth FROM members
          WHERE referred_by_member_id = $1 AND deleted_at IS NULL
         UNION ALL
         SELECT c.id, t.depth + 1 FROM members c JOIN t ON c.referred_by_member_id = t.id
          WHERE c.deleted_at IS NULL AND t.depth < 64
       ) SELECT count(*)::text AS c FROM t`,
      [caller.memberId],
    ),
    query<{ public_code: string | null }>(
      `SELECT public_code FROM members
        WHERE id = (SELECT referred_by_member_id FROM members WHERE id = $1)`,
      [caller.memberId],
    ),
  ]);

  return {
    memberId: caller.memberId,
    publicCode: code,
    joinUrl: joinUrl(code),
    qrPayload: publicUrl(`/v/${code}`),
    referredBy: upRes.rows[0]?.public_code ?? null,
    directReferrals: Number(directRes.rows[0]?.c ?? 0),
    downline: Number(downRes.rows[0]?.c ?? 0),
  };
}

// ── FR-O4: recruitment tree ──────────────────────────────────────────────

export interface TreeNode {
  memberId: string;
  /** The referrer within this subtree (null for the root). */
  parentId: string | null;
  publicCode: string | null;
  tier: string;
  status: string;
  ward: string | null;
  joinedAt: string | null;
  depth: number;
  /** Direct recruits within the returned (depth-capped) subtree. */
  directReferrals: number;
  /** Total descendants within the returned subtree. */
  downline: number;
  /** Public councillor name when this node is a published leader, else null. */
  displayName: string | null;
}

export interface TreeView {
  scope: 'own' | 'ward' | 'region' | 'national';
  root: { memberId: string; publicCode: string | null; ward: string | null } | null;
  depthCap: number;
  /** True when the walk stopped at the depth cap, so deeper levels are omitted. */
  truncated: boolean;
  /** Node count excluding the root. */
  totalNodes: number;
  maxDepth: number;
  /** Depth-ordered flat list; the client nests it by `parentId`. */
  nodes: TreeNode[];
}

export async function getTree(p: Principal, q: TreeQuery): Promise<TreeView> {
  if (!(await isFlagEnabled('recruitment.tree', true))) {
    throw httpError(403, 'The recruitment tree is currently disabled');
  }
  const depthCap = Math.min(Math.max(q.depth, 1), MAX_DEPTH);
  const caller = await memberForPrincipal(p);

  let rootId: string;
  let scope: TreeView['scope'];
  if (p.role === Role.MEMBER) {
    // A member reaches only their OWN downline (NG3).
    if (!caller) throw httpError(403, 'No member profile is linked to this account');
    if (q.root && q.root !== caller.memberId) {
      throw httpError(403, 'You can only view your own recruitment tree');
    }
    rootId = caller.memberId;
    scope = 'own';
  } else {
    rootId = q.root ?? caller?.memberId ?? '';
    if (!rootId) throw httpError(400, 'A root member id is required');
    const target = await fetchMember(rootId);
    if (!target) throw httpError(404, 'No member matches that root');
    if (!(await principalSeesMember(p, { regionCode: target.regionCode, ward: target.ward }))) {
      throw httpError(403, 'That member is outside your scope');
    }
    scope = isNationalScope(p) ? 'national' : p.wardCode ? 'ward' : 'region';
  }

  const res = await query<{
    id: string; parent_id: string | null; public_code: string | null; tier: string;
    status: string; ward: string | null; joined_at: string | null; depth: number;
  }>(
    `WITH RECURSIVE tree AS (
       SELECT m.id, m.referred_by_member_id AS parent_id, m.public_code, m.tier, m.status,
              m.ward, m.joined_at::text AS joined_at, 0 AS depth
         FROM members m WHERE m.id = $1 AND m.deleted_at IS NULL
       UNION ALL
       SELECT c.id, c.referred_by_member_id, c.public_code, c.tier, c.status,
              c.ward, c.joined_at::text, t.depth + 1
         FROM members c JOIN tree t ON c.referred_by_member_id = t.id
        WHERE c.deleted_at IS NULL AND t.depth < $2
     )
     SELECT id, parent_id, public_code, tier, status, ward, joined_at, depth
       FROM tree ORDER BY depth, joined_at`,
    [rootId, depthCap],
  );

  const rows = res.rows;
  const rootNode = rows.find((r) => r.depth === 0) ?? null;
  // Per-node counts within the returned subtree: direct = children present,
  // downline = subtree size. Deepest-first so a node's total is known before it
  // is rolled into its parent.
  const direct = new Map<string, number>();
  const downline = new Map<string, number>();
  const present = new Set(rows.map((r) => r.id));
  for (const r of rows) downline.set(r.id, 0);
  for (const r of rows) {
    if (r.parent_id && present.has(r.parent_id)) direct.set(r.parent_id, (direct.get(r.parent_id) ?? 0) + 1);
  }
  for (const r of [...rows].sort((a, b) => b.depth - a.depth)) {
    if (r.parent_id && present.has(r.parent_id)) {
      downline.set(r.parent_id, (downline.get(r.parent_id) ?? 0) + 1 + (downline.get(r.id) ?? 0));
    }
  }

  const names = await publicLeaderNames(rows.map((r) => r.id));
  const nodes: TreeNode[] = rows.map((r) => ({
    memberId: r.id,
    parentId: r.parent_id,
    publicCode: r.public_code,
    tier: r.tier,
    status: r.status,
    ward: r.ward,
    joinedAt: r.joined_at,
    depth: Number(r.depth),
    directReferrals: direct.get(r.id) ?? 0,
    downline: downline.get(r.id) ?? 0,
    displayName: names.get(r.id)?.name ?? null,
  }));

  return {
    scope,
    root: rootNode
      ? { memberId: rootNode.id, publicCode: rootNode.public_code, ward: rootNode.ward }
      : null,
    depthCap,
    truncated: rows.some((r) => Number(r.depth) === depthCap),
    totalNodes: Math.max(rows.length - (rootNode ? 1 : 0), 0),
    maxDepth: rows.reduce((m, r) => Math.max(m, Number(r.depth)), 0),
    nodes,
  };
}

// ── FR-O5: lineage (trace to source) ─────────────────────────────────────

export interface LineageNode {
  memberId: string;
  publicCode: string | null;
  tier: string;
  status: string;
  ward: string | null;
  joinedAt: string | null;
  /** Hops up from the queried member (0 = the member, max = the root source). */
  hop: number;
  displayName: string | null;
}

export interface LineageView {
  scope: 'own' | 'ward' | 'region' | 'national';
  member: { memberId: string; publicCode: string | null };
  /** The top-most referrer of this branch (the "first source"). */
  root: LineageNode | null;
  /** Hops from the member to the root (0 = the member is themselves a root). */
  depth: number;
  /** member (hop 0) → … → root source. */
  chain: LineageNode[];
}

export async function getLineage(p: Principal, q: LineageQuery): Promise<LineageView> {
  if (!(await isFlagEnabled('recruitment.tree', true))) {
    throw httpError(403, 'The recruitment tree is currently disabled');
  }
  const target = await fetchMember(q.member);
  if (!target) throw httpError(404, 'No member matches that id');

  const caller = await memberForPrincipal(p);
  let scope: LineageView['scope'];
  if (p.role === Role.MEMBER) {
    if (!caller) throw httpError(403, 'No member profile is linked to this account');
    scope = 'own';
  } else {
    if (!(await principalSeesMember(p, { regionCode: target.regionCode, ward: target.ward }))) {
      throw httpError(403, 'That member is outside your scope');
    }
    scope = isNationalScope(p) ? 'national' : p.wardCode ? 'ward' : 'region';
  }

  const res = await query<{
    id: string; public_code: string | null; tier: string; status: string;
    ward: string | null; joined_at: string | null; hop: number;
  }>(
    `WITH RECURSIVE up AS (
       SELECT m.id, m.public_code, m.tier, m.status, m.ward, m.joined_at::text AS joined_at,
              m.referred_by_member_id AS parent_id, 0 AS hop
         FROM members m WHERE m.id = $1 AND m.deleted_at IS NULL
       UNION ALL
       SELECT pa.id, pa.public_code, pa.tier, pa.status, pa.ward, pa.joined_at::text,
              pa.referred_by_member_id, u.hop + 1
         FROM members pa JOIN up u ON pa.id = u.parent_id
        WHERE pa.deleted_at IS NULL AND u.hop < $2
     )
     SELECT id, public_code, tier, status, ward, joined_at, hop FROM up ORDER BY hop`,
    [q.member, MAX_DEPTH],
  );

  // A member may trace only themselves or a member within their OWN tree: the
  // caller's id must appear somewhere in the target's ancestor chain (hop 0 =
  // the target itself, so tracing yourself also reveals your own upline).
  if (p.role === Role.MEMBER) {
    const ids = res.rows.map((r) => r.id);
    if (!caller || !ids.includes(caller.memberId)) {
      throw httpError(403, 'You can only trace members within your own recruitment tree');
    }
  }

  const names = await publicLeaderNames(res.rows.map((r) => r.id));
  const chain: LineageNode[] = res.rows.map((r) => ({
    memberId: r.id,
    publicCode: r.public_code,
    tier: r.tier,
    status: r.status,
    ward: r.ward,
    joinedAt: r.joined_at,
    hop: Number(r.hop),
    displayName: names.get(r.id)?.name ?? null,
  }));

  return {
    scope,
    member: { memberId: target.memberId, publicCode: target.publicCode },
    root: chain.length ? chain[chain.length - 1]! : null,
    depth: Math.max(chain.length - 1, 0),
    chain,
  };
}

// ── FR-O6: national / regional recruitment report ────────────────────────

export interface ReportRow {
  originatorId: string;
  publicCode: string | null;
  ward: string | null;
  regionCode: string | null;
  isCouncillor: boolean;
  /** Public councillor name (from `leaders`) when published, else null. */
  displayName: string | null;
  position: string | null;
  direct: number;
  downline: number;
  treeDepth: number;
  activeRecruits: number;
  pendingRecruits: number;
  growth30d: number;
  growth90d: number;
}

export interface ReportView {
  scope: 'ward' | 'region' | 'national';
  wardFilter: string | null;
  /** Totals over the returned (limited) rows. */
  totals: { originators: number; councillors: number; direct: number; downline: number };
  rows: ReportRow[];
}

/**
 * Rank originators — ward councillors first — by the recruitment trees they
 * originate. `downline` is the TRUE total-descendant count for every originator
 * (not just ultimate roots): the `climb` CTE records each member against ALL of
 * their ancestors, so a mid-branch recruiter is credited with their whole
 * sub-tree. Identity stays PII-free: public codes, wards and the PUBLIC leader
 * name only, never sealed names/emails (AC-O2).
 */
export async function getReport(p: Principal, q: ReportQuery): Promise<ReportView> {
  if (!(await isFlagEnabled('recruitment.report', true))) {
    throw httpError(403, 'The recruitment report is currently disabled');
  }
  const scope: ReportView['scope'] = isNationalScope(p) ? 'national' : p.wardCode ? 'ward' : 'region';

  if (q.ward) {
    const wards = await scopeWardsFor(p);
    if (wards !== null && !wards.includes(q.ward)) throw httpError(403, 'Ward outside your scope');
  }

  // Scope + optional single-ward filter are applied to the ORIGINATOR's ward /
  // region (via the shared memberScope helper); the downline walk itself is
  // unscoped so a councillor's tree is counted in full even where it crosses a
  // ward boundary (counts are aggregates, not identity).
  const params: unknown[] = [];
  let idx = 1;
  let wardSql = '';
  if (q.ward) {
    wardSql = ` AND m.ward = $${idx}`;
    params.push(q.ward);
    idx++;
  }
  const sc = await memberScope(p, 'm', idx);
  params.push(...sc.params);
  idx = sc.nextIndex;
  const limit = Math.min(Math.max(q.limit, 1), 200);
  const limitSql = ` LIMIT $${idx}`;
  params.push(limit);

  const res = await query<{
    originator_id: string; public_code: string | null; ward: string | null; region_code: string | null;
    direct: string; active_recruits: string; pending_recruits: string; growth_30d: string; growth_90d: string;
    downline: string; tree_depth: string; is_councillor: boolean; display_name: string | null; position: string | null;
  }>(
    `WITH RECURSIVE climb AS (
       SELECT id AS member_id, id AS cur, referred_by_member_id AS parent, 0 AS depth
         FROM members WHERE deleted_at IS NULL
       UNION ALL
       SELECT c.member_id, pa.id, pa.referred_by_member_id, c.depth + 1
         FROM climb c JOIN members pa ON pa.id = c.parent
        WHERE pa.deleted_at IS NULL AND c.depth < ${MAX_DEPTH}
     ),
     downline AS (
       SELECT cur AS originator_id, count(*)::int AS downline, max(depth)::int AS tree_depth
         FROM climb WHERE cur <> member_id GROUP BY cur
     ),
     direct AS (
       SELECT referred_by_member_id AS originator_id,
              count(*)::int AS direct,
              count(*) FILTER (WHERE status = 'active')::int AS active_recruits,
              count(*) FILTER (WHERE status = 'pending')::int AS pending_recruits,
              count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS growth_30d,
              count(*) FILTER (WHERE created_at >= now() - interval '90 days')::int AS growth_90d
         FROM members WHERE referred_by_member_id IS NOT NULL AND deleted_at IS NULL
        GROUP BY referred_by_member_id
     )
     SELECT d.originator_id, m.public_code, m.ward, m.region_code,
            d.direct, d.active_recruits, d.pending_recruits, d.growth_30d, d.growth_90d,
            GREATEST(COALESCE(dl.downline, 0), d.direct) AS downline,
            COALESCE(dl.tree_depth, 1) AS tree_depth,
            (wp.ward_code IS NOT NULL OR ld.member_id IS NOT NULL) AS is_councillor,
            ld.full_name AS display_name, ld.position
       FROM direct d
       JOIN members m ON m.id = d.originator_id AND m.deleted_at IS NULL
       LEFT JOIN downline dl ON dl.originator_id = d.originator_id
       LEFT JOIN ward_profiles wp ON wp.councillor_member_id = d.originator_id
       LEFT JOIN LATERAL (
         SELECT l.member_id, l.full_name, pos.name AS position
           FROM leaders l LEFT JOIN positions pos ON pos.code = l.position_code
          WHERE l.member_id = d.originator_id AND l.is_public
          ORDER BY l.updated_at DESC LIMIT 1
       ) ld ON TRUE
      WHERE TRUE ${wardSql} ${sc.sql}
      ORDER BY is_councillor DESC, downline DESC, d.direct DESC, m.public_code
      ${limitSql}`,
    params,
  );

  const rows: ReportRow[] = res.rows.map((r) => ({
    originatorId: r.originator_id,
    publicCode: r.public_code,
    ward: r.ward,
    regionCode: r.region_code,
    isCouncillor: Boolean(r.is_councillor),
    displayName: r.display_name,
    position: r.position,
    direct: Number(r.direct),
    downline: Number(r.downline),
    treeDepth: Number(r.tree_depth),
    activeRecruits: Number(r.active_recruits),
    pendingRecruits: Number(r.pending_recruits),
    growth30d: Number(r.growth_30d),
    growth90d: Number(r.growth_90d),
  }));

  return {
    scope,
    wardFilter: q.ward ?? null,
    totals: {
      originators: rows.length,
      councillors: rows.filter((r) => r.isCouncillor).length,
      direct: rows.reduce((n, r) => n + r.direct, 0),
      downline: rows.reduce((n, r) => n + r.downline, 0),
    },
    rows,
  };
}
