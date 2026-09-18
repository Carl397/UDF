/**
 * Shared taxonomy constants.
 *
 * Kept free of any React/shell dependency so public website pages (register,
 * confirm, QR verify) can import them without pulling in the app bundle.
 */

export const REGIONS = ['NORTH', 'SOUTH', 'EAST', 'WEST', 'CENTRAL'];

export const TIERS = ['voter', 'volunteer', 'activist', 'donor', 'candidate', 'staff'];

export const STATUSES = ['active', 'inactive', 'lapsed', 'suspended', 'pending'];

/**
 * Map colour per member tier. One source of truth for the tier swatches wherever
 * they appear (e.g. the region drill-down sheet's tier breakdown), so a swatch
 * can never disagree with the tier it stands for.
 */
export const TIER_COLORS: Record<string, string> = {
  voter: '#ef4444',
  volunteer: '#22c55e',
  activist: '#3b82f6',
  donor: '#f59e0b',
  candidate: '#a855f7',
  staff: '#64748b',
};

/** Fallback colour for a tier the palette does not know about. */
export const DEFAULT_TIER_COLOR = TIER_COLORS.voter!;

/** Every tier switched on — the "no tier filter" state of the shell filters. */
export const ALL_TIERS: string[] = [...TIERS];

/** Is every tier switched on (i.e. no tier restriction at all)? */
export function allTiersOn(tiers: readonly string[]): boolean {
  return tiers.length >= TIERS.length;
}

/**
 * The `tiers` query parameter for a visible-tier set, or `undefined` when every
 * tier is on (sending all six would be the same filter, only noisier).
 *
 * An EMPTY set is NOT "no filter" — it means the user switched everything off,
 * so callers must render an empty result instead of dropping the parameter.
 * Check `tiers.length === 0` before calling this.
 */
export function tiersParam(tiers: readonly string[]): string | undefined {
  return tiers.length === 0 || allTiersOn(tiers) ? undefined : tiers.join(',');
}

/**
 * Tiers a member may pick for themselves when joining. Mirrors the backend
 * `registerSchema` enum: `candidate` and `staff` are granted by appointment and
 * are never self-selected.
 */
export const JOIN_TIERS = [
  { value: 'voter', label: 'Supporter', hint: 'Vote with us and stay informed' },
  { value: 'volunteer', label: 'Volunteer', hint: 'Help at events and canvasses' },
  { value: 'activist', label: 'Activist', hint: 'Organize in your ward or branch' },
  { value: 'donor', label: 'Donor', hint: 'Fund the movement' },
] as const;

export type JoinTier = (typeof JOIN_TIERS)[number]['value'];

/** Capitalise a region code for display (`CENTRAL` → `Central`). */
export function prettyRegion(code: string): string {
  return code ? code[0]! + code.slice(1).toLowerCase() : code;
}

/* ── Region drill-down colours ─────────────────────────────── */

/**
 * Palette for the map's region fills.
 *
 * Ordered so that CONSECUTIVE entries are as different as possible: a region's
 * colour is a hash of its code, and neighbouring subcouncils have neighbouring
 * codes, so a palette sorted by hue would paint the whole metro in one family
 * and make the boundaries unreadable.
 *
 * These are region identities, not data — member counts drive OPACITY (and, for
 * wards, lightness), never hue, so a colour can be read as "this area" at any
 * zoom level.
 */
export const SUBCOUNCIL_COLORS: string[] = [
  '#c8102e', // red
  '#0f766e', // teal
  '#b45309', // amber
  '#4338ca', // indigo
  '#15803d', // green
  '#be185d', // magenta
  '#0369a1', // blue
  '#a16207', // olive
  '#7c3aed', // violet
  '#9f1239', // crimson
  '#0e7490', // cyan
  '#475569', // slate
];

/**
 * FNV-1a over the code, so a region keeps the SAME colour in every session, on
 * every device and across rebuilds. A palette index derived from array position
 * instead would reshuffle whenever a region is added or a filter changes the
 * returned set — which is exactly when a reader needs the colour to hold still.
 */
function hashCode(code: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h);
}

/** The fixed colour of a region (subcouncil, region or municipality). */
export function regionColor(code: string): string {
  if (!code) return SUBCOUNCIL_COLORS[0]!;
  return SUBCOUNCIL_COLORS[hashCode(code) % SUBCOUNCIL_COLORS.length]!;
}

/**
 * Mix a hex colour toward white. `amount` 0 returns the colour unchanged,
 * 1 returns pure white.
 */
export function mixWhite(hex: string, amount: number): string {
  const a = Math.min(1, Math.max(0, amount));
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const mix = (c: number) => Math.round(c + (255 - c) * a);
  return `#${((mix(r) << 16) | (mix(g) << 8) | mix(b)).toString(16).padStart(6, '0')}`;
}

/**
 * Mix a hex colour toward black. `amount` 0 returns the colour unchanged,
 * 1 returns pure black. The counterpart of `mixWhite`, used for outlines: a
 * ward's border is a darkened shade of its own subcouncil's hue, so at high
 * zoom the mosaic still reads as families rather than as 123 unrelated shapes.
 */
export function mixBlack(hex: string, amount: number): string {
  const a = Math.min(1, Math.max(0, amount));
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const mix = (c: number) => Math.round(c * (1 - a));
  return `#${((mix(r) << 16) | (mix(g) << 8) | mix(b)).toString(16).padStart(6, '0')}`;
}

/* ── FR-R: distinct per-ward colours ─────────────────────────── */

/**
 * A curated 20-colour qualitative palette for wards (FR-R2).
 *
 * A ward's colour used to be a TINT of its parent subcouncil's single hue, so
 * every ward in a subcouncil looked alike and boundaries were hard to read.
 * Drilled into a subcouncil, each ward now gets its OWN colour,
 * cycled by its index within that subcouncil. Entries are ordered so CONSECUTIVE
 * ones are as different as possible — wards are indexed by sorted code and
 * neighbouring wards have neighbouring codes, so this keeps adjacent wards
 * visually distinct. Twenty is comfortably more than any one subcouncil has
 * wards, so a drilled-in subcouncil never repeats a colour.
 *
 * These are area identities, not data: the member count still drives OPACITY, so
 * a colour reads as "this ward" at any count (FR-R5 — colours derive from region
 * codes only; counts stay the aggregate choropleth, no new PII).
 */
export const WARD_PALETTE: string[] = [
  '#c8102e', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd',
  '#17becf', '#8c564b', '#e377c2', '#bcbd22', '#3b3738',
  '#d62728', '#2874a6', '#145a32', '#b9770e', '#7d3c98',
  '#117864', '#a93226', '#7e5109', '#4a235a', '#196f3d',
];

/**
 * The distinct colour of the ward at `index` within its subcouncil (FR-R2). The
 * staff map assigns that index by sorting a subcouncil's wards by code, so the
 * colour is stable across sessions and filters — and the drill-down legend
 * (RegionSheet) reproduces it from the same sorted sibling set.
 */
export function wardColorForIndex(index: number): string {
  const i = Math.abs(Math.trunc(index)) % WARD_PALETTE.length;
  return WARD_PALETTE[i]!;
}

/**
 * A stable distinct colour from a ward's OWN code (FR-R4), for the member-
 * restricted map, which shows a single ward and so has no sibling index to cycle
 * by. Same palette as `wardColorForIndex`, so both maps share one visual
 * language; the exact hue may differ from the staff map's index-based pick, but
 * no user sees the same ward on both.
 */
export function wardColorForCode(code: string): string {
  if (!code) return WARD_PALETTE[0]!;
  return WARD_PALETTE[hashCode(code) % WARD_PALETTE.length]!;
}

/**
 * The short ward number for a label/badge, derived from its code
 * (`NORTH-W09` → `W09`). Empty when the code has no trailing segment, so a label
 * can fall back to the area name alone.
 */
export function wardNumber(code: string): string {
  if (!code) return '';
  const at = code.lastIndexOf('-');
  if (at < 0 || at === code.length - 1) return '';
  return code.slice(at + 1).trim().toUpperCase();
}
