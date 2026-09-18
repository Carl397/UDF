/**
 * Case status + follow-up colour vocabulary.
 *
 * The single source of truth for how a service-delivery case is painted on
 * EVERY surface — the mobile Engage cases list, the Home "recent service
 * requests" strip, the CRM cases views (via `CrmBadge`) and the map's
 * RegionSheet "by status" chips. Keeping one map means a status colour can
 * never disagree between screens, which is what happened when each surface
 * hand-rolled its own `status === 'resolved' ? 'ok' : …` ternary.
 *
 * Kept free of any React/shell dependency (like `lib/taxonomy.ts`) so both the
 * app-shell tabs and the separate `/crm` route group can import it.
 *
 * ── Status colours ──────────────────────────────────────────────────────────
 * A status maps to a SEMANTIC TONE, not a raw colour, so the same vocabulary
 * drives two renderers:
 *   • mobile  → a `.badge <tone>` class (globals.css: info/warn/ok/danger, with
 *               `neutral` falling back to the plain base badge = slate);
 *   • CRM/map → a hex swatch (`STATUS_TONE_HEX`, matching the same globals.css
 *               custom properties so the two never drift).
 * The tones read as a lifecycle:
 *   info   (blue)   newly received, nothing done yet
 *   warn   (amber)  actively being worked
 *   ok     (green)  finished / confirmed finished
 *   danger (red)    needs urgent attention — escalated
 *   neutral(slate)  not a real workload state — duplicate
 *
 * ── Follow-up chips ─────────────────────────────────────────────────────────
 * The follow-up sub-state (migration 017 `sr_follow_up`) is INDEPENDENT of
 * status: a case can be `in_progress` AND `awaiting` follow-up. It paints its
 * OWN chip in deliberately different hues (violet / teal / indigo) so the two
 * signals never read as one. `none` renders no chip at all.
 */

/**
 * The 11 `sr_status` lifecycle values. Source of truth is the backend enum in
 * migration 003 (`CREATE TYPE sr_status AS ENUM (…)`); `scripts/check-caps.mjs`
 * pins this list — and every colour key below — against that enum, so a status
 * added to the DB without a colour here fails the build.
 */
export const SR_STATUSES = [
  'reported',
  'triaged',
  'logged',
  'submitted',
  'in_progress',
  'resolved',
  'verified',
  'closed',
  'escalated',
  'duplicate',
  'reopened',
] as const;
export type SrStatus = (typeof SR_STATUSES)[number];

/** The follow-up sub-state (backend migration 017 `sr_follow_up` enum). */
export const FOLLOW_UP_STATES = ['none', 'awaiting', 'done', 'engaged'] as const;
export type FollowUpState = (typeof FOLLOW_UP_STATES)[number];

/** A semantic status tone. `info/warn/ok/danger` double as `.badge` modifiers. */
export type StatusTone = 'info' | 'warn' | 'ok' | 'danger' | 'neutral';

/**
 * Canonical status → tone. `Record<SrStatus, …>` makes the compiler refuse a
 * map that misses any of the 11 statuses (a second guard, on top of check-caps).
 */
export const SR_STATUS_COLOR: Record<SrStatus, StatusTone> = {
  reported: 'info',
  triaged: 'info',
  logged: 'info',
  submitted: 'info',
  reopened: 'info',
  in_progress: 'warn',
  resolved: 'ok',
  verified: 'ok',
  closed: 'ok',
  escalated: 'danger',
  duplicate: 'neutral',
};

/** Human label per status (title-cased, underscores already split). */
export const SR_STATUS_LABEL: Record<SrStatus, string> = {
  reported: 'Reported',
  triaged: 'Triaged',
  logged: 'Logged',
  submitted: 'Submitted',
  reopened: 'Reopened',
  in_progress: 'In progress',
  resolved: 'Resolved',
  verified: 'Verified',
  closed: 'Closed',
  escalated: 'Escalated',
  duplicate: 'Duplicate',
};

/** Tone → `.badge` modifier class; `neutral` uses the plain base badge (''). */
const STATUS_TONE_BADGE: Record<StatusTone, string> = {
  info: 'info',
  warn: 'warn',
  ok: 'ok',
  danger: 'danger',
  neutral: '',
};

/**
 * Tone → hex, matching the globals.css custom properties (`--info` `#2563eb`,
 * `--warn` `#d97706`, `--ok` `#16a34a`, `--danger` `#dc2626`) plus the CRM's
 * long-standing neutral `#8a817b`. Used by `CrmBadge` and the RegionSheet
 * swatch so the CRM hex and the mobile CSS-var badge are the SAME colour.
 */
export const STATUS_TONE_HEX: Record<StatusTone, string> = {
  info: '#2563eb',
  warn: '#d97706',
  ok: '#16a34a',
  danger: '#dc2626',
  neutral: '#8a817b',
};

/** Follow-up chip tone ('' = render no chip). Distinct hues by design. */
export type FollowUpTone = 'violet' | 'teal' | 'indigo' | '';

/** Canonical follow-up → tone. */
export const FOLLOW_UP_COLOR: Record<FollowUpState, FollowUpTone> = {
  none: '',
  awaiting: 'violet',
  done: 'teal',
  engaged: 'indigo',
};

/** Human label per follow-up state ('' for none, which renders no chip). */
export const FOLLOW_UP_LABEL: Record<FollowUpState, string> = {
  none: '',
  awaiting: 'Awaiting follow-up',
  done: 'Follow-up done',
  engaged: 'Engaged',
};

/** Follow-up tone → `.badge` modifier (violet/teal/indigo; see globals.css). */
const FOLLOW_UP_TONE_BADGE: Record<Exclude<FollowUpTone, ''>, string> = {
  violet: 'violet',
  teal: 'teal',
  indigo: 'indigo',
};

/** Follow-up tone → hex (mirrors the badge tints, for CRM/swatch reuse). */
export const FOLLOW_UP_TONE_HEX: Record<Exclude<FollowUpTone, ''>, string> = {
  violet: '#7c3aed',
  teal: '#0d9488',
  indigo: '#4f46e5',
};

// ── Status helpers ─────────────────────────────────────────────────────────

function isSrStatus(v: string | null | undefined): v is SrStatus {
  return !!v && (SR_STATUSES as readonly string[]).includes(v);
}

/** The tone for a status; an unknown/absent status is treated as neutral. */
export function srStatusTone(status: string | null | undefined): StatusTone {
  return isSrStatus(status) ? SR_STATUS_COLOR[status] : 'neutral';
}

/** The `.badge …` class for a status (base `badge` when neutral/unknown). */
export function srStatusBadgeClass(status: string | null | undefined): string {
  const mod = STATUS_TONE_BADGE[srStatusTone(status)];
  return mod ? `badge ${mod}` : 'badge';
}

/** The hex swatch colour for a status (CRM badge, RegionSheet dot). */
export function srStatusHex(status: string | null | undefined): string {
  return STATUS_TONE_HEX[srStatusTone(status)];
}

/** The display label for a status; unknown values fall back to a humanised raw. */
export function srStatusLabel(status: string | null | undefined): string {
  if (isSrStatus(status)) return SR_STATUS_LABEL[status];
  return String(status ?? '').replace(/_/g, ' ');
}

// ── Follow-up helpers ──────────────────────────────────────────────────────

function isFollowUp(v: string | null | undefined): v is FollowUpState {
  return !!v && (FOLLOW_UP_STATES as readonly string[]).includes(v);
}

/**
 * The `.badge …` class for a follow-up chip, or `null` when there is nothing to
 * render (`none`, absent or unknown) — callers skip the chip entirely on null.
 */
export function followUpBadgeClass(followUp: string | null | undefined): string | null {
  if (!isFollowUp(followUp)) return null;
  const tone = FOLLOW_UP_COLOR[followUp];
  if (!tone) return null;
  return `badge ${FOLLOW_UP_TONE_BADGE[tone]}`;
}

/** The hex swatch colour for a follow-up chip, or `null` when it renders none. */
export function followUpHex(followUp: string | null | undefined): string | null {
  if (!isFollowUp(followUp)) return null;
  const tone = FOLLOW_UP_COLOR[followUp];
  return tone ? FOLLOW_UP_TONE_HEX[tone] : null;
}

/** The display label for a follow-up chip, or `null` when it renders none. */
export function followUpLabel(followUp: string | null | undefined): string | null {
  if (!isFollowUp(followUp)) return null;
  return FOLLOW_UP_LABEL[followUp] || null;
}
