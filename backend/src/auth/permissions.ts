/**
 * Role-Based Access Control (RBAC) definitions.
 *
 * A single national party uses a small, well-understood role set. Roles map
 * to permissions; permissions gate routes. Region scoping (ABAC-style) is
 * applied on top via the JWT's `regionCodes` claim.
 */

export const Role = {
  /**
   * Platform owner. A strict superset of national_admin plus the operations
   * surface (server/cron status, first-party analytics, website content). Kept
   * distinct so ops tooling is not exposed to every political national admin.
   */
  SUPERADMIN: 'superadmin',
  NATIONAL_ADMIN: 'national_admin',
  REGIONAL_ORGANIZER: 'regional_organizer',
  LOCAL_COORDINATOR: 'local_coordinator',
  WARD_COUNCILLOR: 'ward_councillor',
  ANALYST: 'analyst',
  MEMBER: 'member',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const Permission = {
  MEMBER_READ: 'member:read',
  MEMBER_WRITE: 'member:write',
  MEMBER_DELETE: 'member:delete',
  /** Decrypt sealed PII (email/phone/address). Highly privileged + always audited. */
  PII_DECRYPT: 'member:pii_decrypt',
  MEMBER_EXPORT: 'member:export',
  GEO_READ: 'geo:read',
  /**
   * Read ONLY the caller's own ward on the map (Wave 4 restricted member map).
   * Members hold this instead of the broader `geo:read`; the member-safe geo
   * routes accept `geo:read` OR `geo:read_own_ward` and hard-scope every result
   * to `principal.wardCode`, so a member can only ever receive their own
   * subcouncil → ward → councillor bio plus a ward case heatmap — never the
   * member points, choropleth or municipality/region analytics `geo:read`
   * unlocks. Belongs to the `map` module, so disabling Map strips it too.
   */
  GEO_READ_OWN_WARD: 'geo:read_own_ward',
  AUDIT_READ: 'audit:read',
  ROLE_MANAGE: 'role:manage',
  CONSENT_MANAGE: 'consent:manage',
  /** Engagement layer: events, communications, appointments/mandates. */
  EVENT_WRITE: 'event:write',
  POST_WRITE: 'post:write',
  /** Moderate (take down) community notes / service-delivery reports. */
  POST_MODERATE: 'post:moderate',
  APPOINT_WRITE: 'appoint:write',
  NOTIFY_WRITE: 'notify:write',
  /** Service delivery: log, update, close, escalate, read cases. */
  CASE_LOG: 'case:log',
  CASE_UPDATE: 'case:update',
  CASE_CLOSE: 'case:close',
  CASE_ESCALATE: 'case:escalate',
  CASE_READ: 'case:read',
  /** Ward bulletins: publish and read ward-specific news feed. */
  BULLETIN_WRITE: 'bulletin:write',
  BULLETIN_READ: 'bulletin:read',
  /** Patrols: create/update patrols and read patrol data. */
  PATROL_WRITE: 'patrol:write',
  PATROL_READ: 'patrol:read',
  /** Public participation: create processes, comment, vote. */
  PARTICIPATION_WRITE: 'participation:write',
  PARTICIPATION_COMMENT: 'participation:comment',
  /** Ratings: rate councillor work, cases, projects (1-5 scale). */
  RATING_WRITE: 'rating:write',
  /** Verifications: verify closed service requests (workmanship check). */
  VERIFY_WRITE: 'verify:write',
  /** Engagement requests: ask for councillor/PAC time. */
  ENGAGEMENT_WRITE: 'engagement:write',
  /** Metro-wide overview: cross-ward analytics, aggregate stats. */
  OVERVIEW_READ: 'overview:read',
  /** Report generation: ward scorecards, service request reports, etc. */
  REPORT_GENERATE: 'report:generate',
  /**
   * Resident → councillor reporting. `report:write` lets a member (or a staff
   * role on a member's behalf) submit a report to the ward inbox; `report:read`
   * lets staff read that inbox. Formalised as its own permissions so the
   * `reports` module can toggle the surface independently of cases/engage.
   */
  REPORT_WRITE: 'report:write',
  REPORT_READ: 'report:read',
  /** Ward job interest register (PRD-jobs): members manage their OWN row. */
  JOBS_INTEREST_WRITE: 'jobs:interest_write',
  /** Aggregate, PII-free ward work-demand view (councillor/staff/analyst). */
  JOBS_DEMAND_READ: 'jobs:demand_read',
  /** Record/publish/close job opportunities for a ward (councillor/staff). */
  JOBS_OPPORTUNITY_WRITE: 'jobs:opportunity_write',
  /** Own the work-type taxonomy, feature flags and relay template (national only). */
  JOBS_ADMIN: 'jobs:admin',
  /** Moderate members: warn, suspend, ban, reinstate, and ban/unban devices. */
  MODERATE_USERS: 'moderate:users',
  /**
   * Administer the module registry: enable/disable whole feature modules per
   * role (CRM → Settings → Module registry). National admin only — the power to
   * strip a module's permissions from a role is the power to reshape the whole
   * platform's access, so it sits with the role/audit/consent administration.
   */
  MODULE_MANAGE: 'module:manage',
  /**
   * Recruitment genealogy (PRD-growth FR-O). `recruitment:read` opens the
   * recruitment tree + trace-to-source: a member sees ONLY their own downline,
   * staff see within scope. `recruitment:report` opens the ranked national/
   * regional growth report that attributes each recruitment tree to the ward
   * councillor who originated it. Both belong to the `recruitment` module, so
   * disabling it strips the whole surface.
   */
  RECRUITMENT_READ: 'recruitment:read',
  RECRUITMENT_REPORT: 'recruitment:report',
  /**
   * Councillor performance scorecards (PRD-growth FR-S). `rating:scorecard_write`
   * lets a MEMBER rate their own ward councillor once per calendar month across
   * the fixed categories (the 100-word reason rule for scores ≤2 is enforced in
   * the service). `rating:scorecard_read` opens the ward/scope inbox plus the
   * category rollups and ≤2 reasons queue. `rating:acknowledge` moves a
   * submission through submitted→viewed→acknowledged and notifies the member.
   * Distinct from the item-level `rating:write` (cases/projects/patrols), which is
   * unchanged. All three belong to the `scorecards` module.
   */
  RATING_SCORECARD_WRITE: 'rating:scorecard_write',
  RATING_SCORECARD_READ: 'rating:scorecard_read',
  RATING_ACKNOWLEDGE: 'rating:acknowledge',
  /**
   * SuperAdmin operations surface (owned by the `superadmin` module):
   * `platform:read` opens the server/cron/live-status dashboards, `analytics:read`
   * opens the first-party website/app analytics, and `content:manage` opens the
   * structured website content editor. Held only by the `superadmin` role.
   */
  PLATFORM_READ: 'platform:read',
  ANALYTICS_READ: 'analytics:read',
  CONTENT_MANAGE: 'content:manage',
  APP_RELEASE_MANAGE: 'app_release:manage',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

/**
 * The national-admin base matrix, extracted so `superadmin` can be defined as a
 * strict superset without duplicating (and risking drift from) the list.
 */
const NATIONAL_ADMIN_PERMISSIONS: readonly Permission[] = [
    Permission.MEMBER_READ,
    Permission.MEMBER_WRITE,
    Permission.MEMBER_DELETE,
    Permission.PII_DECRYPT,
    Permission.MEMBER_EXPORT,
    Permission.GEO_READ,
    Permission.AUDIT_READ,
    Permission.ROLE_MANAGE,
    Permission.MODERATE_USERS,
    Permission.CONSENT_MANAGE,
    Permission.MODULE_MANAGE,
    Permission.EVENT_WRITE,
    Permission.POST_WRITE,
    Permission.POST_MODERATE,
    Permission.APPOINT_WRITE,
    Permission.NOTIFY_WRITE,
    // Service delivery
    Permission.CASE_LOG,
    Permission.CASE_UPDATE,
    Permission.CASE_CLOSE,
    Permission.CASE_ESCALATE,
    Permission.CASE_READ,
    Permission.BULLETIN_WRITE,
    Permission.BULLETIN_READ,
    Permission.PATROL_WRITE,
    Permission.PATROL_READ,
    Permission.PARTICIPATION_WRITE,
    Permission.PARTICIPATION_COMMENT,
    Permission.RATING_WRITE,
    Permission.VERIFY_WRITE,
    Permission.ENGAGEMENT_WRITE,
    Permission.OVERVIEW_READ,
    Permission.REPORT_GENERATE,
    Permission.REPORT_WRITE,
    Permission.REPORT_READ,
    // Ward jobs (PRD-jobs): national owns taxonomy + full aggregate/opportunity access.
    Permission.JOBS_INTEREST_WRITE,
    Permission.JOBS_DEMAND_READ,
    Permission.JOBS_OPPORTUNITY_WRITE,
    Permission.JOBS_ADMIN,
    // Recruitment genealogy (PRD-growth FR-O): national sees every tree + report.
    Permission.RECRUITMENT_READ,
    Permission.RECRUITMENT_REPORT,
    // Councillor scorecards (FR-S): national oversight reads every rollup and may
    // acknowledge. NOT scorecard_write — FR-S5 keeps submission a member action.
    Permission.RATING_SCORECARD_READ,
    Permission.RATING_ACKNOWLEDGE,
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // SuperAdmin: everything national_admin can do, plus the ops/analytics/content surface.
  [Role.SUPERADMIN]: [
    ...NATIONAL_ADMIN_PERMISSIONS,
    Permission.PLATFORM_READ,
    Permission.ANALYTICS_READ,
    Permission.CONTENT_MANAGE,
    Permission.APP_RELEASE_MANAGE,
  ],
  [Role.NATIONAL_ADMIN]: NATIONAL_ADMIN_PERMISSIONS,
  [Role.REGIONAL_ORGANIZER]: [
    Permission.MEMBER_READ,
    Permission.MEMBER_WRITE,
    Permission.PII_DECRYPT,
    Permission.GEO_READ,
    Permission.CONSENT_MANAGE,
    Permission.EVENT_WRITE,
    Permission.POST_WRITE,
    Permission.POST_MODERATE,
    Permission.APPOINT_WRITE,
    Permission.NOTIFY_WRITE,
    // Service delivery (region-scoped)
    Permission.CASE_LOG,
    Permission.CASE_UPDATE,
    Permission.CASE_CLOSE,
    Permission.CASE_ESCALATE,
    Permission.CASE_READ,
    Permission.BULLETIN_WRITE,
    Permission.BULLETIN_READ,
    Permission.PATROL_WRITE,
    Permission.PATROL_READ,
    Permission.PARTICIPATION_WRITE,
    Permission.PARTICIPATION_COMMENT,
    Permission.RATING_WRITE,
    Permission.VERIFY_WRITE,
    Permission.ENGAGEMENT_WRITE,
    Permission.OVERVIEW_READ,
    Permission.REPORT_GENERATE,
    Permission.REPORT_WRITE,
    Permission.REPORT_READ,
    // Ward jobs (region-scoped aggregate demand + opportunities).
    Permission.JOBS_DEMAND_READ,
    Permission.JOBS_OPPORTUNITY_WRITE,
    // Recruitment genealogy (region-scoped report + drill-down tree).
    Permission.RECRUITMENT_READ,
    Permission.RECRUITMENT_REPORT,
    // Councillor scorecards (FR-S): region-scoped category rollups + reasons queue.
    Permission.RATING_SCORECARD_READ,
  ],
  // Branch level: can organise events and communicate, not moderate or appoint.
  [Role.LOCAL_COORDINATOR]: [
    Permission.MEMBER_READ,
    Permission.MEMBER_WRITE,
    Permission.GEO_READ,
    Permission.EVENT_WRITE,
    Permission.POST_WRITE,
    // Service delivery (ward/district-scoped)
    Permission.CASE_LOG,
    Permission.CASE_READ,
    Permission.BULLETIN_READ,
    // A local coordinator walks/drives ward patrols like the councillor and the
    // regional/national organisers, so they can start one and file its overview
    // report (Wave 3 field logging). Read was already granted; this adds write.
    Permission.PATROL_WRITE,
    Permission.PATROL_READ,
    Permission.PARTICIPATION_COMMENT,
    Permission.RATING_WRITE,
    Permission.VERIFY_WRITE,
    Permission.ENGAGEMENT_WRITE,
    Permission.REPORT_WRITE,
    Permission.REPORT_READ,
    // Ward jobs (branch wards): aggregate demand + record opportunities.
    Permission.JOBS_DEMAND_READ,
    Permission.JOBS_OPPORTUNITY_WRITE,
    // Recruitment genealogy (branch-ward report + drill-down tree).
    Permission.RECRUITMENT_READ,
    Permission.RECRUITMENT_REPORT,
    // Councillor scorecards (FR-S): branch-ward rollups + reasons queue.
    Permission.RATING_SCORECARD_READ,
  ],
  // Ward councillor: full ward-scoped service delivery + patrols + bulletins.
  [Role.WARD_COUNCILLOR]: [
    Permission.MEMBER_READ,
    Permission.GEO_READ,
    // Desktop CRM access. This is a deliberate grant: the councillor works the
    // CRM on a desktop, and `overview:read` is the router-level gate for it.
    // It is safe ONLY because crm/service.ts filters every result to
    // principal.wardCode via auth/scope.ts — without that scoping this would
    // hand a single ward's councillor the national dashboard.
    // Deliberately NOT granted: event:write, post:write, notify:write,
    // member:pii_decrypt, audit:read, role:manage, moderate:users.
    Permission.OVERVIEW_READ,
    Permission.CASE_LOG,
    Permission.CASE_UPDATE,
    Permission.CASE_CLOSE,
    Permission.CASE_READ,
    Permission.BULLETIN_WRITE,
    Permission.BULLETIN_READ,
    Permission.PATROL_WRITE,
    Permission.PATROL_READ,
    Permission.PARTICIPATION_WRITE,
    Permission.PARTICIPATION_COMMENT,
    Permission.RATING_WRITE,
    Permission.VERIFY_WRITE,
    Permission.ENGAGEMENT_WRITE,
    Permission.REPORT_GENERATE,
    Permission.REPORT_WRITE,
    Permission.REPORT_READ,
    // Ward jobs: councillor sees own-ward aggregate demand + posts opportunities.
    Permission.JOBS_DEMAND_READ,
    Permission.JOBS_OPPORTUNITY_WRITE,
    // Recruitment genealogy (FR-O): the councillor sees the tree they originate
    // (their reference number is the attribution token) and their ward report.
    Permission.RECRUITMENT_READ,
    Permission.RECRUITMENT_REPORT,
    // Councillor scorecards (FR-S): the councillor reads their own ward's
    // submissions and acknowledges them (submitted→viewed→acknowledged).
    Permission.RATING_SCORECARD_READ,
    Permission.RATING_ACKNOWLEDGE,
  ],
  // Analysts see aggregates/geo only — no PII, no decrypt, no export of raw PII.
  [Role.ANALYST]: [
    Permission.GEO_READ,
    Permission.CASE_READ,
    Permission.OVERVIEW_READ,
    // Ward jobs: read-only aggregate demand (no personal data, no writes).
    Permission.JOBS_DEMAND_READ,
    // Recruitment genealogy: the ranked aggregate report only. The analyst is
    // aggregate-only under POPIA, so it does NOT hold recruitment:read (the tree
    // is a per-member structure, even though it exposes public codes, not names).
    Permission.RECRUITMENT_REPORT,
    // Councillor scorecards (FR-S): aggregate category rollups only (read-only),
    // no acknowledgement and no per-member submission.
    Permission.RATING_SCORECARD_READ,
  ],
  // Members: ward-scoped read + participate + verify + rate + engage.
  [Role.MEMBER]: [
    Permission.CASE_READ,
    Permission.BULLETIN_READ,
    Permission.PATROL_READ,
    Permission.PARTICIPATION_COMMENT,
    Permission.RATING_WRITE,
    Permission.VERIFY_WRITE,
    Permission.ENGAGEMENT_WRITE,
    // A member submits a report to their ward councillor; reading the ward
    // *inbox* (everyone's reports) is `report:read` and is staff-only. A member
    // still reads their OWN reports via `?scope=mine`, which needs no permission.
    Permission.REPORT_WRITE,
    // A member sees their OWN ward on the map (their subcouncil → their ward →
    // the councillor bio, plus a heatmap of the non-private cases staff logged
    // in that ward) — never the full analytics map `geo:read` unlocks. The
    // member-safe geo routes hard-scope to `principal.wardCode` (Wave 4).
    Permission.GEO_READ_OWN_WARD,
    // Ward jobs: member manages their OWN job-interest row (ward-gated).
    Permission.JOBS_INTEREST_WRITE,
    // Recruitment genealogy (FR-O2/O4): a member sees their OWN reference number,
    // join link and downline tree — never anyone else's, never the ranked report.
    Permission.RECRUITMENT_READ,
    // Councillor scorecards (FR-S): a member rates THEIR OWN ward councillor once
    // a month. Reading/acknowledging others' scorecards is staff-only, so a member
    // holds write alone; the service hard-scopes it to their ward + councillor.
    Permission.RATING_SCORECARD_WRITE,
  ],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

/**
 * The effective permission set for a role, exactly as `requirePermission`
 * evaluates it server-side.
 *
 * Exported so the auth service can hand the caller their own capabilities down
 * with the login/refresh response. The frontend derives its UI capability flags
 * from that list instead of maintaining a parallel copy of this matrix — the
 * copy it had drifted on 11 fields, rendering buttons that returned 403.
 *
 * An unknown role yields no permissions: fail closed, same as
 * `roleHasPermission`.
 */
export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

/** Every permission name the system knows, for validating stored overrides. */
const PERMISSION_VOCABULARY: ReadonlySet<string> = new Set(Object.values(Permission));

// ── Module registry ────────────────────────────────────────────────────────
//
// A "module" is a whole feature surface an administrator can switch off per
// role. The switch is enforced HERE, at the single funnel every effective
// permission set flows through, rather than route by route: disabling a module
// strips every permission it owns, so `requirePermission` returns 403 on all of
// the module's routes and the frontend's `deriveCaps` flips the matching
// capability off — no per-route or per-component change is needed.
//
// `MODULE_PERMISSIONS` is the single source of truth for which permissions a
// module owns. `scripts/check-caps.mjs` pins it in both directions (every module's
// permissions exist; no permission is owned by two modules), and requires every
// permission to be owned by exactly one module OR listed as a deliberate
// cross-cutting exception (`rating:write`, `verify:write` — they attach to cases,
// projects and councillors at once, so no single module owns them and they
// survive every toggle). A permission can therefore never silently end up owned
// by two modules, nor by none without an explicit decision.

export const ModuleKey = {
  MAP: 'map',
  MEMBERS: 'members',
  CASES: 'cases',
  PATROLS: 'patrols',
  REPORTS: 'reports',
  ENGAGE: 'engage',
  BULLETINS: 'bulletins',
  NEWSROOM: 'newsroom',
  JOBS: 'jobs',
  OVERVIEW: 'overview',
  ID_CARDS: 'id_cards',
  MODERATION: 'moderation',
  ADMIN: 'admin',
  RECRUITMENT: 'recruitment',
  SCORECARDS: 'scorecards',
  /** SuperAdmin operations: server/cron status, analytics, website content editor. */
  SUPERADMIN: 'superadmin',
} as const;

export type ModuleKey = (typeof ModuleKey)[keyof typeof ModuleKey];

/**
 * The permissions each module OWNS: disabling the module strips exactly these.
 *
 * `id_cards` owns none. It is a UI-only surface (the party ID card & QR) that
 * rides on `member:read` — stripping `member:read` to disable the card would
 * also delete the whole Members tab, which is not what "turn off ID cards"
 * means. It is therefore gated by an explicit `requireModule('id_cards')` on
 * its one route and by `moduleOn('id_cards')` in the UI, on top of `member:read`.
 */
export const MODULE_PERMISSIONS: Record<ModuleKey, readonly Permission[]> = {
  // The `map` module owns BOTH the staff-wide `geo:read` and the member's
  // ward-scoped `geo:read_own_ward`, so disabling Map for a role strips
  // whichever it holds — a member loses the restricted map exactly as a staff
  // role loses the full one (Wave 4).
  [ModuleKey.MAP]: [Permission.GEO_READ, Permission.GEO_READ_OWN_WARD],
  [ModuleKey.MEMBERS]: [
    Permission.MEMBER_READ,
    Permission.MEMBER_WRITE,
    Permission.MEMBER_DELETE,
    Permission.MEMBER_EXPORT,
    Permission.PII_DECRYPT,
  ],
  [ModuleKey.CASES]: [
    Permission.CASE_LOG,
    Permission.CASE_UPDATE,
    Permission.CASE_CLOSE,
    Permission.CASE_ESCALATE,
    Permission.CASE_READ,
  ],
  [ModuleKey.PATROLS]: [Permission.PATROL_WRITE, Permission.PATROL_READ],
  [ModuleKey.REPORTS]: [Permission.REPORT_WRITE, Permission.REPORT_READ],
  [ModuleKey.ENGAGE]: [
    Permission.EVENT_WRITE,
    Permission.APPOINT_WRITE,
    Permission.PARTICIPATION_WRITE,
    Permission.PARTICIPATION_COMMENT,
    Permission.ENGAGEMENT_WRITE,
    Permission.NOTIFY_WRITE,
  ],
  [ModuleKey.BULLETINS]: [Permission.BULLETIN_WRITE, Permission.BULLETIN_READ],
  [ModuleKey.NEWSROOM]: [Permission.POST_WRITE, Permission.POST_MODERATE],
  [ModuleKey.JOBS]: [
    Permission.JOBS_INTEREST_WRITE,
    Permission.JOBS_DEMAND_READ,
    Permission.JOBS_OPPORTUNITY_WRITE,
    Permission.JOBS_ADMIN,
  ],
  [ModuleKey.OVERVIEW]: [Permission.OVERVIEW_READ, Permission.REPORT_GENERATE],
  [ModuleKey.ID_CARDS]: [],
  [ModuleKey.MODERATION]: [Permission.MODERATE_USERS],
  [ModuleKey.ADMIN]: [
    Permission.ROLE_MANAGE,
    Permission.AUDIT_READ,
    Permission.CONSENT_MANAGE,
    Permission.MODULE_MANAGE,
  ],
  // Recruitment genealogy (PRD-growth FR-O): disabling the module strips both the
  // tree/lineage read and the ranked growth report together.
  [ModuleKey.RECRUITMENT]: [Permission.RECRUITMENT_READ, Permission.RECRUITMENT_REPORT],
  // Councillor scorecards (PRD-growth FR-S): disabling the module strips the
  // member write, the staff/national read and the acknowledgement together.
  [ModuleKey.SCORECARDS]: [
    Permission.RATING_SCORECARD_WRITE,
    Permission.RATING_SCORECARD_READ,
    Permission.RATING_ACKNOWLEDGE,
  ],
  // SuperAdmin ops surface: disabling it strips the platform/analytics/content trio together.
  [ModuleKey.SUPERADMIN]: [
    Permission.PLATFORM_READ,
    Permission.ANALYTICS_READ,
    Permission.CONTENT_MANAGE,
    Permission.APP_RELEASE_MANAGE,
  ],
};

/**
 * The inverse of `MODULE_PERMISSIONS`: permission → the single module that owns
 * it. Built once at module load. A permission owned by two modules would make
 * the owner ambiguous (disabling one would strip it while the other still
 * "needs" it), so `check-caps.mjs` fails the build if that ever happens.
 */
export const PERMISSION_MODULE: ReadonlyMap<Permission, ModuleKey> = (() => {
  const map = new Map<Permission, ModuleKey>();
  for (const key of Object.values(ModuleKey)) {
    for (const perm of MODULE_PERMISSIONS[key]) map.set(perm, key);
  }
  return map;
})();

/**
 * The modules a role is entitled to by its BASE matrix — i.e. every module that
 * owns at least one permission the role holds. `id_cards` is the exception that
 * proves the rule: it owns no permission, so it is applicable to exactly the
 * roles that hold `member:read` (the surface it rides on).
 *
 * This is the applicability rule the registry seed (migration 016) and the CRM
 * module matrix both use, so an administrator only ever sees a toggle for a
 * module the role could actually hold. It reads the BASE matrix on purpose: a
 * per-user grant of `geo:read` does not make the Map module a role-level concern.
 */
export function modulesForRole(role: Role): ModuleKey[] {
  const held = new Set<Permission>(permissionsForRole(role) as Permission[]);
  const out: ModuleKey[] = [];
  for (const key of Object.values(ModuleKey)) {
    const owned = MODULE_PERMISSIONS[key];
    const applies =
      owned.length === 0
        ? key === ModuleKey.ID_CARDS && held.has(Permission.MEMBER_READ)
        : owned.some((p) => held.has(p));
    if (applies) out.push(key);
  }
  return out;
}

/**
 * The effective permission set for a user: their role's base matrix, plus any
 * per-user grants, minus any per-user revokes, minus every permission owned by a
 * module the role has switched off.
 *
 * Overrides are stored on `users.permission_grants` / `users.permission_revokes`
 * (migration 015) and let an administrator tailor one person's access without
 * inventing a new role. Entries that are not part of the `Permission`
 * vocabulary are dropped, so a stale or hand-edited override can never mint an
 * unknown capability — fail closed, same as `permissionsForRole`.
 *
 * `disabledModules` comes from `role_module_gates` (migration 016), read live by
 * `authenticate` and by the auth service. Module stripping runs LAST: a disabled
 * module removes its permissions even if a per-user grant would have added one
 * back, because the module switch is the administrator's coarser, later intent.
 * An absent/empty list changes nothing, so callers that have not loaded the
 * registry (optional-auth) behave exactly as before.
 */
export function effectivePermissions(
  role: Role,
  grants?: readonly string[] | null,
  revokes?: readonly string[] | null,
  disabledModules?: readonly string[] | null,
): Permission[] {
  const base = permissionsForRole(role);
  const revoked = new Set((revokes ?? []).filter((p) => PERMISSION_VOCABULARY.has(p)));
  const set = new Set<Permission>(base.filter((p) => !revoked.has(p)) as Permission[]);
  for (const g of grants ?? []) {
    if (PERMISSION_VOCABULARY.has(g) && !revoked.has(g)) set.add(g as Permission);
  }
  const disabled = new Set(disabledModules ?? []);
  if (disabled.size > 0) {
    for (const perm of [...set]) {
      const owner = PERMISSION_MODULE.get(perm);
      if (owner && disabled.has(owner)) set.delete(perm);
    }
  }
  return [...set];
}

/** The authenticated principal attached to each request. */
export interface Principal {
  sub: string; // user id
  role: Role;
  /** Regions this principal may access. Empty/undefined ⇒ national (all). */
  regionCodes?: string[];
  /** Ward this principal is scoped to (for ward_councillor / member). */
  wardCode?: string;
  email?: string;
  /**
   * The caller's effective permissions (role base ± per-user overrides − disabled
   * modules), read live from the DB by `authenticate`. `requirePermission`
   * prefers this over recomputing from the role so overrides and module switches
   * take effect immediately. Absent on optional-auth principals (no DB read),
   * which fall back to the role matrix.
   */
  permissions?: Permission[];
  /**
   * The module keys enabled for this principal's role, read live alongside the
   * permissions. Permission-backed modules are already enforced through
   * `permissions`; this list exists for the UI-only surfaces (`id_cards`) that
   * own no permission and for `requireModule`. Absent on optional-auth
   * principals, which therefore see no UI-only modules (fail closed).
   */
  enabledModules?: string[];
}

/** True when the principal is scoped to the whole country. */
export function isNationalScope(p: Principal): boolean {
  return (
    p.role === Role.SUPERADMIN ||
    p.role === Role.NATIONAL_ADMIN ||
    (p.role === Role.ANALYST && !p.wardCode && !p.regionCodes?.length)
  );
}

/**
 * True for the top administrative roles that are national by definition and hold
 * the national_admin base matrix: `national_admin` and its strict superset
 * `superadmin`. Use this (not a raw `role === 'national_admin'` check) wherever a
 * module grants national-admin the widest, unscoped access, so superadmin keeps
 * the same reach. Deliberately excludes the national analyst (aggregate-only).
 */
export function isNationalAdmin(role: string): boolean {
  return role === Role.SUPERADMIN || role === Role.NATIONAL_ADMIN;
}
