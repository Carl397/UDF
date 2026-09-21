/**
 * UI capabilities, derived from the server's own permission list.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `AppShell.tsx` used to carry a hand-written `CAPS_BY_ROLE` table: a second
 * copy of the backend's role matrix, maintained by hand, in another package.
 * It drifted. Measured against `backend/src/auth/permissions.ts` it disagreed on
 * 11 role×capability fields — 8 of them OVER-offering, which is the harmful
 * direction: the UI renders a button, the member clicks it, the server returns
 * 403. A ward councillor saw "Publish event", "Issue a press release" and
 * "Broadcast notifications"; a local coordinator saw "Metro Overview", ward
 * bulletins and patrols. None of those were authorised.
 *
 * So the table is gone. The server now sends the caller's effective permissions
 * with the login/refresh response (`modules/auth/service.ts`), and this module
 * turns that list into capability flags. There is exactly one mapping left to
 * maintain — capability name → permission name — and it is role-agnostic, so it
 * cannot disagree about *who* gets *what*.
 *
 * The permission strings below mirror the server's vocabulary and are checked
 * against it in both directions by `scripts/check-caps.mjs` (npm run caps:check),
 * so a server-side rename fails the build instead of silently switching a
 * capability off.
 */

import type { Permission } from '../types';

/**
 * The backend permission vocabulary, mirrored from
 * `backend/src/auth/permissions.ts`. Complete on purpose: a partial mirror
 * invites the next person to guess a string, and the check script can only
 * prove the two agree if it sees all of them.
 */
export const Perm = {
  MEMBER_READ: 'member:read',
  MEMBER_WRITE: 'member:write',
  MEMBER_DELETE: 'member:delete',
  /** Decrypt sealed PII (email/phone/address). Always audited server-side. */
  PII_DECRYPT: 'member:pii_decrypt',
  MEMBER_EXPORT: 'member:export',
  GEO_READ: 'geo:read',
  /**
   * Read ONLY the caller's own ward on the map (Wave 4 restricted member map).
   * Members hold this instead of `geo:read`; the member-safe geo routes accept
   * either and hard-scope to the caller's ward.
   */
  GEO_READ_OWN_WARD: 'geo:read_own_ward',
  AUDIT_READ: 'audit:read',
  ROLE_MANAGE: 'role:manage',
  CONSENT_MANAGE: 'consent:manage',
  EVENT_WRITE: 'event:write',
  POST_WRITE: 'post:write',
  /** Take down community notes / service-delivery reports. */
  POST_MODERATE: 'post:moderate',
  APPOINT_WRITE: 'appoint:write',
  NOTIFY_WRITE: 'notify:write',
  CASE_LOG: 'case:log',
  CASE_UPDATE: 'case:update',
  CASE_CLOSE: 'case:close',
  CASE_ESCALATE: 'case:escalate',
  CASE_READ: 'case:read',
  BULLETIN_WRITE: 'bulletin:write',
  BULLETIN_READ: 'bulletin:read',
  PATROL_WRITE: 'patrol:write',
  PATROL_READ: 'patrol:read',
  PARTICIPATION_WRITE: 'participation:write',
  PARTICIPATION_COMMENT: 'participation:comment',
  RATING_WRITE: 'rating:write',
  VERIFY_WRITE: 'verify:write',
  ENGAGEMENT_WRITE: 'engagement:write',
  OVERVIEW_READ: 'overview:read',
  REPORT_GENERATE: 'report:generate',
  /**
   * Resident → councillor reporting. `report:write` submits a report to the ward
   * inbox (member + the four staff roles); `report:read` reads that inbox (staff
   * only). The `reports` module owns both, so switching it off strips them
   * together and the report surface disappears for that role.
   */
  REPORT_WRITE: 'report:write',
  REPORT_READ: 'report:read',
  JOBS_INTEREST_WRITE: 'jobs:interest_write',
  JOBS_DEMAND_READ: 'jobs:demand_read',
  JOBS_OPPORTUNITY_WRITE: 'jobs:opportunity_write',
  JOBS_ADMIN: 'jobs:admin',
  /** Ban/suspend ladder + device bans. Gates the CRM's Moderation screen. */
  MODERATE_USERS: 'moderate:users',
  /** Administer the per-role module registry (CRM → Settings). National only. */
  MODULE_MANAGE: 'module:manage',
  /**
   * Recruitment genealogy (PRD-growth FR-O). `RECRUITMENT_READ` opens the member
   * recruitment tree + trace-to-source (a member's own downline, staff in scope);
   * `RECRUITMENT_REPORT` opens the ranked national/regional growth report that
   * attributes each tree to the ward councillor who originated it. Both are owned
   * by the `recruitment` module. Used via `can(perms, Perm.X)` (the CRM nav and
   * the mobile "Invite & grow" surface), so neither needs a `Caps` flag.
   */
  RECRUITMENT_READ: 'recruitment:read',
  RECRUITMENT_REPORT: 'recruitment:report',
  /**
   * Councillor performance scorecards (PRD-growth FR-S). `RATING_SCORECARD_WRITE`
   * is the MEMBER-only surface — rate your own ward councillor once a month
   * across the fixed categories (the 100-word reason rule for scores ≤2 lives in
   * the service). `RATING_SCORECARD_READ` opens the ward/scope inbox, the
   * category rollups and the ≤2 reasons queue (councillor/staff/analyst). 
   * `RATING_ACKNOWLEDGE` moves a submission submitted→viewed→acknowledged and
   * notifies the member. All three are owned by the `scorecards` module and are
   * used via `can(perms, Perm.X)` (the mobile Home "Rate your councillor" card
   * and the CRM Scorecards screen), so none needs a `Caps` flag.
   */
  RATING_SCORECARD_WRITE: 'rating:scorecard_write',
  RATING_SCORECARD_READ: 'rating:scorecard_read',
  RATING_ACKNOWLEDGE: 'rating:acknowledge',
  /**
   * SuperAdmin operations surface (owned by the `superadmin` module, held only by
   * the `superadmin` role). None has a `Caps` flag — the CRM Platform nav gates
   * directly via `can(perms, Perm.X)`, so disabling the `superadmin` module
   * strips all three and every Platform screen disappears together.
   */
  PLATFORM_READ: 'platform:read',
  ANALYTICS_READ: 'analytics:read',
  CONTENT_MANAGE: 'content:manage',
} as const;

export type PermName = (typeof Perm)[keyof typeof Perm];

/** Every permission label names its action and subject, even outside a group. */
const PERMISSION_LABELS: Record<PermName, string> = {
  [Perm.MEMBER_READ]: 'View member records',
  [Perm.MEMBER_WRITE]: 'Create and edit member records',
  [Perm.MEMBER_DELETE]: 'Delete member records',
  [Perm.PII_DECRYPT]: 'Decrypt member personal details',
  [Perm.MEMBER_EXPORT]: 'Export member records',
  [Perm.CONSENT_MANAGE]: 'Manage member consent',
  [Perm.CASE_READ]: 'View service-delivery cases',
  [Perm.CASE_LOG]: 'Log service-delivery cases',
  [Perm.CASE_UPDATE]: 'Update service-delivery cases',
  [Perm.CASE_CLOSE]: 'Close service-delivery cases',
  [Perm.CASE_ESCALATE]: 'Escalate service-delivery cases',
  [Perm.ENGAGEMENT_WRITE]: 'View public participation and record projects',
  [Perm.BULLETIN_READ]: 'View ward bulletins',
  [Perm.BULLETIN_WRITE]: 'Publish ward bulletins',
  [Perm.PATROL_READ]: 'View patrol records',
  [Perm.PATROL_WRITE]: 'Start and update patrols',
  [Perm.EVENT_WRITE]: 'Create and manage events',
  [Perm.POST_WRITE]: 'Create and publish newsroom posts',
  [Perm.POST_MODERATE]: 'Moderate newsroom posts',
  [Perm.NOTIFY_WRITE]: 'Send notifications and manage campaigns',
  [Perm.APPOINT_WRITE]: 'Manage appointments to party positions',
  [Perm.PARTICIPATION_WRITE]: 'Create public participation processes',
  [Perm.PARTICIPATION_COMMENT]: 'Comment on public participation',
  [Perm.RATING_WRITE]: 'Submit service-delivery ratings',
  [Perm.VERIFY_WRITE]: 'Verify service-delivery repairs',
  [Perm.JOBS_INTEREST_WRITE]: 'Register own job interest',
  [Perm.JOBS_DEMAND_READ]: 'View ward job-interest totals',
  [Perm.JOBS_OPPORTUNITY_WRITE]: 'Post and manage job opportunities',
  [Perm.JOBS_ADMIN]: 'Manage job categories and settings',
  [Perm.OVERVIEW_READ]: 'View dashboards and service-delivery analytics',
  [Perm.GEO_READ]: 'View maps and geographic analytics',
  [Perm.GEO_READ_OWN_WARD]: 'View own ward map',
  [Perm.AUDIT_READ]: 'View audit logs',
  [Perm.REPORT_GENERATE]: 'Generate CRM reports',
  [Perm.REPORT_READ]: 'View resident reports and tasks',
  [Perm.REPORT_WRITE]: 'Submit and update resident reports',
  [Perm.ROLE_MANAGE]: 'Manage users, roles, and permissions',
  [Perm.MODERATE_USERS]: 'Manage user suspensions and bans',
  [Perm.MODULE_MANAGE]: 'Manage role access to feature modules',
  [Perm.RECRUITMENT_READ]: 'View recruitment trees and referral history',
  [Perm.RECRUITMENT_REPORT]: 'View recruitment growth reports',
  [Perm.RATING_SCORECARD_WRITE]: 'Submit councillor performance scorecards',
  [Perm.RATING_SCORECARD_READ]: 'View councillor performance scorecards',
  [Perm.RATING_ACKNOWLEDGE]: 'Acknowledge councillor performance scorecards',
  [Perm.PLATFORM_READ]: 'View platform operations (server, crons, live status)',
  [Perm.ANALYTICS_READ]: 'View first-party website and app analytics',
  [Perm.CONTENT_MANAGE]: 'Edit website content blocks',
};

/** Preserve an unknown permission's full identifier so its subject is not lost. */
export function permissionLabel(permission: string): string {
  return Object.prototype.hasOwnProperty.call(PERMISSION_LABELS, permission)
    ? PERMISSION_LABELS[permission as PermName]
    : permission;
}

/** What this signed-in user is allowed to do in the engagement layer. */
export interface Caps {
  pii: boolean;
  /**
   * Read the member directory. Gates the Members bottom tab itself, the
   * "Party ID cards & QR" shortcut into it, and the member-derived tiles on the
   * home screen — for a role without it, `GET /members` is a guaranteed 403, so
   * the surfaces that depend on it must not render at all rather than render
   * empty. Distinct from `memberWrite`: a ward councillor reads the directory
   * and cannot add to it.
   */
  memberRead: boolean;
  memberWrite: boolean;
  /**
   * Read the geo layers (`/api/geo/*`). Gates the Map bottom tab itself and
   * every `open('map')` deep link: for a role without it the map's only possible
   * content is a 403, which renders as an empty pane with an error banner — the
   * exact failure the Members tab was gated on. Member GPS points are personal
   * information about identifiable people, so this is deliberately narrower than
   * "everyone may see a map": ward-level aggregates for residents are already
   * published anonymously by the transparency module and the public site.
   */
  geoRead: boolean;
  /**
   * Read ONLY the caller's own ward on the map (`geo:read_own_ward`, Wave 4).
   * Members hold this instead of `geoRead`; it opens the Map tab in RESTRICTED
   * mode — their subcouncil → their ward → the councillor bio and the ward's
   * non-private case heat — with no member points, choropleth, tier analytics or
   * municipality/region drill. Never true for a role that already has `geoRead`.
   */
  geoReadOwn: boolean;
  /**
   * Derived: the Map tab is reachable at all — `geoRead || geoReadOwn`. Gates the
   * tab, its mount and every `open('map')` deep link, so a member (who lacks
   * `geoRead`) still gets the restricted map while a role holding neither sees no
   * tab. Not in `CAPS_PERMISSION` because it is a disjunction, not one permission.
   */
  memberMap: boolean;
  eventWrite: boolean;
  postWrite: boolean;
  moderate: boolean;
  appoint: boolean;
  notify: boolean;
  caseLog: boolean;
  caseUpdate: boolean;
  bulletinWrite: boolean;
  patrolWrite: boolean;
  participationWrite: boolean;
  verifyWrite: boolean;
  overviewRead: boolean;
  /**
   * Submit a report to the ward councillor (resident-report / report-to-
   * councillor surface). Backed by `report:write`, which the `reports` module
   * owns — so switching that module off strips the permission and this flag
   * flips false, hiding the submit button without any per-component change.
   */
  report: boolean;
  /** PRD-jobs: member may register their own job interest. */
  jobInterest: boolean;
  /** PRD-jobs: staff/analyst may read aggregate ward work-demand. */
  jobDemand: boolean;
  /** PRD-jobs: councillor/staff may post & publish opportunities. */
  jobOpportunity: boolean;
}

/**
 * Capability → the permission that authorises it. Every entry is a claim of the
 * form "the UI shows this control exactly when the server holds this
 * permission", which is what `caps:check` and the role×endpoint matrix both
 * verify.
 *
 * `moderate` maps to POST_MODERATE, *not* MODERATE_USERS. Its only consumers
 * are the newsroom (`listPosts({ status: 'all' })` and the take-down action),
 * which is content moderation. The member ban/suspend ladder is a separate
 * permission and lives behind the CRM's Moderation screen, not behind a `Caps`
 * flag. Getting this wrong reads plausibly — the earlier validation plan did —
 * and would have stripped content moderation from `regional_organizer`, who
 * genuinely holds it.
 */
const CAPS_PERMISSION: { [K in Exclude<keyof Caps, 'memberMap'>]: PermName } = {
  pii: Perm.PII_DECRYPT,
  memberRead: Perm.MEMBER_READ,
  memberWrite: Perm.MEMBER_WRITE,
  geoRead: Perm.GEO_READ,
  geoReadOwn: Perm.GEO_READ_OWN_WARD,
  eventWrite: Perm.EVENT_WRITE,
  postWrite: Perm.POST_WRITE,
  moderate: Perm.POST_MODERATE,
  appoint: Perm.APPOINT_WRITE,
  notify: Perm.NOTIFY_WRITE,
  caseLog: Perm.CASE_LOG,
  caseUpdate: Perm.CASE_UPDATE,
  bulletinWrite: Perm.BULLETIN_WRITE,
  patrolWrite: Perm.PATROL_WRITE,
  participationWrite: Perm.PARTICIPATION_WRITE,
  verifyWrite: Perm.VERIFY_WRITE,
  overviewRead: Perm.OVERVIEW_READ,
  report: Perm.REPORT_WRITE,
  jobInterest: Perm.JOBS_INTEREST_WRITE,
  jobDemand: Perm.JOBS_DEMAND_READ,
  jobOpportunity: Perm.JOBS_OPPORTUNITY_WRITE,
};

/**
 * Build the capability flags from a permission list the server sent.
 *
 * Fail-closed on every uncertain input: an absent, malformed or unknown list
 * yields no capabilities, because the alternative is offering controls the
 * server will refuse. `tokenStore.permissions` distinguishes "never stored"
 * (null) from "server said none" ([]); `ensurePermissions()` resolves the
 * former with one refresh so a pre-existing session is not failed closed.
 */
export function deriveCaps(permissions: readonly Permission[] | null | undefined): Caps {
  const held = new Set(permissions ?? []);
  const caps = {} as Caps;
  for (const key of Object.keys(CAPS_PERMISSION) as (Exclude<keyof Caps, 'memberMap'>)[]) {
    caps[key] = held.has(CAPS_PERMISSION[key]);
  }
  // The one derived capability: the Map tab opens for a staff role (full
  // `geo:read`) OR a member (ward-scoped `geo:read_own_ward`). Computed here
  // rather than in CAPS_PERMISSION because it is a disjunction of two
  // permissions, not a single one.
  caps.memberMap = caps.geoRead || caps.geoReadOwn;
  return caps;
}

/** Every capability denied — the anonymous and the not-yet-loaded session. */
export const NO_CAPS: Caps = deriveCaps([]);

/**
 * Does this session hold `permission`? For surfaces richer than `Caps` — the
 * desktop CRM's navigation, which gates on audit/role/moderation permissions
 * that have no engagement-layer capability flag.
 */
export function can(
  permissions: readonly Permission[] | null | undefined,
  permission: PermName,
): boolean {
  return (permissions ?? []).includes(permission);
}
