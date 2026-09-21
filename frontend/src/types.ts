// Shared frontend domain types (mirror the backend's public API shapes).

export type MemberTier =
  | 'voter'
  | 'volunteer'
  | 'activist'
  | 'donor'
  | 'candidate'
  | 'staff';

export type MemberStatus =
  | 'active'
  | 'inactive'
  | 'lapsed'
  | 'suspended'
  | 'pending';

export interface Consent {
  emailOptin: boolean;
  smsOptin: boolean;
  phoneOptin: boolean;
  dataShare: boolean;
  gdprBasis?: 'consent' | 'contract' | 'legitimate_interest';
}

export interface MemberPii {
  fullName?: string;
  email?: string;
  phone?: string;
  address?: string;
}

export interface Member {
  id: string;
  membershipNo: string | null;
  tier: MemberTier;
  status: MemberStatus;
  regionCode: string | null;
  districtCode: string | null;
  lat: number | null;
  lng: number | null;
  heatWeight: number;
  tags: string[];
  /** Public QR/verify code (`UDF-XXX-XXX`) — never secret. */
  publicCode: string | null;
  ward: string | null;
  joinedAt: string | null;
  consent?: Consent | null;
  createdAt: string;
  updatedAt: string;
  pii?: MemberPii | null;
}

export interface MemberListResponse {
  items: Member[];
  total: number;
  limit: number;
  offset: number;
}

export interface GeoFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: string; coordinates: any };
    properties: Record<string, any>;
  }>;
}

/**
 * A backend permission string (`member:read`, `case:log`, …).
 *
 * Typed loosely on purpose: the server owns the vocabulary and adds to it, and
 * a new permission must not break an older client's build. `lib/caps.ts` holds
 * the subset this UI understands and is checked against the server's copy.
 */
export type Permission = string;

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  role: string;
  /** True once the user has accepted the currently-published Terms version. */
  tcAccepted: boolean;
  tcVersion: string | null;
  tcCurrentVersion: string;
  /** True when the account must set a new password before using the app. */
  mustChangePassword: boolean;
  /**
   * The caller's effective permissions, as the server will evaluate them.
   * The UI builds its capability flags from this list — see `lib/caps.ts`.
   */
  permissions: Permission[];
  /**
   * The module keys enabled for the caller's role. Permission-backed modules are
   * already reflected in `permissions` (a disabled module's permissions are
   * stripped server-side); this list exists for the UI-only surfaces that own no
   * permission (`id_cards`) and for an explicit "module disabled" empty-state.
   * See `lib/modules.ts`.
   */
  enabledModules: string[];
}

/**
 * POST /auth/refresh — a rotated token pair plus the caller's *current*
 * permissions.
 *
 * Deliberately not `LoginResponse`: refresh re-sends no role, T&C state or
 * password gate (the client keeps what login gave it). Permissions are the one
 * thing it does re-send, so an administrator's role change reaches the UI at
 * the next rotation instead of at the next sign-in.
 */
export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  permissions: Permission[];
  /** Enabled module keys, recomputed like `permissions` — see `LoginResponse`. */
  enabledModules: string[];
}

// ── Terms & Conditions ───────────────────────────────────────────
export interface TermsSection {
  heading: string;
  body: string;
}

export interface Terms {
  version: string;
  updatedAt: string;
  title: string;
  intro: string;
  sections: TermsSection[];
  acceptance: string;
}

// ── Moderation (ban/suspend ladder + device bans) ────────────────
export type ModerationActionType =
  | 'warn'
  | 'suspend'
  | 'ban'
  | 'reinstate'
  | 'device_ban'
  | 'device_unban';

export interface ModerationUser {
  id: string;
  email: string | null;
  fullName: string | null;
  role: string;
  regionCodes: string[];
  wardCode: string | null;
  isActive: boolean;
  moderationStatus: string;
  suspendedUntil: string | null;
  tcVersion: string | null;
  tcAcceptedAt: string | null;
  createdAt: string;
}

export interface ModerationActionRecord {
  id: string;
  action: string;
  reason: string;
  expiresAt: string | null;
  actorId: string | null;
  actorRole: string | null;
  deviceId: string | null;
  createdAt: string;
}

export interface ModerationAuditEntry {
  seq: number;
  action: string;
  actorId: string | null;
  actorRole: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ModerationProfile {
  user: ModerationUser;
  actions: ModerationActionRecord[];
  audit: ModerationAuditEntry[];
}

export interface BannedDevice {
  deviceId: string;
  reason: string;
  active: boolean;
  bannedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplyModerationActionInput {
  userId?: string;
  deviceId?: string;
  action: ModerationActionType;
  reason: string;
  durationDays?: number;
}

export interface ApplyModerationActionResult {
  action: string;
  userId?: string;
  deviceId?: string;
  moderationStatus?: string;
  isActive?: boolean;
  suspendedUntil?: string | null;
}

/**
 * Mirrors `backend/src/auth/permissions.ts` `Role`, in the same order.
 *
 * `ward_councillor` was missing from this union while the backend has granted it
 * for the whole life of the project. Nothing broke visibly because the only
 * producer is a cast (`payload.role as Role` in `lib/auth.tsx`) and the only
 * consumers index plain `Record<string, …>` label maps — so a councillor's
 * session carried a role string the type claimed was impossible. It surfaced the
 * moment the desktop CRM needed to name the roles it serves: `DESKTOP_ROLES`
 * could not include `'ward_councillor'` without a type error, and any
 * `role === 'ward_councillor'` comparison would have been rejected as
 * unintentional.
 */
export type Role =
  | 'superadmin'
  | 'national_admin'
  | 'regional_organizer'
  | 'local_coordinator'
  | 'ward_councillor'
  | 'analyst'
  | 'member';

// ── Engagement layer ───────────────────────────────────────────
export type EventKind =
  | 'rally'
  | 'meeting'
  | 'training'
  | 'canvass'
  | 'debate'
  | 'fundraiser'
  | 'service'
  | 'webinar';

export type EventStatus = 'scheduled' | 'live' | 'done' | 'cancelled';

export interface PartyEvent {
  id: string;
  title: string;
  kind: EventKind;
  summary: string | null;
  body: string | null;
  regionCode: string | null;
  ward: string | null;
  venue: string | null;
  lat: number | null;
  lng: number | null;
  startsAt: string;
  endsAt: string | null;
  capacity: number | null;
  rsvpCount: number;
  status: EventStatus;
  /** True when the organiser set a dedicated cover image. */
  hasCover: boolean;
  /** Whether the signed-in caller already RSVP'd 'going'. */
  going: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One RSVP on an event, as the organiser sees it in the backoffice guest list. */
export interface EventAttendee {
  name: string | null;
  membershipNo: string | null;
  ward: string | null;
  response: 'going' | 'interested';
  at: string;
}

export type PostKind =
  | 'news'
  | 'press_release'
  | 'highlight'
  | 'statement'
  | 'community_note'
  | 'service_delivery';

export interface Post {
  id: string;
  kind: PostKind;
  title: string;
  excerpt: string | null;
  body: string;
  regionCode: string | null;
  ward: string | null;
  author: string | null;
  serviceArea: string | null;
  severity: 'info' | 'report' | 'urgent' | null;
  status: 'draft' | 'published' | 'taken_down';
  takeDownReason: string | null;
  takenDownAt: string | null;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** A party office that can be held — "various roles for various types". */
export interface Position {
  code: string;
  name: string;
  level: 'national' | 'region' | 'district' | 'ward' | 'branch' | string;
  tier: string;
  description: string | null;
  termMonths: number | null;
}

export interface Appointment {
  id: string;
  memberId: string;
  positionCode: string | null;
  positionName: string | null;
  positionLevel: string | null;
  title: string | null;
  regionCode: string | null;
  ward: string | null;
  appointedBy: string | null;
  termStart: string | null;
  termEnd: string | null;
  status: 'proposed' | 'confirmed' | 'revoked';
  mandateAcceptedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  member: { membershipNo: string | null; tier: string | null; publicCode: string | null };
  verifyUrl: string | null;
}

export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  regionCode: string | null;
  broadcast: boolean;
  read: boolean;
  createdAt: string;
}

export interface PartyContacts {
  phone?: string;
  whatsapp?: string;
  email: string;
  press: string;
  website: string;
  address: string;
}

export interface PartyProfile {
  name: string;
  fullName: string;
  tagline: string;
  slogan: string;
  colors: { red: string; black: string; gold: string };
  contacts: PartyContacts;
  officeHours: string;
  joinUrl: string;
}

export interface Manifesto {
  party: PartyProfile;
  standsFor: string[];
  mission: string;
  vision: string;
  values: { name: string; text: string }[];
  pillars: { title: string; points: string[] }[];
  guide: {
    intro: string;
    structures: { level: string; body: string; role: string }[];
    memberDuties: string[];
    mandateRules: string[];
  };
}

/** Public QR verification card — no PII unless the member opted into sharing. */
export interface VerifyCard {
  membershipNo: string | null;
  publicCode: string;
  tier: MemberTier;
  status: MemberStatus;
  regionCode: string | null;
  ward: string | null;
  joinedAt: string | null;
  mandateAcceptedAt: string | null;
  confirmed: boolean;
  roles: { name: string; title: string | null; ward: string | null; status: string }[];
  contact: { fullName: string; phone?: string; email?: string } | null;
  joinUrl: string;
  vcard: string;
}

// ── Party ID Card Studio (migration 022) ─────────────────────────────────────
// Mirrors backend/src/modules/cardstudio/schemas.ts. ONE global template drives
// the whole card: physical size + export scale, palette, border, the editable
// branding wording, logo, which identity fields show (and their order), the
// optional member photo, the QR, and the batch-print sheet setup. The card as it
// looks today is exactly the all-defaults document.

/** The print/ID size presets the designer offers. `custom` uses widthMm/heightMm. */
export type SizePreset = 'id1' | 'badge' | 'a6' | 'a5' | 'a4' | 'custom';

/** The identity fields that can be shown on the card body, in a chosen order. */
export type FieldKey =
  | 'membershipNo' | 'office' | 'ward' | 'region'
  | 'status' | 'tier' | 'joinedYear' | 'publicCode';

/** One identity row: which field, its label, and whether it shows. */
export interface CardField {
  key: FieldKey;
  label: string;
  show: boolean;
}

/**
 * A normalised crop rect + zoom for a member's card photo. `x/y/w/h` are
 * fractions (0..1) of the source image; `zoom` (>= 1) scales within the crop.
 */
export interface PhotoTransform {
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number;
}

/** The member's framed card photo (resolved url + crop/zoom), or null. */
export interface CardPhoto {
  /** Bare media id — fetch via `${API_BASE}/id-card/media/${mediaId}` with the bearer token. */
  mediaId: string;
  url: string;
  transform: PhotoTransform;
}

/** The complete card design template — the studio's single source of truth. */
export interface CardDesign {
  /** Physical size + export resolution. */
  size: {
    preset: SizePreset;
    widthMm: number;
    heightMm: number;
    orientation: 'landscape' | 'portrait';
    dpi: number;
    /** Export scale, 100–1000% — the PNG raster multiplier for large prints. */
    scalePct: number;
  };
  /** Palette. Defaults reproduce the current red gradient + black flag panel. */
  colors: {
    bgFrom: string;
    bgTo: string;
    flagPanel: string;
    accent: string;
    text: string;
    muted: string;
    border: string;
  };
  /** Card border. `widthPx: 0` = none, as today. */
  border: {
    widthPx: number;
    radiusPx: number;
    style: 'solid' | 'double' | 'dashed' | 'none';
  };
  /** Editable branding wording — the "change the UDF / party line" control. */
  text: {
    orgName: string;
    partyWord: string;
    tagline: string;
    slogan: string;
    footer: string;
  };
  /** Party logo (an uploaded media asset), sized as a % of card width. */
  logo: {
    show: boolean;
    mediaId: string | null;
    widthPct: number;
    position: 'flagTop' | 'flagBottom' | 'bodyTop' | 'topRight' | 'bottomLeft';
  };
  /** Optional member photo slot; the crop/zoom itself lives per member. */
  photo: {
    show: boolean;
    shape: 'rect' | 'rounded' | 'circle';
    widthPct: number;
    position: 'left' | 'right' | 'flagTop';
  };
  /** The verify QR. On by default, bottom-right, as today. */
  qr: {
    show: boolean;
    position: 'bottomRight' | 'bottomLeft' | 'right' | 'bottomCenter';
    sizePct: number;
  };
  /** Which identity rows show, their order and their labels. */
  fields: CardField[];
  /** Batch-print sheet setup (multi-select → print N per page). */
  print: {
    paper: 'a4' | 'letter' | 'a3' | 'a6';
    perSheet: number;
    gutterMm: number;
    cutMarks: boolean;
  };
}

/** The studio's feature flags (mirror of the three migration-022 flags). */
export interface CardStudioFlags {
  designer: boolean;
  batchPrint: boolean;
  photo: boolean;
}

/** Size-preset metadata returned alongside the design (label + natural dims). */
export interface SizePresetMeta {
  label: string;
  widthMm: number;
  heightMm: number;
  orientation: 'landscape' | 'portrait';
}

/** GET /id-card/design — the national-admin editor's bootstrap payload. */
export interface CardDesignView {
  design: CardDesign;
  flags: CardStudioFlags;
  presets: Record<SizePreset, SizePresetMeta>;
  fieldKeys: FieldKey[];
}

/** POST /id-card/batch — a print run of many cards (PII is never revealed). */
export interface BatchCardsResult {
  design: CardDesign;
  cards: PartyCard[];
  skipped: Array<{ memberId: string; reason: string }>;
}

/** Authenticated view of a member's own party card (ID-card screen). */
export interface PartyCard {
  memberId: string;
  membershipNo: string | null;
  publicCode: string;
  tier: MemberTier;
  status: MemberStatus;
  regionCode: string | null;
  districtCode: string | null;
  ward: string | null;
  joinedAt: string | null;
  mandateAcceptedAt: string | null;
  roles: { name: string; title: string | null; ward: string | null; status: string }[];
  identity: { fullName?: string; phone?: string; email?: string } | null;
  party: PartyProfile;
  verifyUrl: string;
  joinUrl: string;
  vcardUrl: string;
  /** The active studio design the card is rendered from. */
  design: CardDesign;
  /** The member's framed photo, or null when none is set. */
  photo: CardPhoto | null;
}

export interface PublicMeta {
  party: PartyProfile;
  standsFor: string[];
  /**
   * The full administrative tree, flattened. `parentCode` lets a client walk
   * ward → subcouncil → region → municipality without a second call, which is
   * what powers the register form's cascading type-ahead and its auto-fill of
   * district / region when the applicant picks a ward.
   */
  regions: { code: string; name: string; level: string; parentCode?: string | null }[];
  tiers: string[];
  positions: Position[];
}

export interface RegisterResult {
  memberId: string;
  membershipNo: string;
  publicCode: string;
  status: string;
  confirmUrl: string;
  verifyUrl: string;
  joinUrl: string;
}

export interface ConfirmResult {
  kind: 'register' | 'mandate';
  membershipNo: string;
  status: string;
  mandateAccepted: boolean;
  position: string | null;
  ward: string | null;
  regionCode: string | null;
  alreadyUsed: boolean;
  verifyUrl: string;
}

// ── Service Delivery types ────────────────────────────────────────

export interface ServiceRequest {
  id: string;
  refNo: string;
  category: string;
  severity: string;
  title: string;
  description: string | null;
  status: string;
  /**
   * Independent follow-up sub-state (migration 017 `sr_follow_up`):
   * `none` | `awaiting` | `done` | `engaged`. Painted as its own chip so it
   * never collides with the status colour. Optional because the CRM's
   * `srToView` DTO predates it; the mobile `/service-requests` normaliser in
   * `lib/api.ts` always supplies it.
   */
  followUpState?: string;
  wardCode: string | null;
  /** House / stand number read off the erf (migration 017). */
  streetNumber?: string | null;
  streetAddress?: string | null;
  municipalityRef?: string | null;
  reporterMemberId: string | null;
  councillorMemberId: string | null;
  slaDueAt: string | null;
  reportCount: number;
  resolvedAt: string | null;
  verifiedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WardBulletin {
  id: string;
  wardCode: string;
  councillorMemberId: string;
  kind: string;
  title: string;
  body: string | null;
  status: string;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
  /** True when a dedicated cover image is set. */
  hasCover: boolean;
}

/** A PDF / photo / short-video file or a URL link attached to a bulletin or event. */
export interface Attachment {
  id: string;
  parentType: 'bulletin' | 'event';
  parentId: string;
  kind: 'photo' | 'video' | 'document' | 'link';
  title: string | null;
  caption: string | null;
  seq: number;
  /** Link destination (link kind only). */
  url: string | null;
  /** media_assets id (file kinds only); fetch bytes via `attachmentFileBlob`. */
  mediaId: string | null;
  contentType: string | null;
  createdAt: string;
}

/**
 * A ward candidate on the public "Meet our ward councillors" roster. Managed in
 * the CRM by website-content owners and published to the marketing homepage, so
 * it carries no territory scope.
 */
export interface WardCandidate {
  id: string;
  fullName: string;
  /** Optional position label shown under the name (blank by default). */
  roleLabel: string;
  /** Ward coverage label, e.g. "39 wards". */
  wardsLabel: string;
  bio: string;
  hasPhoto: boolean;
  sortOrder: number;
  isActive: boolean;
}

export interface WardCandidateInput {
  fullName: string;
  roleLabel?: string;
  wardsLabel?: string;
  bio?: string;
  sortOrder?: number;
  isActive?: boolean;
}

export interface Participation {
  id: string;
  title: string;
  subject: string | null;
  body: string | null;
  scope: string;
  wardCode: string | null;
  regionCode: string | null;
  opensAt: string;
  closesAt: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface Petition {
  id: string;
  title: string;
  body: string | null;
  target: string;
  scope: string;
  wardCode: string | null;
  regionCode: string | null;
  opensAt: string | null;
  closesAt: string | null;
  signatureGoal: number | null;
  status: string;
  signatureCount: number;
}

export interface Rating {
  id: string;
  targetType: string;
  targetId: string;
  memberId: string;
  rating: number;
  reason: string | null;
  createdAt: string;
}

export interface Patrol {
  id: string;
  councillorMemberId: string;
  wardCode: string | null;
  mode: string;
  purpose: string | null;
  status: string;
  /** FR-E visibility tier: `public` | `members` | `private`. */
  visibility?: string;
  startedAt: string | null;
  endedAt: string | null;
    distanceM: number | null;
  distanceSource?: 'gps' | 'manual' | null;
  nextTrackSeq?: number;
  trackPointCount?: number;
  summary: string | null;
  /** Attachments on the overview report (photo/video/voice note). */
  mediaCount?: number;
  /** The overview report's attachments, hydrated by `getPatrol` only. */
  media?: ResidentReportMedia[];
  /**
   * GPS-derived wards the track passed through, hydrated by `getPatrol` only.
   * `crossing` marks a ward other than the patrol's own — the patrol walked
   * over into a neighbour's territory, which is what "live in another ward" is.
   */
  wardEntries?: PatrolWardEntry[];
  createdAt: string;
  updatedAt: string;
}

/** A ward a patrol's GPS track was resolved into, with first/last sighting. */
export interface PatrolWardEntry {
  wardCode: string;
  wardName: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  pointCount: number;
  crossing: boolean;
}

/** Response of POST /patrols/:id/track-points — the fix echo + its ward. */
export interface TrackPointResult {
  id: string;
  wardCode: string | null;
  wardName: string | null;
}

export interface PatrolStop {
  id: string;
  patrolId: string;
  title: string | null;
  note: string | null;
  callStatus: 'call_logged' | 'in_progress' | 'waiting_on_feedback' | 'completed';
    contactMethod?: string | null;
    followUpAt?: string | null;
    completedAt?: string | null;
  streetAddress: string | null;
  photoId: string | null;
  arrivedAt: string;
}

export interface Verification {
  id: string;
  serviceRequestId: string;
  memberId: string;
  verdict: string;
  note: string | null;
  photoId: string | null;
  createdAt: string;
}

export interface Project {
  id: string;
  title: string;
  description: string | null;
  scope: string;
  wardCode: string | null;
  regionCode: string | null;
  stage: string;
  progressPct: number | null;
  budget: number | null;
  owner: string | null;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  title: string;
  dueDate: string | null;
  completedAt: string | null;
  status: string;
  seq: number;
}

export interface HeatmapPoint {
  latitude: number;
  longitude: number;
  category: string;
  count: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
}

// ── Ward transparency & accountability (PRD Phase 4.5) ────────────────
export interface WardRef {
  code: string;
  name: string;
}

export interface CouncillorRef {
  memberId: string | null;
  fullName: string;
  bio: string | null;
  contactPublic: Record<string, unknown>;
  /**
   * media_assets id of the published profile photo. Served to anyone (no auth)
   * from `GET /api/public/media/:id`, which only answers for media attached to
   * an `is_public` leader row.
   */
  photoId: string | null;
}

/** FR-C: PII-free aggregate overview for any ward. */
export interface WardOverview {
  ward: WardRef;
  councillor: CouncillorRef | null;
  vacant: boolean;
  /**
   * Did UDF stand a candidate in this ward at LGE2026? `vacant` alone cannot
   * tell a seat that is waiting to be filled from a ward the party never
   * contested, and those are two different sentences to put on screen. Read it
   * with `=== false`, never as a truthy test: a server older than this field
   * sends nothing, and "unknown" must fall back to the neutral wording.
   */
  contested: boolean;
  patrols30d: number;
  patrols90d: number;
  casesActive: number;
  casesResolved: number;
  privateLogs: number;
  projectsActive: number;
  projectsDelivered: number;
  bulletins: number;
  ratingMean: number | null;
  ratingCount: number;
}

/** FR-B: geolocation ward + councillor lookup result. */
export interface WardLookupResult {
  ward: WardRef;
  accuracyM: number | null;
  accurate: boolean;
  councillor: CouncillorRef | null;
  vacant: boolean;
  contested: boolean;
  overview: WardOverview;
}

/** `GET /api/transparency/reverse-geocode` — street + area for the location box. */
export interface ReverseGeocodeResult {
  ward: WardRef | null;
  street: string | null;
  suburb: string | null;
  area: string | null;
  label: string | null;
  city: string | null;
  postcode: string | null;
  /** House number, road, suburb, city and postcode as one line. */
  fullAddress: string | null;
}

/* ── Map region drill-down (`GET /api/geo/region-summary`) ─── */

/** A published councillor as the drill-down sheet shows them. */
export interface RegionCouncillor extends CouncillorRef {
  /** `positions.name`, e.g. "Ward Councillor". */
  position: string | null;
}

/** One child of the inspected region (a subcouncil's wards, a region's subcouncils). */
export interface RegionChild {
  code: string;
  name: string;
  level: string;
  members: number;
  councillor: RegionCouncillor | null;
  /** Ward rows only: was this ward contested by UDF at LGE2026? See WardOverview. */
  contested: boolean;
}

/**
 * Ward case counters. The four partition the caseload — `open` excludes
 * `inProgress` — so they can be shown side by side without adding up oddly.
 */
export interface WardServiceDelivery {
  open: number;
  inProgress: number;
  resolved: number;
  slaBreached: number;
}

export interface WardProject {
  id: string;
  title: string;
  stage: string;
  progressPct: number | null;
}

/**
 * Everything the map's tap-a-shape sheet shows about ONE region.
 *
 * Counts are already narrowed by the caller's tier/status filters AND by the
 * principal's territory, so a councillor drilling into a neighbouring ward sees
 * zeros rather than data. `ward`, `serviceDelivery` and `projects` are set only
 * for a ward and are the same PII-free aggregates the public website publishes.
 */
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
  ward: WardOverview | null;
  serviceDelivery: WardServiceDelivery | null;
  projects: WardProject[];
}

/* ── Wave 4: restricted member map (`GET /api/geo/my-ward`) ─── */

/** One administrative shape as the member map returns it: code, name, GeoJSON. */
export interface MyWardBoundary {
  code: string;
  name: string;
  /** GeoJSON geometry (same shape as a boundary feature), or null if unmapped. */
  geom: { type: string; coordinates: any } | null;
}

/**
 * The caller's OWN ward only — the restricted map a member (`geo:read_own_ward`)
 * receives: their subcouncil and ward shapes plus the PII-free ward drill-down
 * (councillor bio, service-delivery progress, published projects). Carries no
 * member points, choropleth, tier analytics or cross-ward content; the ward is
 * the leaf, so `summary.children` is always empty here.
 */
export interface MyWard {
  subcouncil: MyWardBoundary | null;
  ward: MyWardBoundary;
  summary: RegionSummary;
}

/* ── Static map case counts (`GET /api/geo/case-stats`) ─── */

/**
 * The three bars the static map draws, for one area.
 *
 * `open` and `resolved` use the same status buckets as `WardOverview`'s
 * `casesActive` / `casesResolved`, so the map and the ward page cannot report
 * different totals for the same ward. `followUps` counts cases whose follow-up
 * is still outstanding (awaiting or engaged), not every case ever followed up.
 */
export interface AreaCaseStats {
  code: string;
  open: number;
  resolved: number;
  followUps: number;
}

/** Counts for every area of all three map layers, keyed by layer. */
export interface CaseStats {
  region: AreaCaseStats[];
  subcouncil: AreaCaseStats[];
  ward: AreaCaseStats[];
}

export interface StageMedia {
  stage: 'before' | 'during' | 'after';
  mediaId: string;
  contentType: string;
  caption: string | null;
}

/** A captured attachment on a resident → councillor report. */
export interface ResidentReportMedia {
  mediaId: string;
  contentType: string;
  captureMode: 'photo' | 'video' | 'voice_note' | 'audio' | string;
}

export interface ReportActionInput {
  action?: 'acknowledge' | 'contact' | 'follow_up' | 'resolve' | 'confirm' | 'request_follow_up' | 'reopen' | 'close';
  status?: string;
  feedback?: string | null;
  contactMethod?: 'phone' | 'email' | 'sms' | 'whatsapp' | 'in_person' | 'service_portal' | 'other';
  contactTarget?: string;
  contactMethodDetail?: string;
  internalNote?: string;
  externalReference?: string;
  referenceKind?: 'service_provider' | 'c3';
  c3Requirement?: 'needs_assessment' | 'required' | 'not_required';
  c3Reason?: string | null;
  followUpAt?: string | null;
  expectedVersion?: number;
  requestId?: string;
}
export interface ReportEvent {
  actorName?: string;
  metadata?: { c3Requirement?: string; c3Reason?: string | null; referenceKind?: string };
  id: string; action: string; actorRole: string | null; note: string | null;
  contactMethod: string | null; fromStatus: string | null; toStatus: string | null;
  followUpAt: string | null; createdAt: string;
  contactTarget?: string | null;
  contactMethodDetail?: string | null;
  internalNote?: string | null;
}
export interface MediaPolicy { photo: boolean; video: boolean; voice: boolean }
export interface ActivityModuleStats {
  total: number;
  byStatus: { label: string; value: number }[];
  byCategory: { label: string; value: number }[];
  byWard: { label: string; value: number }[];
  dailyCreated: { label: string; value: number }[];
  recent: { id: string; status: string; wardCode: string | null; updatedAt: string }[];
  overdue?: number; unassigned?: number; medianAcknowledgeHours?: number | null; acknowledgedSample?: number;
  distanceM30d?: number | null; completed30d?: number; unknownDistance30d?: number; outstandingStops?: number;
}
export interface DashboardActivity {
  asOf: string; periodDays: number; timezone: string;
  modules: Record<'reports' | 'cases' | 'patrols', ActivityModuleStats | null>;
}

/** A resident report to the ward councillor (private to author + ward staff). */
export interface ResidentReport {
  wardName?: string | null;
  councillorId?: string | null;
  councillorName?: string | null;
  assignmentState?: 'active' | 'inactive' | 'moved' | 'missing' | 'unassigned';
  acknowledgment?: 'yes' | 'no' | 'unknown';
  acknowledgedBy?: string | null;
  acknowledgedByName?: string | null;
  councillorAcknowledged?: boolean;
  lastActionAt?: string | null;
  councillorActionAt?: string | null;
  openTasks?: number;
  nextDueAt?: string | null;
  c3Requirement?: 'needs_assessment' | 'required' | 'not_required';
  c3Reason?: string | null;
  referenceKind?: 'service_provider' | 'c3';
  hasC3?: boolean;
  id: string;
  refNo: string;
  category: string;
  message: string;
  wardCode: string | null;
  status: 'submitted' | 'acknowledged' | 'in_progress' | 'resolved' | 'closed' | string;
  version?: number;
  externalReference?: string | null;
  referenceMasked?: boolean;
  acknowledgedAt?: string | null;
  resolvedAt?: string | null;
  confirmedAt?: string | null;
  followUpAt?: string | null;
  assigned?: boolean;
  canManage?: boolean;
  isOwner?: boolean;
  canSetReference?: boolean;
  events?: ReportEvent[];
  /** Follow-up note staff write back to the resident (null until answered). */
  feedback?: string | null;
  respondedAt?: string | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  media: ResidentReportMedia[];
  createdAt: string;
}

export interface ReportFilters {
  search?: string; category?: string; status?: string; ward?: string; councillor?: string;
  acknowledged?: string; actionTaken?: string; c3?: string; assignee?: string; overdue?: string;
  from?: string; to?: string; sort?: string; direction?: string;
}
export interface ReportStats {
  total: number; open: number; unacknowledged: number; unknownAcknowledgment: number;
  noAction: number; missingC3: number; overdue: number;
}
export interface ReportAccountability extends ReportStats {
  wardCode: string | null; wardName: string | null; councillorId: string | null; councillorName: string | null;
  assignmentState: string; councillorAcknowledged: number; councillorActions: number;
}
export interface ReportFilterOptions {
  taskAssignees?: { id: string; name: string }[];
  categories: string[]; wards: { code: string; name: string }[]; councillors: { id: string; name: string }[];
}
export interface ReportAssignee { id: string; name: string; role: string; isMe: boolean }
export interface ReportTask {
  id: string; reportId: string; refNo: string; wardCode: string | null; wardName: string | null;
  title: string; instructions: string | null; assigneeId: string | null; assigneeName: string | null;
  assigneeEligible: boolean; isMine: boolean; canManage: boolean; dueAt: string;
  status: 'todo' | 'in_progress' | 'done' | 'cancelled'; outcome: string | null;
  version: number; createdAt: string; completedAt: string | null;
  events: { id: string; action: string; actorName: string; outcome: string | null; createdAt: string }[];
}
export interface ReportTaskInput {
  title?: string; instructions?: string | null; assigneeId?: string | null; dueAt?: string;
  status?: ReportTask['status']; outcome?: string; expectedVersion?: number; requestId: string;
}
export interface ReportTaskFilters {
  reportId?: string; assignee?: string; status?: string; overdue?: string; sort?: string; direction?: string;
}

export interface CreateResidentReportInput {
  requestId?: string;
  category: string;
  message: string;
  lat?: number;
  lng?: number;
  accuracyM?: number;
  wardCode?: string;
  media?: Array<{ dataUrl: string; captureMode: 'photo' | 'video' | 'voice_note' | 'audio' }>;
}

export interface CreateResidentReportResult {
  id: string;
  refNo: string;
  status: string;
  wardCode: string | null;
  mediaCount: number;
  routed: boolean;
}

/** FR-D: member-gated ward detail. */
export interface WardDetail {
  ward: WardRef;
  patrols: Array<{
    id: string;
    date: string | null;
    mode: string;
    purpose: string | null;
    status: string;
    distanceM: number | null;
    remarks: string | null;
    ratingMean: number | null;
    ratingCount: number;
  }>;
  projects: Array<{
    id: string;
    title: string;
    stage: string;
    progressPct: number | null;
    media: StageMedia[];
    ratingMean: number | null;
    ratingCount: number;
  }>;
  logs: Array<{
    id: string;
    refNo: string;
    category: string;
    severity: string;
    title: string;
    status: string;
    createdAt: string;
    resolvedAt: string | null;
    media: Array<{ mediaId: string; contentType: string }>;
    ratingMean: number | null;
    ratingCount: number;
  }>;
}

// ── Ward job-interest register & opportunity relay (PRD-jobs) ───────────
/** A work-type taxonomy entry (national-owned). */
export interface WorkType {
  code: string;
  label: string;
}

/**
 * FR-K: a member's OWN job-interest row. This is the only place personal data
 * (name + email) is ever returned — and only to its owner. No CV / document.
 */
export interface JobInterest {
  id: string;
  firstName: string;
  surname: string;
  email: string;
  workTypes: string[];
  experience: string | null;
  wardCode: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertJobInterestInput {
  firstName: string;
  surname: string;
  email: string;
  workTypes: string[];
  experience?: string;
}

/** FR-M4: delivery counters only — never recipient rows. */
export interface OpportunityStats {
  matched: number;
  notifiedInapp: number;
  emailed: number;
  emailFailed: number;
}

/** FR-M: a recorded work opportunity / advert. */
export interface JobOpportunity {
  id: string;
  refNo: string;
  wardCode: string;
  regionCode: string | null;
  title: string;
  company: string;
  workTypes: string[];
  description: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactUrl: string | null;
  projectId: string | null;
  status: string;
  publishedAt: string | null;
  closesAt: string | null;
  createdAt: string;
  /** Present for staff only; omitted from member-facing lists. */
  stats?: OpportunityStats;
}

export interface CreateJobOpportunityInput {
  title: string;
  company: string;
  workTypes: string[];
  description?: string;
  contactEmail?: string;
  contactPhone?: string;
  contactUrl?: string;
  projectId?: string;
  wardCode?: string;
  closesAt?: string;
}

/** FR-L: aggregate, PII-free ward work-demand. */
export interface JobDemand {
  scope: string[] | 'all';
  total: number;
  availableNow: number;
  byWorkType: Array<{ code: string; label: string; count: number }>;
  trend: Array<{ day: string; count: number }>;
}

/** FR-L4: anonymous public "people looking for work" count for a ward. */
export interface JobPublicCount {
  wardCode: string;
  peopleLookingForWork: number;
}

/** FR-N4: a work-type taxonomy row for the national-admin editor. */
export interface WorkTypeAdmin {
  code: string;
  label: string;
  active: boolean;
  sort: number;
}

/** Create/update a work type. `label` is required when the code is new. */
export interface UpsertWorkTypeInput {
  label?: string;
  active?: boolean;
  sort?: number;
}

/** §9.7: public feature-flag booleans used to gate the jobs UI client-side. */
export interface JobsFlags {
  register: boolean;
  relay: boolean;
  publicCount: boolean;
}

/** FR-N4: national-admin jobs configuration (flags + relay template + windows). */
export interface JobsAdminConfig {
  flags: JobsFlags;
  relayEmailSubject: string;
  relayEmailBody: string;
  demandStaleDays: number;
  duplicateGuardDays: number;
}

/** Partial update payload for the jobs admin config. */
export interface UpdateJobsConfigInput {
  flags?: Partial<JobsFlags>;
  relayEmailSubject?: string;
  relayEmailBody?: string;
  demandStaleDays?: number;
  duplicateGuardDays?: number;
}

// ── Module registry (admin-editable per-role feature gates) ───────────────
/** One module in the registry, as `GET /api/crm/modules` returns it. */
export interface ModuleRegistryEntry {
  key: string;
  label: string;
  description: string | null;
  sort: number;
  /** The permissions this module owns (empty for the UI-only `id_cards`). */
  permissions: string[];
}

/**
 * The full registry with the per-role gate matrix, for the CRM → Settings →
 * Module registry editor. `gates[role][moduleKey]` is the effective enabled
 * state (default true for an applicable-but-untoggled cell); `applicable[role]`
 * lists the modules that role could hold at all, so the editor renders a switch
 * only for those cells.
 */
export interface ModuleRegistry {
  modules: ModuleRegistryEntry[];
  roles: string[];
  applicable: Record<string, string[]>;
  gates: Record<string, Record<string, boolean>>;
}

// ── Recruitment genealogy (PRD-growth FR-O) ────────────────────────────────
// PII-FREE by construction: nodes/rows speak in member PUBLIC CODES, tiers,
// statuses, wards, join dates and aggregate counts. The only human name is a
// PUBLIC ward-councillor `displayName` from the published leaders directory —
// never a sealed `fullName`/`email` (AC-O2).

/** FR-O2: the caller's own reference number, join link and QR payload. */
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

/** FR-O4: one node in a recruitment subtree. */
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

/** FR-O4: a depth-capped, scope-checked recruitment subtree. */
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

/** FR-O5: one hop on the path from a member up to the first source. */
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

/** FR-O5: trace one member up to the root source of their branch. */
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

/** FR-O6: one ranked originator row in the recruitment report. */
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

/** FR-O6: the ranked recruitment report (ward councillors first). */
export interface ReportView {
  scope: 'ward' | 'region' | 'national';
  wardFilter: string | null;
  /** Totals over the returned (limited) rows. */
  totals: { originators: number; councillors: number; direct: number; downline: number };
  rows: ReportRow[];
}

// ── Councillor performance scorecards (PRD-growth FR-S) ────────────────────
// PII-FREE by construction (mirrors FR-O / AC-O2): a submission is attributed to
// a member internally, but the councillor/staff inbox reveals the member only as
// their PUBLIC CODE and only when they opted into `shareName` (FR-S7). The
// reasons — not the author — are the actionable content. No sealed name/email
// ever crosses this contract.

/** FR-S1: one active rating category (national-owned taxonomy, display order). */
export interface ScorecardCategory {
  code: string;
  label: string;
  position: number;
}

/** The public ward councillor a member rates (from the transparency directory). */
export interface ScorecardCouncillor {
  memberId: string;
  fullName: string;
  photoId: string | null;
}

/** One category's score plus its conditionally-compulsory reason (FR-S1/S3). */
export interface ScorecardItem {
  category: string;
  score: number;
  reason: string | null;
}

/** A saved scorecard (the member's own view, or a staff inbox row's detail). */
export interface ScorecardView {
  id: string;
  /** `'YYYY-MM-01'` — the calendar month this scorecard covers. */
  period: string;
  status: string;
  wardCode: string;
  councillorMemberId: string | null;
  shareName: boolean;
  ackNote: string | null;
  ackAt: string | null;
  viewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: ScorecardItem[];
}

/** Why a member cannot rate this month (FR-S5). */
export type ScorecardIneligibleReason = 'no_member' | 'no_ward' | 'vacant_seat' | 'self';

/** FR-S4: the member's current-month card — eligibility, status, categories. */
export interface ScorecardCurrent {
  eligible: boolean;
  reason: ScorecardIneligibleReason | null;
  /** Human-readable cause when ineligible, so the card can explain the vacancy. */
  message: string | null;
  ward: string | null;
  councillor: ScorecardCouncillor | null;
  period: string;
  status: 'not_rated' | 'submitted' | 'viewed' | 'acknowledged';
  scorecardId: string | null;
  /** True once acknowledged — the month's card is frozen (FR-S2). */
  frozen: boolean;
  ackNote: string | null;
  /** FR-S7: the member's saved opt-in, so a re-edit within the month keeps it. */
  shareName: boolean;
  categories: ScorecardCategory[];
  items: ScorecardItem[];
}

/** FR-S2: the member's own scorecards across previous months. */
export interface ScorecardHistory {
  scorecards: ScorecardView[];
}

/** FR-S6/S7: one row in the councillor/staff acknowledgement inbox. */
export interface ScorecardInboxRow {
  id: string;
  period: string;
  status: string;
  wardCode: string;
  wardName: string | null;
  councillorMemberId: string | null;
  shareName: boolean;
  /** FR-S7: the member's public code, revealed ONLY when they opted in. */
  memberPublicCode: string | null;
  submittedAt: string;
  viewedAt: string | null;
  ackAt: string | null;
  ackNote: string | null;
  average: number | null;
  /** Count of categories scored ≤2 (the actionable complaints on this card). */
  lowCount: number;
  items: ScorecardItem[];
}

export interface ScorecardInbox {
  period: string;
  scope: 'ward' | 'region' | 'national';
  wardFilter: string | null;
  rows: ScorecardInboxRow[];
}

/** FR-S8: one category's rollup across the caller's scope. */
export interface ScorecardCategorySummary {
  category: string;
  label: string;
  position: number;
  count: number;
  average: number | null;
  /** Score histogram, keys `'1'`..`'5'`. */
  distribution: Record<string, number>;
  lowCount: number;
}

export interface ScorecardSummary {
  period: string;
  scope: 'ward' | 'region' | 'national';
  wardFilter: string | null;
  scorecards: number;
  overallAverage: number | null;
  categories: ScorecardCategorySummary[];
}

/** FR-S8: one ≤2 reason in the actionable-complaints queue. */
export interface ScorecardLowReasonRow {
  scorecardId: string;
  category: string;
  label: string;
  score: number;
  reason: string | null;
  wardCode: string;
  wardName: string | null;
  period: string;
  status: string;
  shareName: boolean;
  memberPublicCode: string | null;
}

export interface ScorecardLowReasons {
  period: string;
  scope: 'ward' | 'region' | 'national';
  wardFilter: string | null;
  rows: ScorecardLowReasonRow[];
}

/** FR-S1: the active category taxonomy for the CRM editor. */
export interface ScorecardCategories {
  categories: ScorecardCategory[];
}

// ── Scorecard inputs ───────────────────────────────────────────────────────

/** One category's score + reason on the way in (FR-S1/S3). */
export interface ScorecardItemInput {
  category: string;
  score: number;
  reason?: string | null;
}

/**
 * FR-S2/S3: submit or update THIS month's scorecard. The month is derived
 * server-side; a re-submit updates the month's row until it is acknowledged.
 */
export interface SubmitScorecardInput {
  items: ScorecardItemInput[];
  /** FR-S7: reveal my membership reference to the councillor so they can follow up. */
  shareName?: boolean;
}

/** FR-S6: acknowledge a submission, with an optional short note back to the member. */
export interface AcknowledgeScorecardInput {
  note?: string | null;
}
