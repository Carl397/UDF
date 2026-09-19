import type {
  ReportFilters, ReportStats, ReportAccountability, ReportFilterOptions,
  ReportTask, ReportTaskFilters, ReportTaskInput, ReportAssignee,
  AcknowledgeScorecardInput,
  Appointment,
  AppNotification,
  ApplyModerationActionInput,
  ApplyModerationActionResult,
  BannedDevice,
  BatchCardsResult,
  CardDesign,
  CardDesignView,
  CardPhoto,
  CaseStats,
  ConfirmResult,
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
  WardDetail,
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

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
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
      const res = await fetch(`${API_BASE}/auth/refresh`, {
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

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

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

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ApiClientError(res.status, err.code ?? 'error', err.message ?? res.statusText);
  }
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

// ── Auth ─────────────────────────────────────────────────────────
export const api = {
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
  rsvpEvent(id: string): Promise<PartyEvent> {
    return request(`/events/${id}/rsvp`, { method: 'POST' });
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
      const res = await fetch(`${API_BASE}/transparency/media/${mediaId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal,
      });
      if (res.ok) return res.blob();
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
    const res = await fetch(`${API_BASE}/id-card/media/${mediaId}`, {
      headers: { Authorization: `Bearer ${tokenStore.access ?? ''}` },
    });
    return res.ok ? res.blob() : null;
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
  listRatings(params?: Record<string, string>): Promise<{ items: Rating[]; total: number }> {
    return request(`/ratings${qs(params ?? {})}`);
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
  addTrackPoint(patrolId: string, payload: unknown): Promise<{ id: string }> {
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
  listVerifications(params?: Record<string, string>): Promise<{ items: Verification[]; total: number }> {
    return request(`/verifications${qs(params ?? {})}`);
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
  crmDashboard(): Promise<{
    activity: import('../types').DashboardActivity;
    activeMembers: number;
    openCases: number;
    openPetitions: number;
    openParticipations: number;
  }> {
    return request('/crm/dashboard');
  },
  crmEngagements(params?: Record<string, string>): Promise<{
    items: ServiceRequest[];
    total: number;
    limit: number;
    offset: number;
  }> {
    return request(`/crm/engagements${qs(params ?? {})}`);
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
  crmEscalations(): Promise<{ items: ServiceRequest[]; total: number }> {
    return request('/crm/escalations');
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
  getCurrentScorecard(): Promise<ScorecardCurrent> {
    return request('/scorecards/current');
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
  getScorecardInbox(
    params: { period?: string; ward?: string; status?: string; limit?: number } = {},
  ): Promise<ScorecardInbox> {
    return request(`/scorecards/inbox${qs(params)}`);
  },
  /** FR-S8: per-category averages, distribution and counts across scope. */
  getScorecardSummary(params: { period?: string; ward?: string } = {}): Promise<ScorecardSummary> {
    return request(`/scorecards/summary${qs(params)}`);
  },
  /** FR-S8: the ≤2 reasons queue — the actionable complaints across scope. */
  getScorecardLowReasons(
    params: { period?: string; ward?: string; status?: string; limit?: number } = {},
  ): Promise<ScorecardLowReasons> {
    return request(`/scorecards/low-reasons${qs(params)}`);
  },
  /** FR-S6: opening a submitted scorecard marks it `viewed`. */
  viewScorecard(id: string): Promise<ScorecardView> {
    return request(`/scorecards/${id}/view`, { method: 'POST' });
  },
  /** FR-S6: acknowledge a scorecard and notify the member. */
  acknowledgeScorecard(id: string, payload: AcknowledgeScorecardInput = {}): Promise<ScorecardView> {
    return request(`/scorecards/${id}/acknowledge`, { method: 'POST', body: JSON.stringify(payload) });
  },
};
