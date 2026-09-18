import { z } from 'zod';

/**
 * Party ID Card Studio — the card design contract (migration 022).
 *
 * ONE global template (`id_card_design` row `id='default'`) describes the whole
 * card: physical size + export scale, palette, border, the editable branding
 * wording, logo, which identity fields show and in what order, the optional
 * member photo and QR placement, and the batch-print sheet setup. The card as it
 * looks TODAY is exactly the all-defaults document, so applying this migration
 * changes nothing until a national administrator edits the template.
 *
 * Every field carries a Zod `.default()`, which does two jobs: `parse({})`
 * yields the complete classic card, and re-parsing a stored config back-fills any
 * field added by a later release — so an older row never renders a card missing a
 * new control. The frontend mirrors these shapes in `types.ts` (`CardDesign`).
 */

// ── Physical size presets (width × height in mm, at natural orientation) ──────
/** The print/ID sizes the designer offers. `custom` falls back to widthMm/heightMm. */
export const SIZE_PRESETS = {
  id1: { label: 'ID-1 card (85.6 × 54 mm)', widthMm: 85.6, heightMm: 54, orientation: 'landscape' },
  badge: { label: 'Event badge (100 × 148 mm)', widthMm: 100, heightMm: 148, orientation: 'portrait' },
  a6: { label: 'A6 (105 × 148 mm)', widthMm: 105, heightMm: 148, orientation: 'portrait' },
  a5: { label: 'A5 (148 × 210 mm)', widthMm: 148, heightMm: 210, orientation: 'portrait' },
  a4: { label: 'A4 (210 × 297 mm)', widthMm: 210, heightMm: 297, orientation: 'portrait' },
  custom: { label: 'Custom', widthMm: 85.6, heightMm: 54, orientation: 'landscape' },
} as const;
export type SizePreset = keyof typeof SIZE_PRESETS;

/** The identity fields that can be shown on the card body, in a chosen order. */
export const FIELD_KEYS = [
  'membershipNo', 'office', 'ward', 'region', 'status', 'tier', 'joinedYear', 'publicCode',
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

/** A 3/6/8-digit hex colour (8-digit carries alpha, used for the muted text). */
const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'must be a hex colour');

const cardField = z.object({
  key: z.enum(FIELD_KEYS),
  label: z.string().trim().max(40),
  show: z.boolean(),
});

export const cardDesignSchema = z.object({
  /** Physical size + export resolution. `scalePct` is the "up to 1000%" zoom the
   *  PNG export multiplies the raster by, for crisp large-format prints. */
  size: z.object({
    preset: z.enum(['id1', 'badge', 'a6', 'a5', 'a4', 'custom']).default('id1'),
    widthMm: z.number().min(20).max(600).default(85.6),
    heightMm: z.number().min(20).max(600).default(54),
    orientation: z.enum(['landscape', 'portrait']).default('landscape'),
    dpi: z.number().int().min(72).max(1200).default(300),
    scalePct: z.number().int().min(100).max(1000).default(100),
  }).default({}),

  /** Palette. Defaults reproduce the current red gradient + black flag panel. */
  colors: z.object({
    bgFrom: hexColor.default('#c8102e'),
    bgTo: hexColor.default('#7c0a1b'),
    flagPanel: hexColor.default('#141414'),
    accent: hexColor.default('#f7c31d'),
    text: hexColor.default('#ffffff'),
    muted: hexColor.default('#ffffff9e'),
    border: hexColor.default('#00000000'),
  }).default({}),

  /** Card border. `widthPx: 0` = none, as today. */
  border: z.object({
    widthPx: z.number().min(0).max(80).default(0),
    radiusPx: z.number().min(0).max(160).default(18),
    style: z.enum(['solid', 'double', 'dashed', 'none']).default('none'),
  }).default({}),

  /** Editable branding wording — the "change the UDF / party line" control. An
   *  empty `footer` derives the verify line from the public code + website. */
  text: z.object({
    orgName: z.string().trim().max(24).default('UDF'),
    partyWord: z.string().trim().max(24).default('PARTY'),
    tagline: z.string().trim().max(80).default('ONE FLAG · ONE MOVEMENT'),
    slogan: z.string().trim().max(80).default('SERVICE BEFORE SELF'),
    footer: z.string().trim().max(140).default(''),
  }).default({}),

  /** Party logo (an uploaded media asset), sized as a % of card width. */
  logo: z.object({
    show: z.boolean().default(false),
    mediaId: z.string().uuid().nullable().default(null),
    widthPct: z.number().min(2).max(100).default(18),
    position: z.enum(['flagTop', 'flagBottom', 'bodyTop', 'topRight', 'bottomLeft']).default('flagTop'),
  }).default({}),

  /** Optional member photo slot; the crop/zoom itself lives per member. */
  photo: z.object({
    show: z.boolean().default(false),
    shape: z.enum(['rect', 'rounded', 'circle']).default('rounded'),
    widthPct: z.number().min(5).max(60).default(22),
    position: z.enum(['left', 'right', 'flagTop']).default('right'),
  }).default({}),

  /** The verify QR. On by default, bottom-right, as today. */
  qr: z.object({
    show: z.boolean().default(true),
    position: z.enum(['bottomRight', 'bottomLeft', 'right', 'bottomCenter']).default('bottomRight'),
    sizePct: z.number().min(8).max(50).default(23),
  }).default({}),

  /** Which identity rows show, their order and their labels. The member's NAME is
   *  always the header and is not part of this list. */
  fields: z.array(cardField).max(12).default([
    { key: 'membershipNo', label: 'Membership', show: true },
    { key: 'office', label: 'Office', show: true },
    { key: 'ward', label: 'Ward', show: true },
    { key: 'region', label: 'Region', show: true },
    { key: 'status', label: 'Status', show: true },
  ]),

  /** Batch-print sheet setup (multi-select → print N per page). */
  print: z.object({
    paper: z.enum(['a4', 'letter', 'a3', 'a6']).default('a4'),
    perSheet: z.number().int().min(1).max(64).default(8),
    gutterMm: z.number().min(0).max(40).default(4),
    cutMarks: z.boolean().default(true),
  }).default({}),
});
export type CardDesign = z.infer<typeof cardDesignSchema>;

/** The complete classic card: what `getDesign()` returns before any admin edit. */
export const DEFAULT_CARD_DESIGN: CardDesign = cardDesignSchema.parse({});

// ── Per-member photo (crop/zoom) ──────────────────────────────────────────────
/**
 * A normalised crop rect + zoom. `x/y/w/h` are fractions (0..1) of the source
 * image; `zoom` (>= 1) scales within the crop. All-zero/absent = use the whole
 * image. Stored on `member_card_photos.transform`.
 */
export const photoTransformSchema = z.object({
  x: z.number().min(0).max(1).default(0),
  y: z.number().min(0).max(1).default(0),
  w: z.number().min(0).max(1).default(1),
  h: z.number().min(0).max(1).default(1),
  zoom: z.number().min(1).max(8).default(1),
}).default({});
export type PhotoTransform = z.infer<typeof photoTransformSchema>;

/**
 * Set a member's card photo: a base64 data-url (stored via the CRM media
 * pipeline) plus the crop/zoom transform. `dataUrl` is optional so an existing
 * photo's framing can be adjusted without re-uploading.
 */
export const setPhotoBody = z.object({
  dataUrl: z.string().trim().min(1).max(12_000_000).optional(),
  transform: photoTransformSchema.optional(),
});
export type SetPhotoBody = z.infer<typeof setPhotoBody>;

// ── Route params / bodies ─────────────────────────────────────────────────────
/** `{ memberId }` path param for the per-member photo routes. */
export const memberIdParam = z.object({
  memberId: z.string().trim().uuid(),
});
export type MemberIdParam = z.infer<typeof memberIdParam>;

/**
 * Batch print: the member ids to render. Bounded so one call cannot fan out into
 * an unbounded card build; PII is NEVER revealed in a batch (the service forces
 * `withPii=false`), so a batch print cannot bulk-decrypt sealed identity.
 */
export const batchBody = z.object({
  memberIds: z.array(z.string().trim().uuid()).min(1).max(200),
});
export type BatchBody = z.infer<typeof batchBody>;
