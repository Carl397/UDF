import type {
  ReportFilters, ReportStats, ReportAccountability, ReportFilterOptions,
  ReportTask, ReportTaskFilters, ReportTaskInput, ReportAssignee,
  AcknowledgeScorecardInput,
  Appointment,
  AppNotification,
  Attachment,
  ApplyModerationActionInput,
  ApplyModerationActionResult,
  BannedDevice,
  BatchCardsResult,
  CardDesign,
  CardDesignView,
  CardPhoto,
  CaseStats,
  CrmDashboard,
  WardSummary,
  ScorecardFilters,
  ScorecardPageFilters,
  ConfirmResult,
  EventAttendee,
  CreateJobOpportunityInput,
  CreateResidentReportInput,
  CreateResidentReportResult,
  GeoFeatureCollection,
  HeatmapPoint,
  InviteView,
  JobDemand,
  JobInterest,
  JobOpportunity,
  JobPublicCount,
  JobsAdminConfig,
  JobsFlags,
  LineageView,
  LoginResponse,
  Manifesto,
  Member,
  MemberListResponse,
  Milestone,
  ModerationProfile,
  ModerationUser,
  ModuleRegistry,
  MyWard,
  Participation,
  PartyCard,
  PartyEvent,
  Patrol,
  Permission,
  Petition,
  PhotoTransform,
  Position,
  Post,
  Project,
  PublicMeta,
  Rating,
  RefreshResponse,
  RegionSummary,
  RegisterResult,
  ReportView,
  ResidentReport,
    ReportActionInput,
    MediaPolicy,
  ScorecardCategories,
  ScorecardCurrent,
  ScorecardHistory,
  ScorecardInbox,
  ScorecardLowReasons,
  ScorecardSummary,
  ScorecardView,
  ServiceRequest,
  SubmitScorecardInput,
  Terms,
  TreeView,
  UpdateJobsConfigInput,
  UpsertJobInterestInput,
  UpsertWorkTypeInput,
  Verification,
  VerifyCard,
  WardBulletin,
  WardCandidate,
  WardCandidateInput,
  WardDetail,
  WardChangeStatus,
  WardLookupResult,
  WardOverview,
  WorkType,
  WorkTypeAdmin,
} from '../types';

/**
 * Browser API client.
 *
 * Tokens are kept in memory (and mirrored to localStorage for dev convenience).
 * PRODUCTION NOTE: prefer httpOnly, Secure, SameSite=strict cookies set by the
 * backend over localStorage to eliminate XSS token theft. The swap is isolated
 * to `tokenStore` + the Authorization header below.
 */

/** Base path for API calls — also used for public download links (vCard). */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '/api';

export const tokenStore = {
  get access(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem('access_token');
  },
  get refresh(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem('refresh_token');
  },
  /**
   * The address this browser signed in with.
   *
   * A refreshed access token deliberately carries no `email` claim — staff
   * emails are sealed PII server-side and re-decrypting one on every refresh
   * would put a hash-chained audit write on the auth hot path. Keeping the
   * address here lets the UI still show who is signed in after a silent
   * refresh. It is no new exposure: the login token in this same store already
   * contained it.
   */
  get email(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem('session_email');
  },
  /**
   * Terms & Conditions state, mirrored from the login response so the T&C gate
   * survives a reload (the JWT itself carries no T&C claim). `accepted` is the
   * version the user accepted; `current` is the server's latest at last login.
   * The gate is satisfied when the two match.
   */
  get tcAcceptedVersion(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem('tc_accepted_version');
  },
  get tcCurrentVersion(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem('tc_current_version');
  },
  /**
   * First-login password-change gate, mirrored from the login response (the JWT
   * carries no such claim) so it survives a reload. Cleared by changePassword().
   */
  get mustChangePassword(): boolean {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('must_change_password') === '1';
  },
  /**
   * The caller's effective permissions, mirrored from the login/refresh
   * response. The JWT stays small on purpose (role + region scope), so this
   * follows the same convention as T&C state and `mustChangePassword` above:
   * computed server-side at the session boundary, mirrored here, re-derived on
   * every rotation. `lib/caps.ts` turns it into the UI's capability flags.
   *
   * `null` means "no list has ever been stored" — a session that predates the
   * server sending one. That is deliberately distinct from `[]`, which means
   * the server said this role can do nothing. Conflating them would fail a
   * valid session closed for up to fifteen minutes; `ensurePermissions()`
   * resolves `null` with one refresh instead.
   */
  get permissions(): Permission[] | null {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem('session_permissions');
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return parsed.filter((p): p is Permission => typeof p === 'string');
    } catch {
      return null;
    }
  },
  /**
   * The module keys enabled for the caller's role, mirrored from the
   * login/refresh response exactly like `permissions` above. Permission-backed
   * modules are already enforced through `permissions` (a disabled module's
   * permissions are stripped server-side); this list is for the UI-only surfaces
   * that own no permission (`id_cards`) and for an explicit "module disabled"
   * empty-state — see `lib/modules.ts`.
   *
   * `null` (never stored) is distinct from `[]` (server said no modules) for the
   * same fail-closed reason as `permissions`; `ensureModules()` heals a
   * pre-existing session with one refresh.
   */
  get modules(): string[] | null {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem('session_modules');
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return parsed.filter((m): m is string => typeof m === 'string');
    } catch {
      return null;
    }
  },
  set(access: string, refresh: string, email?: string | null) {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('access_token', access);
    window.localStorage.setItem('refresh_token', refresh);
    // Only login supplies an email; a refresh must not wipe the stored one.
    if (email) window.localStorage.setItem('session_email', email);
  },
  setTc(acceptedVersion: string | null, currentVersion: string | null) {
    if (typeof window === 'undefined') return;
    if (acceptedVersion) window.localStorage.setItem('tc_accepted_version', acceptedVersion);
    else window.localStorage.removeItem('tc_accepted_version');
    if (currentVersion) window.localStorage.setItem('tc_current_version', currentVersion);
  },
  setMustChangePassword(value: boolean) {
    if (typeof window === 'undefined') return;
    if (value) window.localStorage.setItem('must_change_password', '1');
    else window.localStorage.removeItem('must_change_password');
  },
  /**
   * Adopt a permission list from a login/refresh/change-password response.
   *
   * A response that omits the list leaves the stored one untouched, for the
   * same reason `set()` guards `email`: an older server (or a partially
   * applied deploy) must not silently strip a working session's capabilities.
   * `clear()` is what removes it.
   */
  setPermissions(permissions: Permission[] | null | undefined) {
    if (typeof window === 'undefined') return;
    if (Array.isArray(permissions)) {
      window.localStorage.setItem('session_permissions', JSON.stringify(permissions));
    }
  },
  /**
   * Adopt an enabled-module list from a login/refresh/change-password response.
   * Mirrors `setPermissions`: a response that omits the list leaves the stored
   * one untouched, so an older server or a partial deploy cannot silently strip
   * a working session's UI-only surfaces. `clear()` is what removes it.
   */
  setModules(modules: string[] | null | undefined) {
    if (typeof window === 'undefined') return;
    if (Array.isArray(modules)) {
      window.localStorage.setItem('session_modules', JSON.stringify(modules));
    }
  },
  clear() {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem('access_token');
    window.localStorage.removeItem('refresh_token');
    window.localStorage.removeItem('session_email');
    window.localStorage.removeItem('tc_accepted_version');
    window.localStorage.removeItem('tc_current_version');
    window.localStorage.removeItem('must_change_password');
    window.localStorage.removeItem('session_permissions');
    window.localStorage.removeItem('session_modules');
  },
};

/** Fixed public copy only: older servers and proxies may return internal details. */
export function apiErrorMessage(status: number, code: string): string {
  if (status === 0) return code === 'request_cancelled'
    ? 'The request was canceled. Please try again.'
    : 'Unable to connect. Please check your connection and try again.';
  if (code === 'invalid_response') return 'Something went wrong. Please try again later.';
  const messages: Record<string, readonly [number, string]> = {
    device_banned: [403, 'This device cannot access this service. Please contact support.'],
    account_banned: [403, 'This account is no longer active. Please contact support.'],
    account_suspended: [403, 'This account is temporarily suspended. Please contact support.'],
    invalid_current_password: [400, 'Your current password is incorrect. Please try again.'],
    password_reused: [400, 'Choose a different new password.'],
    module_lockout: [400, 'This feature must stay enabled to keep administrator access available.'],
    unknown_module: [400, 'This feature is unavailable. Please refresh and try again.'],
    duplicate_page_section: [400, 'A page cannot include the same content block twice.'],
    ward_profile_unavailable: [403, 'Your registered ward is unavailable. Please contact support.'],
    ward_members_only: [403, 'Registered ward settings are available to members only.'],
    ward_change_stale: [409, 'Your registered ward has changed. Please reload it before trying again.'],
    ward_change_limit: [409, 'You have used all 3 ward changes. Your registered ward cannot be changed again.'],
    invalid_ward: [400, 'Please choose a valid ward and try again.'],
  };
  const known = Object.prototype.hasOwnProperty.call(messages, code) ? messages[code] : undefined;
  if (known && known[0] === status) return known[1];
  switch (status) {
    case 400: case 422: return 'Please check your information and try again.';
    case 401: return 'Please sign in again and try again.';
    case 403: return 'You do not have access to this action.';
    case 404: return 'This service or item is currently unavailable. Please try again later.';
    case 408: case 504: return 'This is taking longer than expected. Please try again.';
    case 409: return 'This change could not be completed. Please refresh and try again.';
    case 413: return 'This file or request is too large. Please reduce its size and try again.';
    case 429: return 'Please wait a moment before trying again.';
    default: return 'Something went wrong. Please try again later.';
  }
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(apiErrorMessage(status, code));
    this.name = code === 'request_cancelled' ? 'AbortError' : 'ApiClientError';
  }
}

/** A read failure is never a successful empty result; only sanitized copy travels. */
export function dataReadError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 403) return 'Access denied. This data is not available to your account.';
    if (error.status === 401) return 'Session expired. Please sign in again, then retry.';
    if (error.code === 'invalid_response') return 'Data unavailable. The server returned an incompatible response. Please retry later.';
    return `Data unavailable. ${error.message}`;
  }
  return 'Data unavailable. Please try again.';
}

function transportError(error: unknown, signal?: AbortSignal | null): ApiClientError {
  return new ApiClientError(0, signal?.aborted || (error instanceof Error && error.name === 'AbortError')
    ? 'request_cancelled' : 'network_error');
}

async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try { return await fetch(url, init); }
  catch (error) { throw transportError(error, init.signal); }
}

async function safeBlob(response: Response, signal?: AbortSignal): Promise<Blob> {
  try { return await response.blob(); }
  catch (error) { throw transportError(error, signal); }
}

function validateWardStatus(value: WardChangeStatus): void {
  const nullableText = (v: unknown) => v === null || typeof v === 'string';
  if (!value || !nullableText(value.wardCode) || !nullableText(value.wardName) || !nullableText(value.regionCode) ||
      value.maxChanges !== 3 || !Number.isInteger(value.changesUsed) || value.changesUsed < 0 ||
      value.changesRemaining !== Math.max(0, value.maxChanges - value.changesUsed)) {
    throw new ApiClientError(200, 'invalid_response');
  }
}

// Required display contracts are checked before a successful read reaches the UI.
function dtoCheck(valid: unknown): asserts valid {
  if (!valid) throw new ApiClientError(200, 'invalid_response');
}
function dtoRecord(value: unknown): Record<string, unknown> {
  dtoCheck(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function dtoArray(value: unknown): unknown[] { dtoCheck(Array.isArray(value)); return value; }
const dtoText = (v: unknown): v is string => typeof v === 'string';
const dtoNullableText = (v: unknown) => v === null || dtoText(v);
const dtoCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const dtoScore = (v: unknown): v is number => dtoCount(v) && v >= 1 && v <= 5;
const dtoMean = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 5);
const dtoStatus = (v: unknown) => v === 'submitted' || v === 'viewed' || v === 'acknowledged';
const dtoMonth = (v: unknown): v is string => dtoText(v) && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(v);
const dtoPeriod = (v: unknown) => dtoText(v) && v.endsWith('-01') && dtoMonth(v.slice(0, -3));
const dtoTimestamp = (v: unknown) => dtoText(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
function validateScoreItems(value: unknown) {
  for (const item of dtoArray(value)) {
    const i = dtoRecord(item);
    dtoCheck(dtoText(i.category) && dtoScore(i.score) && dtoNullableText(i.reason));
  }
}
function validateScorecardView(value: unknown) {
  const v = dtoRecord(value);
  dtoCheck(dtoText(v.id) && dtoPeriod(v.period) && dtoStatus(v.status) && dtoText(v.wardCode) &&
    typeof v.shareName === 'boolean' && dtoNullableText(v.ackNote) && dtoNullableText(v.ackAt));
  validateScoreItems(v.items);
}
function validateCurrentScorecard(value: unknown) {
  const v = dtoRecord(value);
  dtoCheck(typeof v.eligible === 'boolean' && typeof v.frozen === 'boolean' && typeof v.shareName === 'boolean' &&
    dtoPeriod(v.period) && (v.status === 'not_rated' || dtoStatus(v.status)) &&
    v.frozen === (v.status === 'acknowledged') && dtoNullableText(v.ward) &&
    dtoNullableText(v.message) && dtoNullableText(v.ackNote) && dtoNullableText(v.scorecardId));
  if (v.councillor !== null) {
    const c = dtoRecord(v.councillor); dtoCheck(dtoText(c.fullName) && dtoText(c.memberId));
  }
  const categories = dtoArray(v.categories);
  for (const category of categories) {
    const c = dtoRecord(category); dtoCheck(dtoText(c.code) && dtoText(c.label) && Number.isInteger(c.position));
  }
  dtoCheck(!v.eligible || v.councillor !== null);
  validateScoreItems(v.items);
}
function scorecardQuery(params: ScorecardPageFilters): ScorecardPageFilters {
  const query = { ...params, ward: params.ward?.trim(), period: params.period?.trim() };
  if ((query.period !== undefined && !dtoMonth(query.period)) ||
      (query.ward !== undefined && (!query.ward || query.ward.length > 32)) ||
      (query.status !== undefined && !dtoStatus(query.status)) ||
      (query.limit !== undefined && (!dtoCount(query.limit) || query.limit < 1 || query.limit > 200)) ||
      (query.offset !== undefined && !dtoCount(query.offset))) throw new ApiClientError(400, 'bad_request');
  return query;
}
function validateScorecardRollup(value: unknown, q: ScorecardPageFilters, kind: 'summary' | 'inbox' | 'reasons') {
  const v = dtoRecord(value);
  dtoCheck(dtoPeriod(v.period) && dtoTimestamp(v.asOf) && (v.scope === 'ward' || v.scope === 'region' || v.scope === 'national') &&
    v.statusFilter === (q.status ?? null) && v.wardFilter === (q.ward ?? null) &&
    (!q.period || v.period === `${q.period}-01`));
  if (kind === 'summary') {
    dtoCheck(dtoCount(v.scorecards) && dtoCount(v.itemCount) && dtoCount(v.lowScoreItems) &&
      dtoCount(v.lowScorecards) && dtoCount(v.awaitingAcknowledgement) && dtoMean(v.overallAverage));
    dtoCheck((v.itemCount === 0) === (v.overallAverage === null) && v.lowScoreItems <= v.itemCount &&
      v.lowScorecards <= v.scorecards && v.awaitingAcknowledgement <= v.scorecards &&
      (q.status !== 'acknowledged' || v.awaitingAcknowledgement === 0));
    for (const category of dtoArray(v.categories)) {
      const c = dtoRecord(category); const dist = dtoRecord(c.distribution);
      dtoCheck(dtoText(c.category) && dtoText(c.label) && Number.isInteger(c.position) && typeof c.active === 'boolean' &&
        dtoCount(c.count) && dtoCount(c.lowCount) && dtoMean(c.average) && (c.count === 0) === (c.average === null));
      for (const key of ['1', '2', '3', '4', '5']) dtoCheck(dtoCount(dist[key]));
      dtoCheck(['1', '2', '3', '4', '5'].reduce((sum, key) => sum + Number(dist[key]), 0) === c.count &&
        Number(dist['1']) + Number(dist['2']) === c.lowCount);
    }
    return;
  }
  const rows = dtoArray(v.rows);
  dtoCheck(dtoCount(v.total) && dtoCount(v.limit) && v.limit >= 1 && v.limit <= 200 &&
    v.limit === (q.limit ?? 100) && v.offset === (q.offset ?? 0) && dtoCount(v.offset) &&
    typeof v.hasMore === 'boolean' && rows.length === Math.min(v.limit, Math.max(0, v.total - v.offset)) &&
    v.hasMore === (v.offset + rows.length < v.total));
  for (const row of rows) {
    const r = dtoRecord(row);
    dtoCheck(dtoText(r.wardCode) && dtoNullableText(r.wardName) && r.period === v.period && dtoStatus(r.status) &&
      (!q.status || r.status === q.status) && (!q.ward || r.wardCode === q.ward) &&
      typeof r.shareName === 'boolean' && dtoNullableText(r.memberPublicCode) && (r.shareName || r.memberPublicCode === null));
    if (kind === 'inbox') {
      dtoCheck(dtoText(r.id) && dtoMean(r.average) && dtoCount(r.lowCount) && dtoText(r.submittedAt));
      validateScoreItems(r.items);
    } else {
      dtoCheck(dtoText(r.scorecardId) && dtoText(r.category) && dtoText(r.label) && dtoScore(r.score) && r.score <= 2 && dtoNullableText(r.reason));
    }
  }
}
function validateCaseMetrics(value: unknown) {
  const v = dtoRecord(value);
  dtoCheck(dtoCount(v.total) && dtoCount(v.open) && dtoCount(v.resolved) && dtoCount(v.slaBreached) &&
    v.open + v.resolved === v.total && v.slaBreached <= v.open);
  dtoCheck(v.total === 0 ? v.resolutionRatePct === null : typeof v.resolutionRatePct === 'number' &&
    Number.isFinite(v.resolutionRatePct) && v.resolutionRatePct >= 0 && v.resolutionRatePct <= 100);
}
function validateBreakdown(value: unknown) {
  for (const row of dtoArray(value)) { const r = dtoRecord(row); dtoCheck(dtoText(r.label) && dtoCount(r.value)); }
}
function validateDashboardPerformance(value: unknown) {
  const v = dtoRecord(value); const activity = dtoRecord(v.activity); const modules = dtoRecord(activity.modules);
  dtoCheck(dtoTimestamp(activity.asOf) && dtoCount(activity.periodDays));
  if (modules.cases === null) return;
  const cases = dtoRecord(modules.cases); const p = dtoRecord(cases.performance);
  dtoCheck(dtoTimestamp(p.asOf)); validateCaseMetrics(p.totals);
  validateBreakdown(p.byStatus); validateBreakdown(p.byCategory); validateBreakdown(cases.dailyCreated);
  for (const row of dtoArray(p.byWard)) { validateCaseMetrics(row); dtoCheck(dtoNullableText(dtoRecord(row).wardCode)); }
}
function validateWardSummary(value: unknown, ward?: string) {
  const v = dtoRecord(value); const rows = dtoArray(v.rows);
  dtoCheck(dtoTimestamp(v.asOf) && v.wardFilter === (ward ?? null) && dtoCount(v.total) && v.total === rows.length);
  const codes = new Set<string>();
  for (const row of rows) {
    const r = dtoRecord(row);
    dtoCheck(dtoText(r.code) && dtoText(r.name) && dtoCount(r.members) && typeof r.candidateRecorded === 'boolean' &&
      (!ward || r.code === ward) && !codes.has(r.code));
    codes.add(r.code);
    if (r.cases !== null) validateCaseMetrics(r.cases);
    if (r.councillor !== null) dtoCheck(dtoText(dtoRecord(r.councillor).fullName));
  }
}
function validateList(value: unknown, kind: 'ratings' | 'verifications' | 'cases' | 'escalations') {
  const v = dtoRecord(value); const items = dtoArray(v.items);
  dtoCheck(dtoCount(v.total) && items.length <= v.total);
  for (const item of items) {
    const i = dtoRecord(item); dtoCheck(dtoText(i.id) && dtoText(i.createdAt));
    if (kind === 'ratings') dtoCheck(dtoScore(i.rating) && dtoText(i.targetId) && dtoText(i.targetType) && dtoNullableText(i.reason));
    else if (kind === 'verifications') dtoCheck(dtoText(i.memberId) && dtoText(i.serviceRequestId) &&
      dtoText(i.verdict) && ['fixed', 'not_fixed', 'partial'].includes(i.verdict) && dtoNullableText(i.note));
    else {
      dtoCheck(dtoText(i.status) && dtoText(i.category) && dtoNullableText(i.wardCode));
      if (kind === 'escalations') dtoCheck(dtoText(i.escalationReason) && ['sla_breach', 'stuck', 'overdue'].includes(i.escalationReason));
    }
  }
}

// ── Device identity ──────────────────────────────────────────────
// The stable per-install device id is sent as `x-device-id` so the backend can
// enforce device bans on login/refresh/register. Resolved once and cached; the
// dynamic import keeps Capacitor out of the SSR/web bundle.
let deviceIdCache: string | null | undefined;

async function resolveDeviceId(): Promise<string | null> {
  if (deviceIdCache !== undefined) return deviceIdCache;
  try {
    const { getDeviceId } = await import('./device');
    deviceIdCache = await getDeviceId();
  } catch {
    deviceIdCache = null;
  }
  return deviceIdCache;
}

// ── Session keep-alive ───────────────────────────────────────────
// Access tokens live 15 minutes, refresh tokens 7 days. Without a silent
// refresh an organiser is logged out mid-shift: the shell still says "welcome
// back" while every request 401s.

type SessionListener = (accessToken: string | null) => void;
const sessionListeners = new Set<SessionListener>();

/**
 * Subscribe to session changes. A silent refresh hands back the new access
 * token; a refused refresh hands back `null`, meaning the session is over.
 * Returns an unsubscribe function.
 *
 * The role, email and region scope are claims inside the access token, so the
 * auth provider must re-derive them on every change — otherwise the shell keeps
 * enforcing the capabilities of a token that has already been replaced.
 */
export function onSessionChange(listener: SessionListener): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

function emitSession(accessToken: string | null): void {
  for (const listener of sessionListeners) listener(accessToken);
}

/**
 * Refreshes the access token, at most one call in flight at a time.
 *
 * The Home tab fires five requests at once, and refresh tokens rotate — so
 * letting each caller refresh independently would invalidate all but the first.
 * Every concurrent caller awaits the same promise instead.
 */
let refreshInFlight: Promise<string | null> | null = null;

function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= (async () => {
    const refresh = tokenStore.refresh;
    if (!refresh) return null;
    try {
      const deviceId = await resolveDeviceId();
      const res = await safeFetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(deviceId ? { 'x-device-id': deviceId } : {}),
        },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      if (!res.ok) {
        // The refresh token is gone, expired or was reused — the session is over.
        tokenStore.clear();
        emitSession(null);
        return null;
      }
      const tokens = (await res.json()) as RefreshResponse;
      tokenStore.set(tokens.accessToken, tokens.refreshToken);
      // Stored before the listeners fire, so a shell re-deriving its capability
      // flags inside `onSessionChange` reads the new list and not the one from
      // the previous rotation.
      tokenStore.setPermissions(tokens.permissions);
      tokenStore.setModules(tokens.enabledModules);
      emitSession(tokens.accessToken);
      return tokens.accessToken;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * Make sure this session has a permission list, fetching one if it does not.
 *
 * Only sessions that were signed in before the server started sending
 * permissions have none stored, and they heal themselves here with a single
 * refresh rather than being failed closed until their access token happens to
 * lapse. Returns the list, or `null` when there is no session to ask about.
 */
export function ensurePermissions(): Promise<Permission[] | null> {
  const stored = tokenStore.permissions;
  if (stored !== null) return Promise.resolve(stored);
  if (!tokenStore.refresh) return Promise.resolve(null);
  return refreshAccessToken().then((accessToken) =>
    accessToken ? tokenStore.permissions : null,
  );
}

/**
 * Make sure this session has an enabled-module list, fetching one if it does
 * not — the module mirror of `ensurePermissions`, for the same reason: only a
 * session signed in before the server started sending `enabledModules` has none
 * stored, and it heals itself here with a single refresh rather than being
 * failed closed (no UI-only modules) until its access token lapses. Returns the
 * list, or `null` when there is no session to ask about.
 */
export function ensureModules(): Promise<string[] | null> {
  const stored = tokenStore.modules;
  if (stored !== null) return Promise.resolve(stored);
  if (!tokenStore.refresh) return Promise.resolve(null);
  return refreshAccessToken().then((accessToken) =>
    accessToken ? tokenStore.modules : null,
  );
}

async function request<T>(path: string, init: RequestInit = {}, canRetry = true): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  const token = tokenStore.access;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const deviceId = await resolveDeviceId();
  if (deviceId) headers.set('x-device-id', deviceId);

  const res = await safeFetch(`${API_BASE}${path}`, { ...init, headers });

  // Replay once with a fresh token. The credential endpoints are excluded so a
  // failed login (401) cannot trigger a refresh loop; authenticated auth
  // endpoints (change-password, terms/accept) MAY refresh, so an access token
  // that expired while the user sat on a gate does not strand them there.
  const isCredentialEndpoint =
    path.startsWith('/auth/login') ||
    path.startsWith('/auth/refresh') ||
    path.startsWith('/auth/logout');
  if (res.status === 401 && canRetry && token && !isCredentialEndpoint) {
    const fresh = await refreshAccessToken();
    if (fresh) return request<T>(path, init, false);
  }

  if (res.status === 204) return undefined as T;

  let body;
  try { body = await res.json(); }
  catch (error) {
    if (init.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw transportError(error, init.signal);
    throw new ApiClientError(res.status, res.ok ? 'invalid_response' : 'error');
  }
  if (!res.ok) {
    const code = body?.error?.code;
    throw new ApiClientError(res.status, typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'error');
  }
  if (body?.error) throw new ApiClientError(res.status, 'invalid_response');
  return body as T;
}

function qs(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

/**
 * The mobile `/api/service-requests` route returns raw `SELECT *` rows, i.e.
 * snake_case (`ref_no`, `ward_code`, `follow_up_state`, …), while the whole
 * frontend — and the CRM's own `srToView` mapper — speak the camelCase
 * `ServiceRequest` DTO. Normalise the wire row here so every consumer reads one
 * shape. Each field falls back through camel → snake so this stays correct if
 * the backend ever maps server-side too.
 */
function normalizeServiceRequest(r: any): ServiceRequest {
  return {
    id: r.id,
    refNo: r.refNo ?? r.ref_no,
    category: r.category,
    severity: r.severity,
    title: r.title,
    description: r.description ?? null,
    status: r.status,
    followUpState: r.followUpState ?? r.follow_up_state ?? 'none',
    wardCode: r.wardCode ?? r.ward_code ?? null,
    streetNumber: r.streetNumber ?? r.street_number ?? null,
    streetAddress: r.streetAddress ?? r.street_address ?? null,
    municipalityRef: r.municipalityRef ?? r.municipality_ref ?? null,
    reporterMemberId: r.reporterMemberId ?? r.reporter_member_id ?? null,
    councillorMemberId: r.councillorMemberId ?? r.councillor_member_id ?? null,
    slaDueAt: r.slaDueAt ?? r.sla_due_at ?? null,
    reportCount: r.reportCount ?? r.report_count ?? 0,
    resolvedAt: r.resolvedAt ?? r.resolved_at ?? null,
    verifiedAt: r.verifiedAt ?? r.verified_at ?? null,
    closedAt: r.closedAt ?? r.closed_at ?? null,
    createdAt: r.createdAt ?? r.created_at,
    updatedAt: r.updatedAt ?? r.updated_at,
  };
}

// ── SuperAdmin operations surface (analytics / platform / content) ─────────
// Wire shapes mirror the backend getters under
// `backend/src/modules/{analytics,platform,content}`. Kept local to the client
// because they are read-model DTOs consumed only by the Platform screens.

export interface AnalyticsWindow {
  pageviews: number;
  visitors: number;
  sessions: number;
  durationMs: number;
}
export interface AnalyticsOverview {
  windowDays: number;
  timezone: string;
  current: AnalyticsWindow;
  previous: AnalyticsWindow;
  deltas: { pageviews: number | null; visitors: number | null; sessions: number | null };
  avgPageviewsPerSession: number | null;
  bySite: Array<{ site: string; pageviews: number; visitors: number }>;
  daily: Array<{ day: string; pageviews: number; visitors: number }>;
}
export interface AnalyticsTraffic {
  windowDays: number;
  daily: Array<{ day: string; pageviews: number; visitors: number }>;
  topPages: Array<{ path: string; views: number; visitors: number }>;
  referrers: Array<{ host: string; views: number }>;
  utm: Array<{ source: string; medium: string; campaign: string; views: number }>;
}
export interface AnalyticsDevices {
  windowDays: number;
  deviceType: Array<{ key: string; views: number; visitors: number }>;
  os: Array<{ key: string; views: number; visitors: number }>;
  browser: Array<{ key: string; views: number; visitors: number }>;
  lang: Array<{ key: string; views: number; visitors: number }>;
  screen: Array<{ key: string; views: number; visitors: number }>;
}
export interface AnalyticsRealtime {
  computedAt: string;
  windowMinutes: number;
  visitorsNow: number;
  pageviewsNow: number;
  bySite: Array<{ site: string; visitors: number }>;
  topPaths: Array<{ path: string; visitors: number }>;
}
export interface AnalyticsDownloads {
  windowDays: number;
  total: number;
  uniqueIps: number;
  daily: Array<{ day: string; downloads: number }>;
  breakdowns: Record<string, Array<{ key: string; n: number }>>;
}

export interface ServerStatus {
  collectedAt: string;
  node: { version: string; uptimeSec: number; pid: number };
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  eventLoopLagMs: number;
  db: {
    reachable: boolean;
    latencyMs: number | null;
    pool: { total: number; idle: number; waiting: number };
  };
  disk: { freeMb: number | null; totalMb: number | null };
  schema: { head: string | null };
  externalServices: { status: 'notIntrospected'; note: string };
}
export interface LiveSnapshot {
  windowMinutes: number;
  liveUsers: number;
  liveSessions: number;
  byRole: Array<{ role: string; users: number }>;
  byDevice: Array<{ device: string; sessions: number }>;
  computedAt: string;
}
export interface JobHealth {
  jobName: string;
  lastStatus: string;
  lastStartedAt: string;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  secondsSinceLastSuccess: number | null;
  successRatePct: number | null;
  recentRuns: number;
}
export interface JobRun {
  jobName: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  detail: unknown;
}
export interface PlatformJobs {
  health: JobHealth[];
  recent: JobRun[];
}
export interface PlatformSnapshot {
  at: string;
  server: ServerStatus;
  live: LiveSnapshot;
  jobs: JobHealth[];
  realtime: AnalyticsRealtime;
}

export type ContentBlockKind = 'fields' | 'slider' | 'section';
export interface ContentBlockSummary {
  key: string;
  site: 'marketing' | 'app' | 'shared';
  title: string;
  kind: ContentBlockKind;
  version: number;
  updatedAt: string;
  publishedAt: string | null;
  hasPublished: boolean;
  hasUnpublishedChanges: boolean;
}
export interface ContentBlockFull {
  key: string;
  site: 'marketing' | 'app' | 'shared';
  title: string;
  kind: ContentBlockKind;
  schema: unknown;
  draft: unknown;
  published: unknown;
  version: number;
  updatedAt: string;
  publishedAt: string | null;
}
export interface ContentVersion {
  version: number;
  createdAt: string;
  publishedBy: string | null;
}

// CMS pages: an ordered list of block references (sections) per surface.
export interface PageSectionRef {
  blockKey: string;
}
export interface ContentPageSummary {
  slug: string;
  site: 'marketing' | 'app';
  title: string;
  version: number;
  isActive: boolean;
  updatedAt: string;
  publishedAt: string | null;
  sectionCount: number;
  hasPublished: boolean;
  hasUnpublishedChanges: boolean;
}
export interface ContentPageFull {
  slug: string;
  site: 'marketing' | 'app';
  title: string;
  sections: PageSectionRef[];
  publishedSections: PageSectionRef[] | null;
  publishedTitle: string | null;
  version: number;
  isActive: boolean;
  updatedAt: string;
  publishedAt: string | null;
}
/** The public read model: a published page with its sections resolved. */
export interface PublicPage {
  slug: string;
  site: 'marketing' | 'app';
  title: string | null;
  publishedAt: string | null;
  sections: Array<{ key: string; kind: ContentBlockKind; data: unknown }>;
}

// ── Auth ─────────────────────────────────────────────────────────
export const api = {
  appReleases(): Promise<import('./appUpdates').PreparedReleases> {
    return request('/crm/superadmin/app-releases', { cache: 'no-store' });
  },
  publishAppRelease(artifactId: string, notes: string, expectedAnnouncementId: string | null): Promise<{ announcementId: string; changed: boolean }> {
    return request('/crm/superadmin/app-releases/publish', { method: 'POST', body: JSON.stringify({ artifactId, notes, expectedAnnouncementId }) });
  },
  withdrawAppRelease(announcementId: string): Promise<{ changed: boolean }> {
    return request('/crm/superadmin/app-releases/withdraw', { method: 'POST', body: JSON.stringify({ announcementId }) });
  },
  async login(email: string, password: string): Promise<LoginResponse> {
    const res = await request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    tokenStore.set(res.accessToken, res.refreshToken, email);
    tokenStore.setTc(res.tcAccepted ? res.tcCurrentVersion : null, res.tcCurrentVersion);
    tokenStore.setMustChangePassword(res.mustChangePassword);
    tokenStore.setPermissions(res.permissions);
    tokenStore.setModules(res.enabledModules);
    return res;
  },

  /**
   * Change the signed-in user's password (clears the first-login gate). The
   * server rotates the token pair — a password change revokes the old tokens —
   * so adopt the fresh one and re-emit the session. The stored email is left
   * intact (this endpoint, like refresh, re-sends none).
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<LoginResponse> {
    const res = await request<LoginResponse>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    tokenStore.set(res.accessToken, res.refreshToken);
    tokenStore.setTc(res.tcAccepted ? res.tcCurrentVersion : null, res.tcCurrentVersion);
    tokenStore.setMustChangePassword(res.mustChangePassword);
    tokenStore.setPermissions(res.permissions);
    tokenStore.setModules(res.enabledModules);
    emitSession(res.accessToken);
    return res;
  },

  async logout(): Promise<void> {
    const refresh = tokenStore.refresh;
    try {
      await request('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: refresh }),
      });
    } finally {
      tokenStore.clear();
    }
  },

  /** Record acceptance of the current Terms (called from the T&C gate). */
  acceptTerms(): Promise<{ tcVersion: string; tcAcceptedAt: string }> {
    return request('/auth/terms/accept', { method: 'POST' });
  },

  /**
   * Re-send the onboarding sign-in code (OTP) + starter pack to a member's email
   * (FR-P). Used from the login screen when a newly-registered member's code has
   * expired, or when a backfilled account was provisioned without an email. The
   * endpoint is enumeration-safe and rate-limited: it always resolves
   * `accepted: true` with the same human message whether or not the address maps
   * to an account awaiting setup, so this never confirms an email exists.
   */
  resendOtp(email: string): Promise<{ accepted: boolean; message: string }> {
    return request('/auth/otp/resend', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },

  // ── Members ────────────────────────────────────────────────────
  async ownWardChanges(): Promise<WardChangeStatus> {
    const result = await request<WardChangeStatus>('/members/me/ward', { cache: 'no-store' });
    validateWardStatus(result);
    return result;
  },

  async changeOwnWard(wardCode: string, expectedWardCode: string | null): Promise<WardChangeStatus & { changed: boolean }> {
    // Finish an existing rotation before adopting the new ward's access token.
    if (refreshInFlight) await refreshInFlight;
    const result = await request<WardChangeStatus & { changed: boolean; accessToken: string }>('/members/me/ward', {
      method: 'PATCH', body: JSON.stringify({ wardCode, expectedWardCode }),
    });
    validateWardStatus(result);
    if (typeof result.changed !== 'boolean' || typeof result.accessToken !== 'string' || !result.accessToken) {
      throw new ApiClientError(200, 'invalid_response');
    }
    // The request may itself have triggered a 401/refresh. Keep that rotated
    // refresh token, and never attach a delayed response to a different account.
    if (refreshInFlight) await refreshInFlight;
    const session = tokenStore.refresh;
    try {
      const subject = (token: string) => JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).sub;
      if (session && tokenStore.access && subject(tokenStore.access) === subject(result.accessToken)) {
        tokenStore.set(result.accessToken, session);
        emitSession(result.accessToken);
      }
    } catch { /* A missing/malformed local session is never restored here. */ }
    return result;
  },

  listMembers(params: {
    regionCode?: string;
    tier?: string;
    /** Comma-separated multi-select tier filter (map legend / Filters sheet). */
    tiers?: string;
    status?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  }): Promise<MemberListResponse> {
    return request<MemberListResponse>(`/members${qs(params)}`);
  },

  getMember(id: string, withPii = false): Promise<Member> {
    return request<Member>(`/members/${id}${qs({ pii: withPii ? 'true' : undefined })}`);
  },

  createMember(payload: unknown): Promise<Member> {
    return request<Member>('/members', { method: 'POST', body: JSON.stringify(payload) });
  },

  updateMember(id: string, payload: unknown): Promise<Member> {
    return request<Member>(`/members/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },

  deleteMember(id: string): Promise<void> {
    return request<void>(`/members/${id}`, { method: 'DELETE' });
  },

  // ── Geo ────────────────────────────────────────────────────────
  geoPoints(params: Record<string, unknown>): Promise<GeoFeatureCollection> {
    return request<GeoFeatureCollection>(`/geo/points${qs(params)}`);
  },
  geoHeatmap(params: Record<string, unknown>): Promise<GeoFeatureCollection> {
    return request<GeoFeatureCollection>(`/geo/heatmap${qs(params)}`);
  },
  /**
   * Per-region aggregates for the shaded layer. `level` picks the grouping
   * column: `subcouncil` (the default, and what `members.region_code` holds) or
   * `ward` for the drilled-in view.
   */
  geoChoropleth(params: Record<string, unknown> & { level?: 'subcouncil' | 'ward' }): Promise<GeoFeatureCollection> {
    return request<GeoFeatureCollection>(`/geo/choropleth${qs(params)}`);
  },
  geoBoundaries(level: 'ward' | 'subcouncil', parentCode?: string): Promise<GeoFeatureCollection> {
    const p = parentCode ? `&parentCode=${encodeURIComponent(parentCode)}` : '';
    return request<GeoFeatureCollection>(`/geo/boundaries?level=${level}${p}`);
  },
  /**
   * Drill-down for one region — the map's tap-a-shape sheet. Takes the same
   * tier/status filters as the layers so the sheet's numbers always agree with
   * what is shaded.
   */
  geoRegionSummary(
    code: string,
    params: Record<string, unknown> = {},
  ): Promise<RegionSummary> {
    return request<RegionSummary>(`/geo/region-summary${qs({ ...params, code })}`);
  },
  /**
   * Wave 4 restricted member map: the caller's OWN ward only (subcouncil + ward
   * shapes + the PII-free ward drill-down). Reachable with `geo:read` OR
   * `geo:read_own_ward`; the server hard-scopes it to the caller's ward, so it
   * takes no ward parameter. A principal with no ward gets a 404.
   */
  geoMyWard(): Promise<MyWard> {
    return request<MyWard>('/geo/my-ward');
  },
  /** Non-private CASE heat for the caller's own ward (the member map's Heat toggle). */
  geoMyWardHeatmap(): Promise<{ points: HeatmapPoint[] }> {
    return request<{ points: HeatmapPoint[] }>('/geo/my-ward/heatmap');
  },
  /**
   * Open / resolved / follow-up counts for every area of all three map layers,
   * in one payload — the numbers the static map's bar chart draws. Reachable
   * with `geo:read` OR `geo:read_own_ward`; aggregate and PII-free, so it takes
   * no scope parameter and the layer buttons can switch without refetching.
   */
  geoCaseStats(): Promise<CaseStats> {
    return request<CaseStats>('/geo/case-stats');
  },

  // ── Audit ──────────────────────────────────────────────────────
  verifyAudit(): Promise<{ ok: boolean; checked: number; brokenAtSeq?: number }> {
    return request('/audit/verify');
  },

  // ── Events ─────────────────────────────────────────────────────
  listEvents(params: {
    upcoming?: boolean;
    regionCode?: string;
    ward?: string;
    kind?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ items: PartyEvent[]; total: number }> {
    return request(`/events${qs(params)}`);
  },
  getEvent(id: string): Promise<PartyEvent> {
    return request(`/events/${id}`);
  },
  createEvent(payload: unknown): Promise<PartyEvent> {
    return request('/events', { method: 'POST', body: JSON.stringify(payload) });
  },
  updateEvent(id: string, payload: unknown): Promise<PartyEvent> {
    return request(`/events/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },
  deleteEvent(id: string): Promise<void> {
    return request(`/events/${id}`, { method: 'DELETE' });
  },
  rsvpEvent(id: string, response: 'going' | 'interested' = 'going'): Promise<PartyEvent> {
    return request(`/events/${id}/rsvp`, {
      method: 'POST',
      body: JSON.stringify({ response }),
    });
  },
  cancelRsvp(id: string): Promise<PartyEvent> {
    return request(`/events/${id}/rsvp`, { method: 'DELETE' });
  },
  listEventAttendees(id: string): Promise<{ items: EventAttendee[]; total: number }> {
    return request(`/events/${id}/attendees`);
  },
  /** Public URL for an event's cover image (the calendar itself is public). */
  eventCoverUrl(id: string): string {
    return `${API_BASE}/events/${id}/cover`;
  },
  setEventCover(id: string, dataUrl: string): Promise<{ ok: boolean; hasCover: boolean }> {
    return request(`/events/${id}/cover`, { method: 'POST', body: JSON.stringify({ dataUrl }) });
  },
  deleteEventCover(id: string): Promise<{ ok: boolean; hasCover: boolean }> {
    return request(`/events/${id}/cover`, { method: 'DELETE' });
  },
  setBulletinCover(id: string, dataUrl: string): Promise<{ ok: boolean; hasCover: boolean }> {
    return request(`/ward-bulletins/${id}/cover`, { method: 'POST', body: JSON.stringify({ dataUrl }) });
  },
  deleteBulletinCover(id: string): Promise<{ ok: boolean; hasCover: boolean }> {
    return request(`/ward-bulletins/${id}/cover`, { method: 'DELETE' });
  },
  /**
   * Fetch a cover's bytes with the bearer token so a draft bulletin's cover (not
   * publicly served) still previews in the CRM. Returns null when absent.
   */
  async coverBlob(path: string, signal?: AbortSignal): Promise<Blob | null> {
    const token = tokenStore.access;
    const res = await safeFetch(`${API_BASE}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal,
    });
    return res.ok ? safeBlob(res, signal) : null;
  },

  // ── Ward candidates ("Meet our ward councillors" roster) ───────
  listCandidates(): Promise<{ items: WardCandidate[]; total: number }> {
    return request('/crm/candidates');
  },
  createCandidate(payload: WardCandidateInput): Promise<WardCandidate> {
    return request('/crm/candidates', { method: 'POST', body: JSON.stringify(payload) });
  },
  updateCandidate(id: string, payload: Partial<WardCandidateInput>): Promise<WardCandidate> {
    return request(`/crm/candidates/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },
  deleteCandidate(id: string): Promise<void> {
    return request(`/crm/candidates/${id}`, { method: 'DELETE' });
  },
  /** Public URL for a candidate photo — the same endpoint the marketing site hydrates from. */
  candidatePhotoUrl(id: string): string {
    return `${API_BASE}/public/candidates/${id}/photo`;
  },
  setCandidatePhoto(id: string, dataUrl: string): Promise<{ ok: boolean; hasPhoto: boolean }> {
    return request(`/crm/candidates/${id}/photo`, { method: 'POST', body: JSON.stringify({ dataUrl }) });
  },
  deleteCandidatePhoto(id: string): Promise<{ ok: boolean; hasPhoto: boolean }> {
    return request(`/crm/candidates/${id}/photo`, { method: 'DELETE' });
  },

  // ── Communications: news, press, highlights, community notes ───
  listPosts(params: {
    kind?: string;
    regionCode?: string;
    ward?: string;
    serviceArea?: string;
    status?: string;
    q?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ items: Post[]; total: number }> {
    return request(`/posts${qs(params)}`);
  },
  getPost(id: string): Promise<Post> {
    return request(`/posts/${id}`);
  },
  createPost(payload: unknown): Promise<Post> {
    return request('/posts', { method: 'POST', body: JSON.stringify(payload) });
  },
  updatePost(id: string, payload: unknown): Promise<Post> {
    return request(`/posts/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },
  /** Moderation: take a community note down, recording why. */
  takeDownPost(id: string, reason: string): Promise<Post> {
    return request(`/posts/${id}/take-down`, { method: 'POST', body: JSON.stringify({ reason }) });
  },
  restorePost(id: string): Promise<Post> {
    return request(`/posts/${id}/restore`, { method: 'POST' });
  },
  deletePost(id: string): Promise<void> {
    return request(`/posts/${id}`, { method: 'DELETE' });
  },

  // ── Appointments, positions & mandates ─────────────────────────
  listPositions(): Promise<{ items: Position[] }> {
    return request('/appointments/positions');
  },
  listAppointments(params: {
    memberId?: string;
    regionCode?: string;
    ward?: string;
    status?: string;
    positionCode?: string;
    limit?: number;
  } = {}): Promise<{ items: Appointment[]; total: number }> {
    return request(`/appointments${qs(params)}`);
  },
  createAppointment(payload: unknown): Promise<Appointment & { mandateUrl: string }> {
    return request('/appointments', { method: 'POST', body: JSON.stringify(payload) });
  },
  updateAppointment(id: string, payload: unknown): Promise<Appointment> {
    return request(`/appointments/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },
  deleteAppointment(id: string): Promise<void> {
    return request(`/appointments/${id}`, { method: 'DELETE' });
  },
  issueMandateLink(id: string): Promise<{ mandateUrl: string; expiresAt: string }> {
    return request(`/appointments/${id}/mandate-link`, { method: 'POST' });
  },

  // ── Notifications ──────────────────────────────────────────────
  listNotifications(params: { unread?: boolean; limit?: number } = {}): Promise<{
    items: AppNotification[];
    total: number;
    unread: number;
  }> {
    return request(`/notifications${qs(params)}`);
  },
  unreadCount(): Promise<{ unread: number }> {
    return request('/notifications/unread-count');
  },
  markNotificationRead(id: string): Promise<{ ok: boolean }> {
    return request(`/notifications/${id}/read`, { method: 'POST' });
  },
  markAllNotificationsRead(): Promise<{ ok: boolean; marked: number }> {
    return request('/notifications/read-all', { method: 'POST' });
  },
  broadcastNotification(payload: {
    title: string;
    body?: string;
    kind?: string;
    link?: string;
    regionCode?: string;
  }): Promise<{ ok: boolean }> {
    return request('/notifications', { method: 'POST', body: JSON.stringify(payload) });
  },

  // ── Public: party content, register, confirm, QR verify ────────
  publicMeta(): Promise<PublicMeta> {
    return request('/public/meta');
  },
  manifesto(): Promise<Manifesto> {
    return request('/public/manifesto');
  },
  /** Public Terms & Conditions (rendered by the T&C page + gate). */
  terms(): Promise<Terms> {
    return request('/public/terms');
  },
  publicPetitions(): Promise<{ items: Petition[] }> {
    return request('/public/petitions');
  },
  signPetition(id: string, publicCode: string): Promise<{ petitionId: string; signatureCount: number; alreadySigned: boolean }> {
    return request(`/public/petitions/${id}/sign`, {
      method: 'POST',
      body: JSON.stringify({ publicCode }),
    });
  },
  registerMember(payload: unknown): Promise<RegisterResult> {
    return request('/public/register', { method: 'POST', body: JSON.stringify(payload) });
  },
  confirmLink(token: string): Promise<ConfirmResult> {
    return request(`/public/confirm/${token}`);
  },
  verifyCode(code: string): Promise<VerifyCard> {
    return request(`/public/verify/${code}`);
  },

  // ── Ward transparency & accountability (PRD Phase 4.5) ─────────
  /** FR-B: resolve ward + councillor from a high-accuracy geolocation fix. */
  wardLookup(lat: number, lng: number, accuracyM?: number): Promise<WardLookupResult> {
    const q = new URLSearchParams({ lat: String(lat), lng: String(lng) });
    if (accuracyM != null) q.set('accuracyM', String(accuracyM));
    return request(`/transparency/wards/councillor?${q.toString()}`);
  },
  /** Resolve a fix to { ward, street, suburb, area } for the location box. */
  reverseGeocode(lat: number, lng: number, accuracyM?: number): Promise<import('../types').ReverseGeocodeResult> {
    const q = new URLSearchParams({ lat: String(lat), lng: String(lng) });
    if (accuracyM != null) q.set('accuracyM', String(accuracyM));
    return request(`/transparency/reverse-geocode?${q.toString()}`);
  },
  /** FR-C: aggregate overview for any ward (public). */
  wardOverview(code: string): Promise<WardOverview> {
    return request(`/transparency/wards/${code}/overview`);
  },
  /** FR-D: member-gated ward detail (patrols / projects / logs). */
  wardDetail(code: string): Promise<WardDetail> {
    return request(`/transparency/wards/${code}/detail`);
  },
  /** Resident → ward councillor report (text + optional photo/video/voice + location). */
  submitResidentReport(payload: CreateResidentReportInput): Promise<CreateResidentReportResult> {
    return request('/transparency/reports', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** The signed-in resident's own reports (`mine`) or a councillor's ward inbox. */
  residentReports(scope: 'mine' | 'inbox' = 'mine', limit = 50, offset = 0): Promise<{ items: ResidentReport[]; total: number }> {
    return request(`/transparency/reports${qs({ scope, limit, offset })}`);
  },
  async allResidentReports(scope: 'mine' | 'inbox' = 'mine'): Promise<{ items: ResidentReport[]; total: number }> {
    const items: ResidentReport[] = [];
    let total = 0;
    do {
      const page = await api.residentReports(scope, 200, items.length);
      total = page.total;
      if (!page.items.length) break;
      items.push(...page.items);
    } while (items.length < total);
    return { items, total };
  },
  managedReports(filters: ReportFilters = {}, limit = 15, offset = 0): Promise<{ items: ResidentReport[]; total: number; stats: ReportStats }> {
    return request(`/transparency/reports${qs({ ...filters, scope: 'inbox', limit, offset })}`);
  },
  reportAccountability(filters: ReportFilters = {}, limit = 15, offset = 0): Promise<{ items: ReportAccountability[]; total: number }> {
    return request(`/transparency/reports/accountability${qs({ ...filters, limit, offset })}`);
  },
  reportFilterOptions(): Promise<ReportFilterOptions> { return request('/transparency/reports/filter-options'); },
  reportTasks(filters: ReportTaskFilters = {}, limit = 15, offset = 0): Promise<{ items: ReportTask[]; total: number }> {
    return request(`/transparency/report-tasks${qs({ ...filters, limit, offset })}`);
  },
  reportAssignees(reportId: string): Promise<{ items: ReportAssignee[] }> {
    return request(`/transparency/reports/${reportId}/assignees`);
  },
  createReportTask(reportId: string, input: ReportTaskInput): Promise<{ id: string }> {
    return request(`/transparency/reports/${reportId}/tasks`, { method: 'POST', body: JSON.stringify(input) });
  },
  updateReportTask(reportId: string, taskId: string, input: ReportTaskInput): Promise<{ id: string }> {
    return request(`/transparency/reports/${reportId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(input) });
  },
  mediaPolicy(): Promise<MediaPolicy> { return request('/transparency/media-policy'); },
  setMediaPolicy(policy: MediaPolicy): Promise<MediaPolicy> {
    return request('/transparency/media-policy', { method: 'PUT', body: JSON.stringify(policy) });
  },
  /** One resident report (owner or ward staff). */
  residentReport(id: string): Promise<ResidentReport> {
    return request(`/transparency/reports/${id}`);
  },
  /** Staff update: move status and/or write follow-up feedback to the resident. */
  updateResidentReport(
    id: string,
    payload: ReportActionInput,
  ): Promise<ResidentReport> {
    return request(`/transparency/reports/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },
  /**
   * Fetch a transparency-tier media asset (resident-report / patrol attachment)
   * as a Blob. `<img>` cannot send an Authorization header, so callers render
   * the blob via an object URL — the same pattern as `MediaThumb`. Returns null
   * when not found or not permitted.
   */
  async transparencyMediaBlob(mediaId: string, signal?: AbortSignal): Promise<Blob | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = tokenStore.access;
      const res = await safeFetch(`${API_BASE}/transparency/media/${mediaId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal,
      });
      if (res.ok) return safeBlob(res, signal);
      if (res.status !== 401 || attempt > 0 || !token || signal?.aborted) return null;
      const fresh = tokenStore.access !== token ? tokenStore.access : await refreshAccessToken();
      if (!fresh || signal?.aborted) return null;
    }
    return null;
  },
  /** FR-D5: rate councillor work (1-5; reason mandatory when <=2). */
  rateTransparencyWork(payload: {
    targetType: 'service_request' | 'project' | 'patrol' | 'councillor';
    targetId: string;
    rating: number;
    reason?: string;
  }): Promise<{ id: string }> {
    return request('/transparency/ratings', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** The QR party ID card for a member (identity fields need PII rights). */
  partyCard(memberId: string, withPii = false): Promise<PartyCard> {
    return request(`/public/card/${memberId}${qs({ pii: withPii ? 'true' : undefined })}`);
  },
  resendConfirmLink(memberId: string): Promise<{ confirmUrl: string; expiresAt: string }> {
    return request(`/public/card/${memberId}/confirm-link`, { method: 'POST' });
  },

  // ── Party ID Card Studio (migration 022) ──────────────────────────────────
  /**
   * The active card design + studio metadata (flags, size presets, field keys)
   * for the national-admin designer. Gated server-side on `module:manage`.
   */
  cardDesign(): Promise<CardDesignView> {
    return request('/id-card/design');
  },
  /** Persist a new card template (validated, audited, takes effect immediately). */
  saveCardDesign(design: CardDesign): Promise<{ design: CardDesign }> {
    return request('/id-card/design', { method: 'PUT', body: JSON.stringify(design) });
  },
  /**
   * Upload the party logo (base64 data-url) via the shared media pipeline; fold
   * the returned `mediaId` into `design.logo`. National admin only.
   */
  uploadCardLogo(dataUrl: string): Promise<{ mediaId: string; url: string }> {
    return request('/id-card/logo', { method: 'POST', body: JSON.stringify({ dataUrl }) });
  },
  /**
   * Set or re-frame a member's card photo. `dataUrl` uploads a new image;
   * `transform` alone re-crops/zooms the existing one. Gated on `member:write`
   * within the caller's scope.
   */
  setCardPhoto(
    memberId: string,
    body: { dataUrl?: string; transform?: Partial<PhotoTransform> },
  ): Promise<{ photo: CardPhoto }> {
    return request(`/id-card/member/${memberId}/photo`, { method: 'PUT', body: JSON.stringify(body) });
  },
  /** Clear a member's card photo (the slot falls back to the no-photo layout). */
  deleteCardPhoto(memberId: string): Promise<{ success: boolean }> {
    return request(`/id-card/member/${memberId}/photo`, { method: 'DELETE' });
  },
  /**
   * Build many cards for a batch print run (multi-select → print). PII is never
   * revealed in a batch; out-of-scope/unknown ids come back in `skipped`.
   */
  batchCards(memberIds: string[]): Promise<BatchCardsResult> {
    return request('/id-card/batch', { method: 'POST', body: JSON.stringify({ memberIds }) });
  },
  /**
   * Fetch a card image (party logo or a member's photo) as a Blob. `<img>` cannot
   * send an Authorization header, so callers render the blob via an object URL —
   * the same pattern as the CRM `AvatarThumb`. `mediaId` is the bare id from
   * `design.logo.mediaId` or `card.photo.mediaId`; returns null when not found.
   */
  async cardMediaBlob(mediaId: string): Promise<Blob | null> {
    const res = await safeFetch(`${API_BASE}/id-card/media/${mediaId}`, {
      headers: { Authorization: `Bearer ${tokenStore.access ?? ''}` },
    });
    return res.ok ? safeBlob(res) : null;
  },

  // ── Ward jobs: interest register, demand, opportunity relay (PRD-jobs) ──
  /** Active work-type taxonomy (form chips + CRM editor). */
  jobWorkTypes(): Promise<{ items: WorkType[] }> {
    return request('/jobs/work-types');
  },
  /** §9.7: public feature-flag booleans used to gate the jobs UI. */
  jobFlags(): Promise<JobsFlags> {
    return request('/jobs/flags');
  },
  /** FR-L4: anonymous aggregate count for a ward (flag-gated in the UI). */
  jobPublicCount(ward: string): Promise<JobPublicCount> {
    return request(`/jobs/public-count${qs({ ward })}`);
  },
  /** FR-K: the signed-in member's own interest (or null). */
  getJobInterest(): Promise<{ interest: JobInterest | null }> {
    return request('/jobs/interest');
  },
  /** FR-K1/K4: create-or-update the member's own interest. */
  upsertJobInterest(payload: UpsertJobInterestInput): Promise<{ interest: JobInterest }> {
    return request('/jobs/interest', { method: 'PUT', body: JSON.stringify(payload) });
  },
  /** FR-K5: withdraw = hard delete of the member's own row. */
  withdrawJobInterest(): Promise<{ deleted: number }> {
    return request('/jobs/interest', { method: 'DELETE' });
  },
  /** FR-L: aggregate, PII-free ward work-demand (staff/analyst). */
  listJobDemand(ward?: string): Promise<JobDemand> {
    return request(`/jobs/demand${qs({ ward })}`);
  },
  /** FR-K6 (member) / FR-N2 (staff): list opportunities, scoped by role. */
  listJobOpportunities(params: { ward?: string; status?: string; limit?: number } = {}): Promise<{ items: JobOpportunity[] }> {
    return request(`/jobs/opportunities${qs(params)}`);
  },
  getJobOpportunity(id: string): Promise<{ opportunity: JobOpportunity }> {
    return request(`/jobs/opportunities/${id}`);
  },
  /** FR-M1: record an opportunity (draft). */
  createJobOpportunity(payload: CreateJobOpportunityInput): Promise<{ opportunity: JobOpportunity }> {
    return request('/jobs/opportunities', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** FR-M5: limited edit. */
  updateJobOpportunity(id: string, payload: Partial<CreateJobOpportunityInput>): Promise<{ opportunity: JobOpportunity }> {
    return request(`/jobs/opportunities/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },
  /** FR-M2: publish + relay to matched members (returns delivery counts only). */
  publishJobOpportunity(id: string): Promise<{ opportunity: JobOpportunity; duplicateWarning: boolean }> {
    return request(`/jobs/opportunities/${id}/publish`, { method: 'POST' });
  },
  /** FR-M5: close an opportunity. */
  closeJobOpportunity(id: string): Promise<{ opportunity: JobOpportunity }> {
    return request(`/jobs/opportunities/${id}/close`, { method: 'POST' });
  },
  /** FR-N4: full work-type taxonomy (national admin), including inactive codes. */
  jobAdminWorkTypes(): Promise<{ items: WorkTypeAdmin[] }> {
    return request('/jobs/admin/work-types');
  },
  /** FR-N4: create/update a work type (national admin). */
  jobUpsertWorkType(code: string, payload: UpsertWorkTypeInput): Promise<{ workType: WorkTypeAdmin }> {
    return request(`/jobs/admin/work-types/${encodeURIComponent(code)}`, { method: 'PUT', body: JSON.stringify(payload) });
  },
  /** FR-N4: current jobs config — flags, relay template, windows (national admin). */
  jobAdminConfig(): Promise<JobsAdminConfig> {
    return request('/jobs/admin/config');
  },
  /** FR-N4: update jobs config (partial) (national admin). */
  jobUpdateConfig(payload: UpdateJobsConfigInput): Promise<JobsAdminConfig> {
    return request('/jobs/admin/config', { method: 'PUT', body: JSON.stringify(payload) });
  },

  // ── Service Requests ────────────────────────────────────────────
  listServiceRequests(params?: Record<string, string>): Promise<{ items: ServiceRequest[]; total: number }> {
    return request<{ items: any[]; total: number }>(`/service-requests${qs(params ?? {})}`).then((r) => ({
      items: (r.items ?? []).map(normalizeServiceRequest),
      total: r.total,
    }));
  },
  getServiceRequest(id: string): Promise<ServiceRequest> {
    return request<any>(`/service-requests/${id}`).then(normalizeServiceRequest);
  },
  createServiceRequest(payload: unknown): Promise<ServiceRequest> {
    return request<any>('/service-requests', { method: 'POST', body: JSON.stringify(payload) }).then(normalizeServiceRequest);
  },
  updateServiceRequest(id: string, payload: unknown): Promise<ServiceRequest> {
    return request<any>(`/service-requests/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }).then(normalizeServiceRequest);
  },
  closeServiceRequest(id: string, payload: unknown): Promise<ServiceRequest> {
    return request<any>(`/service-requests/${id}/close`, { method: 'POST', body: JSON.stringify(payload) }).then(normalizeServiceRequest);
  },

  // ── Ward Bulletins ──────────────────────────────────────────────
  listBulletins(params?: Record<string, string>): Promise<{ items: WardBulletin[]; total: number }> {
    return request(`/ward-bulletins${qs(params ?? {})}`);
  },
  getBulletin(id: string): Promise<WardBulletin> {
    return request(`/ward-bulletins/${id}`);
  },
  createBulletin(payload: unknown): Promise<WardBulletin> {
    return request('/ward-bulletins', { method: 'POST', body: JSON.stringify(payload) });
  },
  updateBulletin(id: string, payload: unknown): Promise<WardBulletin> {
    return request(`/ward-bulletins/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },

  // ── Attachments (bulletin / event: PDF, photo, short video, URL link) ──
  listAttachments(parentType: 'bulletin' | 'event', parentId: string): Promise<{ items: Attachment[] }> {
    return request(`/attachments?parentType=${parentType}&parentId=${parentId}`);
  },
  createAttachment(payload: {
    parentType: 'bulletin' | 'event';
    parentId: string;
    kind: 'photo' | 'video' | 'document';
    dataUrl: string;
    title?: string;
    caption?: string;
  } | {
    parentType: 'bulletin' | 'event';
    parentId: string;
    kind: 'link';
    url: string;
    title?: string;
    caption?: string;
  }): Promise<Attachment> {
    return request('/attachments', { method: 'POST', body: JSON.stringify(payload) });
  },
  deleteAttachment(id: string): Promise<void> {
    return request(`/attachments/${id}`, { method: 'DELETE' });
  },
  /**
   * Fetch a file attachment's bytes as a Blob. `<img>` / `<video>` cannot send
   * an Authorization header, so a bulletin draft is rendered from this object
   * URL (same pattern as `transparencyMediaBlob`); published parents also answer
   * the plain `/attachments/:id/file` route anonymously.
   */
  async attachmentFileBlob(id: string, signal?: AbortSignal): Promise<Blob | null> {
    const token = tokenStore.access;
    const res = await safeFetch(`${API_BASE}/attachments/${id}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal,
    });
    return res.ok ? safeBlob(res, signal) : null;
  },

  // ── Participations ──────────────────────────────────────────────
  listParticipations(params?: Record<string, string>): Promise<{ items: Participation[]; total: number }> {
    return request(`/participations${qs(params ?? {})}`);
  },
  getParticipation(id: string): Promise<Participation> {
    return request(`/participations/${id}`);
  },
  createParticipation(payload: unknown): Promise<Participation> {
    return request('/participations', { method: 'POST', body: JSON.stringify(payload) });
  },
  addParticipationComment(id: string, payload: unknown): Promise<{ id: string; comment: string }> {
    return request(`/participations/${id}/comments`, { method: 'POST', body: JSON.stringify(payload) });
  },

  // ── Ratings ─────────────────────────────────────────────────────
  async listRatings(params?: Record<string, string>): Promise<{ items: Rating[]; total: number }> {
    const result = await request<{ items: Rating[]; total: number }>(`/ratings${qs(params ?? {})}`, { cache: 'no-store' });
    validateList(result, 'ratings');
    return result;
  },
  createRating(payload: unknown): Promise<Rating> {
    return request('/ratings', { method: 'POST', body: JSON.stringify(payload) });
  },
  getAverageRating(targetType: string, targetId: string): Promise<{ avg: number; count: number }> {
    return request(`/ratings/average/${targetType}/${targetId}`);
  },

  // ── Patrols ─────────────────────────────────────────────────────
  patrolStats(): Promise<import('../types').ActivityModuleStats> {
    return request('/patrols/stats');
  },
  listPatrols(params?: Record<string, string>): Promise<{ items: Patrol[]; total: number }> {
    return request(`/patrols${qs(params ?? {})}`);
  },
  getPatrol(id: string): Promise<Patrol> {
    return request(`/patrols/${id}`);
  },
  createPatrol(payload: unknown): Promise<Patrol> {
    return request('/patrols', { method: 'POST', body: JSON.stringify(payload) });
  },
  /** CRM edit of the patrol record (ward, mode, purpose, summary, status). */
  updatePatrol(id: string, payload: unknown): Promise<Patrol> {
    return request(`/patrols/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },
  /** Delete a patrol (track points, stops and media cascade). */
  deletePatrol(id: string): Promise<void> {
    return request(`/patrols/${id}`, { method: 'DELETE' });
  },
  addTrackPoint(patrolId: string, payload: unknown): Promise<import('../types').TrackPointResult> {
    return request(`/patrols/${patrolId}/track-points`, { method: 'POST', body: JSON.stringify(payload) });
  },
  addPatrolStop(patrolId: string, payload: unknown): Promise<{ id: string }> {
    return request(`/patrols/${patrolId}/stops`, { method: 'POST', body: JSON.stringify(payload) });
  },
  listPatrolStops(patrolId: string): Promise<{ items: import('../types').PatrolStop[] }> {
    return request(`/patrols/${patrolId}/stops`);
  },
  updatePatrolStop(patrolId: string, stopId: string, payload: unknown): Promise<import('../types').PatrolStop> {
    return request(`/patrols/${patrolId}/stops/${stopId}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },
  endPatrol(patrolId: string, payload: unknown): Promise<Patrol> {
    return request(`/patrols/${patrolId}/end`, { method: 'POST', body: JSON.stringify(payload) });
  },
  getHeatmap(wardCode?: string): Promise<{ points: HeatmapPoint[] }> {
    return request(`/patrols/heatmap${qs(wardCode ? { wardCode } : {})}`);
  },

  // ── Verifications ───────────────────────────────────────────────
  async listVerifications(params?: Record<string, string>): Promise<{ items: Verification[]; total: number }> {
    const result = await request<{ items: Verification[]; total: number }>(`/verifications${qs(params ?? {})}`, { cache: 'no-store' });
    validateList(result, 'verifications');
    return result;
  },
  createVerification(payload: unknown): Promise<Verification> {
    return request('/verifications', { method: 'POST', body: JSON.stringify(payload) });
  },

  // ── Projects ────────────────────────────────────────────────────
  listProjects(params?: Record<string, string>): Promise<{ items: Project[]; total: number }> {
    return request(`/projects${qs(params ?? {})}`);
  },
  getProject(id: string): Promise<Project & { milestones: Milestone[] }> {
    return request(`/projects/${id}`);
  },
  createProject(payload: unknown): Promise<Project> {
    return request('/projects', { method: 'POST', body: JSON.stringify(payload) });
  },
  addMilestone(projectId: string, payload: unknown): Promise<Milestone> {
    return request(`/projects/${projectId}/milestones`, { method: 'POST', body: JSON.stringify(payload) });
  },

  // ── CRM Desktop ────────────────────────────────────────────────
  async crmDashboard(): Promise<CrmDashboard> {
    const result = await request<CrmDashboard>('/crm/dashboard', { cache: 'no-store' });
    validateDashboardPerformance(result);
    return result;
  },
  async crmWardSummary(params: { ward?: string } = {}): Promise<WardSummary> {
    const ward = params.ward?.trim();
    if (ward !== undefined && (!ward || ward.length > 32)) throw new ApiClientError(400, 'bad_request');
    const result = await request<WardSummary>(`/crm/wards/summary${qs({ ward })}`, { cache: 'no-store' });
    validateWardSummary(result, ward);
    return result;
  },
  async crmEngagements(params?: Record<string, string>): Promise<{
    items: ServiceRequest[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const result = await request<{ items: ServiceRequest[]; total: number; limit: number; offset: number }>(`/crm/engagements${qs(params ?? {})}`, { cache: 'no-store' });
    validateList(result, 'cases');
    return result;
  },
  async allCrmEngagements(): Promise<{ items: ServiceRequest[]; total: number }> {
    const items: ServiceRequest[] = [];
    let total = 0;
    do {
      const page = await api.crmEngagements({ limit: '200', offset: String(items.length) });
      total = page.total;
      if (!page.items.length) break;
      items.push(...page.items);
    } while (items.length < total);
    return { items, total };
  },
  async crmEscalations(): Promise<{ items: (ServiceRequest & { escalationReason: 'sla_breach' | 'stuck' | 'overdue' })[]; total: number }> {
    const result = await request<{ items: (ServiceRequest & { escalationReason: 'sla_breach' | 'stuck' | 'overdue' })[]; total: number }>('/crm/escalations', { cache: 'no-store' });
    validateList(result, 'escalations');
    return result;
  },
  crmMembers(params?: Record<string, string>): Promise<{
    items: Member[];
    total: number;
    limit: number;
    offset: number;
  }> {
    return request(`/crm/members${qs(params ?? {})}`);
  },
  crmAudit(params?: Record<string, string>): Promise<{
    items: any[];
    total: number;
    limit: number;
    offset: number;
  }> {
    return request(`/crm/audit${qs(params ?? {})}`);
  },

  // ── CRM User Management ────────────────────────────────────────
  crmListUsers(params?: Record<string, string>): Promise<{
    items: any[];
    total: number;
    limit: number;
    offset: number;
  }> {
    return request(`/crm/users${qs(params ?? {})}`);
  },
  crmGetUser(id: string): Promise<any> {
    return request(`/crm/users/${id}`);
  },
  crmCreateUser(payload: {
    email: string;
    password: string;
    role: string;
    fullName?: string;
    regionCodes?: string[];
    wardCode?: string | null;
    /** Full ward list for a councillor; the first entry becomes the primary wardCode. */
    wardCodes?: string[];
    /** Per-person overrides on top of the role's base set. */
    permissionGrants?: string[];
    permissionRevokes?: string[];
    avatarMediaId?: string | null;
    bio?: string | null;
    title?: string | null;
  }): Promise<any> {
    return request('/crm/users', { method: 'POST', body: JSON.stringify(payload) });
  },
  crmUpdateUser(id: string, payload: {
    email?: string;
    role?: string;
    wardCode?: string | null;
    /** Full ward list; wardCode (primary) is re-derived from its first entry. */
    wardCodes?: string[];
    regionCodes?: string[];
    isActive?: boolean;
    permissionGrants?: string[];
    permissionRevokes?: string[];
    avatarMediaId?: string | null;
    bio?: string | null;
    title?: string | null;
  }): Promise<any> {
    return request(`/crm/users/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },
  /**
   * Bulk-provision users from parsed CSV rows (the ward-councillor list).
   * Each row is created independently server-side, so the response reports a
   * per-row outcome instead of failing the whole batch on one bad line.
   */
  crmImportUsers(
    rows: Array<{
      email: string;
      fullName?: string;
      password?: string;
      role?: string;
      wardCode?: string;
      regionCodes?: string;
    }>,
    defaultPassword?: string,
  ): Promise<{
    total: number;
    created: number;
    skipped: number;
    failed: number;
    results: Array<{ row: number; email: string; status: 'created' | 'skipped' | 'error'; message?: string }>;
  }> {
    return request('/crm/users/import', {
      method: 'POST',
      body: JSON.stringify({ rows, defaultPassword }),
    });
  },
  /** Store a base64 data-url as a media asset, for a user's profile photo. */
  crmUploadMedia(dataUrl: string): Promise<{ id: string; url: string }> {
    return request('/crm/media', { method: 'POST', body: JSON.stringify({ dataUrl }) });
  },
  crmDeleteUser(id: string): Promise<{ success: boolean }> {
    return request(`/crm/users/${id}`, { method: 'DELETE' });
  },
  crmResetPassword(id: string, newPassword: string): Promise<{ success: boolean }> {
    return request(`/crm/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) });
  },
  crmGetRolePermissions(role: string): Promise<{ role: string; permissions: string[] }> {
    return request(`/crm/roles/${role}/permissions`);
  },

  // ── CRM Module registry (national admin) ───────────────────────
  /**
   * The module registry with the per-role gate matrix, for the CRM → Settings →
   * Module registry editor. Gated server-side on `module:manage`.
   */
  crmGetModules(): Promise<ModuleRegistry> {
    return request('/crm/modules');
  },
  /**
   * Enable or disable one module for one role. The server upserts the gate,
   * audits the change, and rejects a national-admin lockout (400
   * `module_lockout`) — the `admin`/`overview` modules cannot be switched off
   * for the one role that could switch them back on.
   */
  crmSetModuleGate(
    role: string,
    key: string,
    enabled: boolean,
  ): Promise<{ role: string; moduleKey: string; enabled: boolean }> {
    return request(
      `/crm/modules/${encodeURIComponent(role)}/${encodeURIComponent(key)}`,
      { method: 'PUT', body: JSON.stringify({ enabled }) },
    );
  },

  // ── CRM Marketing Campaigns ───────────────────────────
  crmListCampaigns(params?: Record<string, string>): Promise<{
    items: any[];
    total: number;
    limit: number;
    offset: number;
  }> {
    return request(`/crm/campaigns${qs(params ?? {})}`);
  },
  crmGetCampaign(id: string): Promise<any> {
    return request(`/crm/campaigns/${id}`);
  },
  crmCreateCampaign(payload: {
    title: string;
    description?: string;
    target_audience?: Record<string, unknown>;
    start_date?: string;
    end_date?: string;
    status?: string;
  }): Promise<any> {
    return request('/crm/campaigns', { method: 'POST', body: JSON.stringify(payload) });
  },
  crmUpdateCampaign(id: string, payload: Record<string, unknown>): Promise<any> {
    return request(`/crm/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },
  crmDeleteCampaign(id: string): Promise<{ success: boolean }> {
    return request(`/crm/campaigns/${id}`, { method: 'DELETE' });
  },
  crmCampaignEngagement(id: string, metrics: { clicks?: number; shares?: number; conversions?: number }): Promise<any> {
    return request(`/crm/campaigns/${id}/engagement`, { method: 'POST', body: JSON.stringify(metrics) });
  },

  // ── Moderation: ban/suspend ladder + device bans (national admin) ──
  /** Searchable moderation queue of accounts. */
  moderationUsers(params: {
    search?: string;
    status?: string;
    role?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ items: ModerationUser[]; total: number; limit: number; offset: number }> {
    return request(`/moderation/users${qs(params)}`);
  },
  /** One account: status + T&C + moderation history + audit trail. */
  moderationProfile(id: string): Promise<ModerationProfile> {
    return request(`/moderation/users/${id}`);
  },
  /** Banned-device register. */
  moderationDevices(): Promise<{ items: BannedDevice[]; limit: number; offset: number }> {
    return request('/moderation/devices');
  },
  /** Apply warn/suspend/ban/reinstate/device_ban/device_unban. */
  applyModerationAction(payload: ApplyModerationActionInput): Promise<ApplyModerationActionResult> {
    return request('/moderation/actions', { method: 'POST', body: JSON.stringify(payload) });
  },

  // ── Recruitment genealogy (PRD-growth FR-O) ──────────────────────
  // PII-free: nodes/rows carry member PUBLIC CODES, tiers, wards and aggregate
  // counts only — never sealed names/emails. The sole human name is a PUBLIC
  // councillor `displayName` from the published leaders directory (AC-O2).
  /** FR-O2: the caller's own reference number, join link and QR payload. */
  getInvite(): Promise<InviteView> {
    return request('/recruitment/invite');
  },
  /** FR-O4: a recruitment subtree. `root` defaults to the caller's own member. */
  getRecruitmentTree(params: { root?: string; depth?: number } = {}): Promise<TreeView> {
    return request(`/recruitment/tree${qs(params)}`);
  },
  /** FR-O5: trace one member up to the root source of their branch. */
  getRecruitmentLineage(member: string): Promise<LineageView> {
    return request(`/recruitment/lineage${qs({ member })}`);
  },
  /** FR-O6: the ranked recruitment report (ward councillors first). */
  getRecruitmentReport(params: { ward?: string; limit?: number } = {}): Promise<ReportView> {
    return request(`/recruitment/report${qs(params)}`);
  },

  // ── Councillor performance scorecards (PRD-growth FR-S) ──────────────
  // PII-free: the inbox/rollups speak in member PUBLIC CODES (revealed only when
  // the member opted into shareName), wards, categories, scores and counts —
  // never sealed names/emails. The reasons are the actionable content (AC-O2).
  /** FR-S4: the caller's current-month card — eligibility, status, categories. */
  async getCurrentScorecard(): Promise<ScorecardCurrent> {
    const result = await request<ScorecardCurrent>('/scorecards/current', { cache: 'no-store' });
    validateCurrentScorecard(result);
    return result;
  },
  /** FR-S2/S3: submit or update this month's scorecard (100-word rule for ≤2). */
  submitScorecard(payload: SubmitScorecardInput): Promise<ScorecardView> {
    return request('/scorecards', { method: 'PUT', body: JSON.stringify(payload) });
  },
  /** FR-S2: the caller's own scorecards across previous months. */
  getScorecardHistory(params: { limit?: number } = {}): Promise<ScorecardHistory> {
    return request(`/scorecards/history${qs(params)}`);
  },
  /** FR-S1: the active category taxonomy (labels + order) for the CRM editor. */
  getScorecardCategories(): Promise<ScorecardCategories> {
    return request('/scorecards/categories');
  },
  /** FR-S6/S7: scorecards in scope for the acknowledgement workflow. */
  async getScorecardInbox(params: ScorecardPageFilters = {}): Promise<ScorecardInbox> {
    const q = scorecardQuery(params);
    const result = await request<ScorecardInbox>(`/scorecards/inbox${qs({ ...q })}`, { cache: 'no-store' });
    validateScorecardRollup(result, q, 'inbox');
    return result;
  },
  /** FR-S8: per-category averages, distribution and counts across scope. */
  async getScorecardSummary(params: ScorecardFilters = {}): Promise<ScorecardSummary> {
    const q = scorecardQuery(params);
    const result = await request<ScorecardSummary>(`/scorecards/summary${qs({ ...q })}`, { cache: 'no-store' });
    validateScorecardRollup(result, q, 'summary');
    return result;
  },
  /** FR-S8: the ≤2 reasons queue — the actionable complaints across scope. */
  async getScorecardLowReasons(params: ScorecardPageFilters = {}): Promise<ScorecardLowReasons> {
    const q = scorecardQuery(params);
    const result = await request<ScorecardLowReasons>(`/scorecards/low-reasons${qs({ ...q })}`, { cache: 'no-store' });
    validateScorecardRollup(result, q, 'reasons');
    return result;
  },
  /** FR-S6: opening a submitted scorecard marks it `viewed`. */
  async viewScorecard(id: string): Promise<ScorecardView> {
    const result = await request<ScorecardView>(`/scorecards/${id}/view`, { method: 'POST' });
    validateScorecardView(result);
    dtoCheck(result.id === id);
    return result;
  },
  /** FR-S6: acknowledge a scorecard and notify the member. */
  async acknowledgeScorecard(id: string, payload: AcknowledgeScorecardInput = {}): Promise<ScorecardView> {
    const result = await request<ScorecardView>(`/scorecards/${id}/acknowledge`, { method: 'POST', body: JSON.stringify(payload) });
    validateScorecardView(result);
    dtoCheck(result.id === id);
    return result;
  },

  // ── SuperAdmin analytics (analytics:read) ────────────────────────
  getAnalyticsOverview(params: { days?: number; site?: string } = {}): Promise<AnalyticsOverview> {
    return request(`/analytics/overview${qs(params)}`);
  },
  getAnalyticsTraffic(params: { days?: number; site?: string } = {}): Promise<AnalyticsTraffic> {
    return request(`/analytics/traffic${qs(params)}`);
  },
  getAnalyticsDevices(params: { days?: number; site?: string } = {}): Promise<AnalyticsDevices> {
    return request(`/analytics/devices${qs(params)}`);
  },
  getAnalyticsRealtime(): Promise<AnalyticsRealtime> {
    return request('/analytics/realtime');
  },
  getAnalyticsDownloads(params: { days?: number } = {}): Promise<AnalyticsDownloads> {
    return request(`/analytics/downloads${qs(params)}`);
  },

  // ── SuperAdmin platform ops (platform:read) ──────────────────────
  getServerStatus(): Promise<ServerStatus> {
    return request('/crm/superadmin/server');
  },
  getLiveUsers(): Promise<LiveSnapshot> {
    return request('/crm/superadmin/live');
  },
  getPlatformJobs(limit = 30): Promise<PlatformJobs> {
    return request(`/crm/superadmin/jobs${qs({ limit })}`);
  },
  getPlatformSnapshot(): Promise<PlatformSnapshot> {
    return request('/crm/superadmin/snapshot');
  },

  // ── SuperAdmin website content (content:manage) ──────────────────
  listContentBlocks(): Promise<{ blocks: ContentBlockSummary[] }> {
    return request('/crm/superadmin/content');
  },
  getContentBlock(key: string): Promise<{ block: ContentBlockFull; versions: ContentVersion[] }> {
    return request(`/crm/superadmin/content/${encodeURIComponent(key)}`);
  },
  saveContentDraft(key: string, draft: unknown): Promise<{ block: ContentBlockFull }> {
    return request(`/crm/superadmin/content/${encodeURIComponent(key)}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ draft }),
    });
  },
  publishContentBlock(key: string): Promise<{ block: ContentBlockFull }> {
    return request(`/crm/superadmin/content/${encodeURIComponent(key)}/publish`, { method: 'POST' });
  },
  rollbackContentBlock(key: string, version: number): Promise<{ block: ContentBlockFull }> {
    return request(`/crm/superadmin/content/${encodeURIComponent(key)}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    });
  },
  createContentBlock(input: {
    key: string; site: 'marketing' | 'app' | 'shared'; title: string;
    kind: ContentBlockKind; schema: unknown;
  }): Promise<{ block: ContentBlockFull }> {
    return request('/crm/superadmin/content', { method: 'POST', body: JSON.stringify(input) });
  },
  deleteContentBlock(key: string): Promise<{ ok: boolean }> {
    return request(`/crm/superadmin/content/${encodeURIComponent(key)}`, { method: 'DELETE' });
  },
  /** Upload a slide image etc.; the returned url is publicly servable once published. */
  uploadCmsMedia(dataUrl: string): Promise<{ mediaId: string; url: string }> {
    return request('/crm/superadmin/content/media', { method: 'POST', body: JSON.stringify({ dataUrl }) });
  },

  // ── CMS pages (content:manage) ────────────────────────────────
  listContentPages(site?: string): Promise<{ pages: ContentPageSummary[] }> {
    return request(`/crm/superadmin/content/pages${qs({ site })}`);
  },
  createContentPage(input: { slug: string; site: 'marketing' | 'app'; title: string }): Promise<{ page: ContentPageFull }> {
    return request('/crm/superadmin/content/pages', { method: 'POST', body: JSON.stringify(input) });
  },
  getContentPage(slug: string): Promise<{ page: ContentPageFull; blocks: ContentBlockFull[]; versions: ContentVersion[] }> {
    return request(`/crm/superadmin/content/pages/${encodeURIComponent(slug)}`);
  },
  updatePageSections(slug: string, sections: PageSectionRef[]): Promise<{ page: ContentPageFull }> {
    return request(`/crm/superadmin/content/pages/${encodeURIComponent(slug)}/sections`, {
      method: 'PUT',
      body: JSON.stringify({ sections }),
    });
  },
  renameContentPage(slug: string, title: string): Promise<{ page: ContentPageFull }> {
    return request(`/crm/superadmin/content/pages/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
  },
  publishContentPage(slug: string): Promise<{ page: ContentPageFull }> {
    return request(`/crm/superadmin/content/pages/${encodeURIComponent(slug)}/publish`, { method: 'POST' });
  },
  rollbackContentPage(slug: string, version: number): Promise<{ page: ContentPageFull }> {
    return request(`/crm/superadmin/content/pages/${encodeURIComponent(slug)}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    });
  },
  deleteContentPage(slug: string): Promise<{ ok: boolean }> {
    return request(`/crm/superadmin/content/pages/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  },
  /** Public hydration: only published payloads, no auth required. */
  getPublicContent(site?: string): Promise<{ blocks: Record<string, { data: unknown; publishedAt: string }> }> {
    return request(`/public/content${qs({ site })}`);
  },
  getPublicPages(site?: string): Promise<{ pages: Array<{ slug: string; site: string; title: string | null }> }> {
    return request(`/public/pages${qs({ site })}`);
  },
  getPublicPage(slug: string): Promise<PublicPage> {
    return request(`/public/pages/${encodeURIComponent(slug)}`);
  },
};

/** Absolute path of a CMS media asset on the API host (public content-media route). */
export function cmsMediaUrl(mediaId: string): string {
  return `${API_BASE}/public/content-media/${encodeURIComponent(mediaId)}`;
}
