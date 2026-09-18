import { query } from '../db/pool.js';
import { isNationalScope, Role, type Principal } from './permissions.js';

/**
 * Scope resolution — the single place that answers "which rows may this
 * principal see?".
 *
 * Every list and aggregate query in the API is expected to go through one of
 * these helpers rather than hand-rolling its own filter, so that ward /
 * region / national semantics cannot drift between modules. Before this file
 * existed each module applied no scoping at all, which is how a
 * `regional_organizer` came to be able to list members and cases from every
 * ward in the metro (a direct POPIA breach — personal data disclosed to a
 * party official with no lawful basis for that ward).
 *
 * Scope precedence, narrowest first:
 *   1. `principal.wardCode`      → exactly one ward   (ward_councillor, member)
 *   2. `principal.regionCodes`   → every ward under those regions (regional_organizer)
 *   3. neither / national_admin  → unfiltered         (national_admin, analyst)
 *
 * `isNationalScope()` is authoritative for step 3; it treats an empty
 * `regionCodes` as national, which is how `analyst` is provisioned.
 */

/** A WHERE fragment plus the parameters it consumes. */
export interface ScopeClause {
  /** e.g. ` AND sr.ward_code = $3` — empty string for national scope. */
  sql: string;
  params: unknown[];
  /** The next free `$n` placeholder index after this clause. */
  nextIndex: number;
}

const NATIONAL: ScopeClause = { sql: '', params: [], nextIndex: 0 };

/**
 * The ward codes a principal may see rows from.
 * `null` ⇒ national scope, i.e. no filter should be applied.
 */
export async function visibleWardCodes(p: Principal): Promise<string[] | null> {
  if (isNationalScope(p)) return null;
  if (p.wardCode) return [p.wardCode];
  const regions = p.regionCodes ?? [];
  if (regions.length === 0) return [];
  const res = await query(
    `WITH RECURSIVE territory AS (
           SELECT code FROM regions WHERE code = ANY($1::text[])
           UNION SELECT r.code FROM regions r JOIN territory t ON r.parent_code = t.code
         ) SELECT r.code FROM regions r JOIN territory t ON t.code = r.code WHERE r.level = 'ward'`,
    [regions],
  );
  return res.rows.map((r: any) => r.code as string);
}

/**
 * Scope clause for a table whose ward column holds a ward code directly
 * (`service_requests.ward_code`, `patrols.ward_code`, `events.ward_code`, …).
 *
 * A regional principal's `regionCodes` are subcouncil/region codes, not ward
 * codes, so they are expanded through `regions.parent_code` rather than
 * compared literally.
 */
export async function wardCodeScope(
  p: Principal,
  column: string,
  startIdx: number,
): Promise<ScopeClause> {
  if (isNationalScope(p)) return { ...NATIONAL, nextIndex: startIdx };

  if (p.wardCode) {
    return { sql: ` AND ${column} = $${startIdx}`, params: [p.wardCode], nextIndex: startIdx + 1 };
  }

  const regions = p.regionCodes ?? [];
  if (regions.length === 0) {
    // Scoped principal with no regions at all: matches nothing.
    return { sql: ` AND FALSE`, params: [], nextIndex: startIdx };
  }
  return {
    sql: ` AND ${column} IN (WITH RECURSIVE territory AS (
          SELECT code FROM regions WHERE code = ANY($${startIdx}::text[])
          UNION SELECT r.code FROM regions r JOIN territory t ON r.parent_code = t.code
        ) SELECT r.code FROM regions r JOIN territory t ON t.code = r.code WHERE r.level = 'ward')`,
    params: [regions],
    nextIndex: startIdx + 1,
  };
}

/**
 * Scope clause for the `members` table, which stores its ward code in `ward`
 * and its parent region in `region_code`. Filtering on `region_code` for a
 * regional principal is both correct and cheaper than a ward sub-select
 * (there is an index on it; `ward` has none).
 */
export async function memberScope(
  p: Principal,
  alias: string,
  startIdx: number,
): Promise<ScopeClause> {
  if (isNationalScope(p)) return { ...NATIONAL, nextIndex: startIdx };

  if (p.wardCode) {
    return { sql: ` AND ${alias}.ward = $${startIdx}`, params: [p.wardCode], nextIndex: startIdx + 1 };
  }

  const regions = p.regionCodes ?? [];
  if (regions.length === 0) {
    return { sql: ` AND FALSE`, params: [], nextIndex: startIdx };
  }
  return {
    sql: ` AND ${alias}.region_code = ANY($${startIdx}::text[])`,
    params: [regions],
    nextIndex: startIdx + 1,
  };
}

/** True when the principal may read data belonging to `wardCode`. */
export async function principalSeesWard(p: Principal, wardCode: string): Promise<boolean> {
  if (isNationalScope(p)) return true;
  if (p.wardCode) return p.wardCode === wardCode;
  const regions = p.regionCodes ?? [];
  if (regions.length === 0) return false;
  const res = await query(
    `WITH RECURSIVE territory AS (
           SELECT code FROM regions WHERE code = ANY($2::text[])
           UNION SELECT r.code FROM regions r JOIN territory t ON r.parent_code = t.code
         ) SELECT 1 FROM territory WHERE code = $1`,
    [wardCode, regions],
  );
  return res.rows.length > 0;
}

/** True when the principal may read data belonging to any of `wardCodes`. */
export async function principalSeesAnyWard(p: Principal, wardCodes: string[]): Promise<boolean> {
  if (isNationalScope(p)) return true;
  const visible = await visibleWardCodes(p);
  if (visible === null) return true;
  return wardCodes.some((w) => visible.includes(w));
}

/**
 * Row-level counterpart of `memberScope()` — the exact same rule applied to one
 * already-fetched member instead of to a WHERE clause.
 *
 * A ward-scoped principal is checked against the member's `ward`, NOT their
 * `region_code`: a regional principal's `regionCodes` are subcouncil codes that
 * contain several wards, so a region-only check lets a ward_councillor read any
 * member in their whole subcouncil. A row with no ward falls back to the region
 * check so members recorded before ward capture stay visible to their region.
 */
export async function principalSeesMember(
  p: Principal,
  member: { regionCode: string | null; ward: string | null },
): Promise<boolean> {
  if (isNationalScope(p)) return true;
  if (p.wardCode) {
    if (member.ward) return member.ward === p.wardCode;
    return false;
  }
  const regions = p.regionCodes ?? [];
  if (regions.length === 0) return false;
  if (member.regionCode) return regions.includes(member.regionCode);
  return !!member.ward && (await principalSeesWard(p, member.ward));
}

/**
 * Row-level scope test for content that carries BOTH a region and an optional
 * ward (`posts`, `events`, `appointments`).
 *
 * These tables were previously guarded by a region-only test, which is exactly
 * the subcouncil trap described on `principalSeesMember`: a `local_coordinator`
 * scoped to CPT-W075 could edit, take down or delete any post or event tagged
 * with another ward inside CPT-SC17, and could CREATE one tagged with a ward
 * that is not theirs.
 *
 * A ward-scoped principal must match the row's ward. A row with no ward at all
 * is region- or national-level content and is therefore not a ward official's to
 * change — denying is the correct, conservative answer.
 */
export async function principalSeesPlace(
  p: Principal,
  place: { regionCode?: string | null; ward?: string | null },
): Promise<boolean> {
  if (isNationalScope(p)) return true;

  if (p.wardCode) return !!place.ward && place.ward === p.wardCode;

  const regions = p.regionCodes ?? [];
  if (regions.length === 0) return false;
  if (place.regionCode) return regions.includes(place.regionCode);
  return !!place.ward && (await principalSeesWard(p, place.ward));
}

/**
 * WHERE-clause counterpart of `principalSeesPlace()` for tables that carry BOTH
 * a region and an optional ward (`posts`, `events`, `appointments`).
 *
 * `wardCodeScope()` alone is not enough for these: region-level content is
 * stored with `region_code` set and `ward` NULL, so filtering purely on the ward
 * column hides a subcouncil's own regional material from its organizer, while
 * filtering purely on `region_code` is the subcouncil trap that lets a
 * ward official read neighbouring wards.
 *
 * Returns an empty clause for national scope.
 */
export async function placeScope(
  p: Principal,
  columns: { regionColumn: string; wardColumn: string },
  startIdx: number,
): Promise<ScopeClause> {
  if (isNationalScope(p)) return { ...NATIONAL, nextIndex: startIdx };

  const { regionColumn, wardColumn } = columns;
  if (p.wardCode) {
    return {
      sql: ` AND ${wardColumn} = $${startIdx}`,
      params: [p.wardCode],
      nextIndex: startIdx + 1,
    };
  }

  const regions = p.regionCodes ?? [];
  if (regions.length === 0) {
    return { sql: ` AND FALSE`, params: [], nextIndex: startIdx };
  }
  return {
    sql: ` AND (${regionColumn} = ANY($${startIdx}::text[])
              OR ${wardColumn} IN (SELECT code FROM regions
                                    WHERE level = 'ward' AND parent_code = ANY($${startIdx}::text[])))`,
    params: [regions],
    nextIndex: startIdx + 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Visibility tier (FR-E) — orthogonal to territory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Roles that act for the party in an official capacity and may therefore see
 * operational records marked `visibility = 'private'`.
 *
 * This is a TIER rule, not a territory rule: being staff says nothing about
 * WHICH ward you may see, and having a ward says nothing about whether you may
 * see private records in it. Both must hold. `member` and `analyst` are
 * deliberately outside this set — a member sees their ward's public record, and
 * an analyst sees aggregates only.
 */
export const STAFF_ROLES: ReadonlySet<Role> = new Set<Role>([
  Role.NATIONAL_ADMIN,
  Role.REGIONAL_ORGANIZER,
  Role.LOCAL_COORDINATOR,
  Role.WARD_COUNCILLOR,
]);

/** True when the principal may read `visibility = 'private'` records. */
export function canSeePrivate(p: Principal): boolean {
  return STAFF_ROLES.has(p.role);
}

/**
 * WHERE fragment excluding private records from callers who may not see them.
 * Append to a query whose ward column is `column`; returns '' for staff.
 */
export function privateTierClause(p: Principal, column = 'visibility'): string {
  return canSeePrivate(p) ? '' : ` AND ${column} <> 'private'`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Publication gate — civic content (projects, bulletins, job opportunities)
// ─────────────────────────────────────────────────────────────────────────────

/** True when the principal may see civic content that is not yet published. */
export function canSeeUnpublished(p: Principal): boolean {
  return STAFF_ROLES.has(p.role);
}

/**
 * Gate for published civic content.
 *
 * PUBLICATION — not territory — is what makes this content public. Everyone may
 * read whatever has been published, in any ward; territory governs only the
 * material that is NOT yet published. So a councillor can hold a draft in their
 * own ward without the draft being visible nationally, and without losing sight
 * of published work elsewhere.
 *
 * Returns an empty clause for national-scope STAFF, who see drafts everywhere.
 *
 * Before this existed the list endpoints applied neither gate: any `case:read`
 * or `bulletin:read` holder — including an ordinary member — received draft and
 * unpublished rows from every ward in the country.
 */
export async function publishedOrInTerritory(
  p: Principal,
  publishedExpr: string,
  wardColumn: string,
  startIdx: number,
): Promise<ScopeClause> {
  // PUBLICATION IS TESTED BEFORE SCOPE, deliberately.
  //
  // `isNationalScope()` answers "which territory does this principal hold", not
  // "may this principal read unpublished material" — those are orthogonal axes.
  // Testing scope first let a national-scope NON-STAFF principal (`analyst`)
  // short-circuit into seeing every draft in the country from the LIST endpoints,
  // while the matching single-record reads (`getVisibleBulletin`,
  // `canReadProject`) correctly returned 404 for the same row. The list and the
  // read disagreed, so the gate was only as strong as whichever one a client
  // happened to call (D43).
  //
  // This mirrors the private-visibility tier: national scope never confers a
  // restricted tier on its own (D45).
  if (!canSeeUnpublished(p)) {
    return { sql: ` AND ${publishedExpr}`, params: [], nextIndex: startIdx };
  }
  if (isNationalScope(p)) return { sql: '', params: [], nextIndex: startIdx };
  const scope = await wardCodeScope(p, wardColumn, startIdx);
  if (!scope.sql) return { sql: '', params: scope.params, nextIndex: scope.nextIndex };
  return {
    sql: ` AND (${publishedExpr} OR TRUE${scope.sql})`,
    params: scope.params,
    nextIndex: scope.nextIndex,
  };
}
