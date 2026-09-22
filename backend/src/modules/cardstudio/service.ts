import { query } from '../../db/pool.js';
import { ApiError, publicErrorMessage } from '../../http/errors.js';
import { Permission, roleHasPermission, type Principal } from '../../auth/permissions.js';
import { principalSeesMember } from '../../auth/scope.js';
import { recordAudit } from '../../security/audit.js';
import { openRecord } from '../../security/encryption.js';
import { ensurePublicCode, joinUrl, publicUrl } from '../memberships/service.js';
import { PARTY_PROFILE } from '../public/content.js';
import { storeAvatar, loadMediaBuffer } from '../crm/mediaService.js';
import {
  cardDesignSchema,
  DEFAULT_CARD_DESIGN,
  photoTransformSchema,
  type CardDesign,
  type PhotoTransform,
} from './schemas.js';

/**
 * Party ID Card Studio service (migration 022).
 *
 * Owns three things the hardcoded card could not do:
 *   1. the global card DESIGN (size/scale, palette, border, editable wording,
 *      logo, field order, photo + QR placement, print sheet) — read by every
 *      card render, written only by a national admin (`module:manage`);
 *   2. the per-member card PHOTO with its crop/zoom transform; and
 *   3. `buildPartyCard`, the single card builder both the member's own card
 *      endpoint and the batch-print run share (extracted verbatim from
 *      `public/routes.ts` so the two can never drift), now carrying the design
 *      and the photo alongside the identity fields.
 *
 * SCOPING is unchanged from the extracted logic: a card is built only for a
 * member the caller can see (`principalSeesMember`, the same ward-level rule as
 * the members list), and sealed identity is revealed only with `member:pii_decrypt`
 * and only for a SINGLE card — a batch run forces `withPii=false` so it can never
 * bulk-decrypt. Card media (logo, photo) is served on a `member:read`-gated path
 * (`/api/id-card/media/:id`) rather than `/api/crm/media/:id`, which sits behind
 * the CRM router's `overview:read` gate that `local_coordinator` does not hold.
 */

const DESIGN_ID = 'default';
/** Relative media path the card render + PNG export fetch the logo/photo from. */
export const CARD_MEDIA_BASE = '/api/id-card/media';

interface AuditCtx {
  ip: string | null;
  userAgent: string | null;
}

/** Read a feature flag; unknown keys fall back to `fallback`. */
async function isFlagEnabled(key: string, fallback: boolean): Promise<boolean> {
  const res = await query<{ enabled: boolean }>(
    `SELECT enabled FROM feature_flags WHERE key = $1`,
    [key],
  );
  return res.rows[0]?.enabled ?? fallback;
}

/** The studio kill-switches, so the UI can hide a disabled surface. */
export async function getStudioFlags(): Promise<{ designer: boolean; batchPrint: boolean; photo: boolean }> {
  const [designer, batchPrint, photo] = await Promise.all([
    isFlagEnabled('id_cards.designer', true),
    isFlagEnabled('id_cards.batchPrint', true),
    isFlagEnabled('id_cards.photo', true),
  ]);
  return { designer, batchPrint, photo };
}

// ── The global design ────────────────────────────────────────────────────────

/**
 * The active card design. An absent row (never customised) returns the complete
 * classic card; a stored row is re-parsed so any field a later release adds is
 * back-filled with its default rather than rendering undefined.
 */
export async function getDesign(): Promise<CardDesign> {
  const res = await query<{ config: unknown }>(
    `SELECT config FROM id_card_design WHERE id = $1`,
    [DESIGN_ID],
  );
  const row = res.rows[0];
  if (!row) return DEFAULT_CARD_DESIGN;
  return cardDesignSchema.parse(row.config ?? {});
}

/** Persist a new design (national admin). Validated, audited, immediate effect. */
export async function updateDesign(input: unknown, p: Principal, ctx: AuditCtx): Promise<CardDesign> {
  if (!(await isFlagEnabled('id_cards.designer', true))) {
    throw ApiError.forbidden('The ID Card Studio is disabled');
  }
  const config = cardDesignSchema.parse(input ?? {});
  await query(
    `INSERT INTO id_card_design (id, config, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET config = $2, updated_by = $3, updated_at = now()`,
    [DESIGN_ID, JSON.stringify(config), p.sub],
  );
  await recordAudit({
    action: 'id_card.design.update',
    actorId: p.sub,
    actorRole: p.role,
    targetType: 'id_card_design',
    targetId: DESIGN_ID,
    regionCode: null,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: {
      preset: config.size.preset,
      scalePct: config.size.scalePct,
      photo: config.photo.show,
      logo: config.logo.show,
      fields: config.fields.filter((f) => f.show).map((f) => f.key),
    },
  });
  return config;
}

// ── Per-member card photo (crop/zoom) ────────────────────────────────────────

export interface CardPhoto {
  /** Bare media id — the frontend builds `${API_BASE}/id-card/media/${mediaId}`
   *  (Capacitor-safe, like every other authenticated media fetch in the app). */
  mediaId: string;
  url: string;
  transform: PhotoTransform;
}

interface PhotoRow {
  media_id: string;
  transform: unknown;
}

async function readPhotoRow(memberId: string): Promise<PhotoRow | null> {
  const res = await query<PhotoRow>(
    `SELECT media_id, transform FROM member_card_photos WHERE member_id = $1`,
    [memberId],
  );
  return res.rows[0] ?? null;
}

/** A member's card photo as the render needs it, or null when none is set. */
export async function getMemberPhoto(memberId: string): Promise<CardPhoto | null> {
  const row = await readPhotoRow(memberId);
  if (!row) return null;
  return { mediaId: row.media_id, url: `${CARD_MEDIA_BASE}/${row.media_id}`, transform: photoTransformSchema.parse(row.transform ?? {}) };
}

/**
 * Set (or re-frame) a member's card photo. A `dataUrl` stores a new image via the
 * CRM media pipeline; omitting it just updates the crop/zoom of the existing one.
 * Gated by the caller's scope over the member and the `id_cards.photo` flag.
 */
export async function setMemberPhoto(
  memberId: string,
  input: { dataUrl?: string; transform?: PhotoTransform },
  p: Principal,
  ctx: AuditCtx,
): Promise<CardPhoto> {
  if (!(await isFlagEnabled('id_cards.photo', true))) {
    throw ApiError.forbidden('Card photos are disabled');
  }
  const member = await query<{ id: string; region_code: string | null; ward: string | null }>(
    `SELECT id, region_code, ward FROM members WHERE id = $1 AND deleted_at IS NULL`,
    [memberId],
  );
  const m = member.rows[0];
  if (!m) throw ApiError.notFound('Member not found');
  if (!(await principalSeesMember(p, { regionCode: m.region_code, ward: m.ward }))) {
    throw ApiError.forbidden('Member outside your authorized scope');
  }

  const existing = await readPhotoRow(memberId);
  let mediaId = existing?.media_id ?? null;
  if (input.dataUrl) {
    mediaId = (await storeAvatar(input.dataUrl, p)).id;
  }
  if (!mediaId) throw ApiError.badRequest('A photo (dataUrl) is required the first time');

  const transform = photoTransformSchema.parse(input.transform ?? existing?.transform ?? {});
  await query(
    `INSERT INTO member_card_photos (member_id, media_id, transform, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (member_id) DO UPDATE
        SET media_id = $2, transform = $3, updated_by = $4, updated_at = now()`,
    [memberId, mediaId, JSON.stringify(transform), p.sub],
  );
  await recordAudit({
    action: 'id_card.photo.set',
    actorId: p.sub,
    actorRole: p.role,
    targetType: 'member',
    targetId: memberId,
    regionCode: m.region_code,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { reuploaded: Boolean(input.dataUrl), zoom: transform.zoom },
  });
  return { mediaId, url: `${CARD_MEDIA_BASE}/${mediaId}`, transform };
}

/** Remove a member's card photo (the slot falls back to the no-photo layout). */
export async function deleteMemberPhoto(memberId: string, p: Principal, ctx: AuditCtx): Promise<void> {
  const member = await query<{ id: string; region_code: string | null; ward: string | null }>(
    `SELECT id, region_code, ward FROM members WHERE id = $1 AND deleted_at IS NULL`,
    [memberId],
  );
  const m = member.rows[0];
  if (!m) throw ApiError.notFound('Member not found');
  if (!(await principalSeesMember(p, { regionCode: m.region_code, ward: m.ward }))) {
    throw ApiError.forbidden('Member outside your authorized scope');
  }
  await query(`DELETE FROM member_card_photos WHERE member_id = $1`, [memberId]);
  await recordAudit({
    action: 'id_card.photo.delete',
    actorId: p.sub,
    actorRole: p.role,
    targetType: 'member',
    targetId: memberId,
    regionCode: m.region_code,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: {},
  });
}

/**
 * Serve a card image (logo or member photo) ONLY to a caller who may see the card
 * it belongs to. The logo is party branding any card viewer may fetch; a photo is
 * released only when the caller can see THAT member. Anything else 404s, so this
 * path can never be used to pull arbitrary report imagery or another ward's face.
 */
export async function loadCardMedia(
  mediaId: string,
  p: Principal,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const design = await getDesign();
  if (design.logo.mediaId === mediaId) {
    return loadMediaBuffer(mediaId);
  }
  const owner = await query<{ member_id: string; region_code: string | null; ward: string | null }>(
    `SELECT mcp.member_id, m.region_code, m.ward
       FROM member_card_photos mcp
       JOIN members m ON m.id = mcp.member_id
      WHERE mcp.media_id = $1`,
    [mediaId],
  );
  const row = owner.rows[0];
  if (!row) return null;
  if (!(await principalSeesMember(p, { regionCode: row.region_code, ward: row.ward }))) return null;
  return loadMediaBuffer(mediaId);
}

// ── The card builder (shared by the single-card endpoint and batch print) ─────

export interface PartyCard {
  memberId: string;
  membershipNo: string | null;
  publicCode: string;
  tier: string;
  status: string;
  regionCode: string | null;
  districtCode: string | null;
  ward: string | null;
  joinedAt: string | null;
  mandateAcceptedAt: string | null;
  roles: Array<{ name: string; title: string | null; ward: string | null; status: string }>;
  identity: { fullName?: string; phone?: string; email?: string } | null;
  party: typeof PARTY_PROFILE;
  verifyUrl: string;
  joinUrl: string;
  vcardUrl: string;
  /** The active studio design the card is rendered from. */
  design: CardDesign;
  /** The member's framed photo, or null when none is set. */
  photo: CardPhoto | null;
}

/**
 * Build one member's party card. Extracted from `public/routes.ts` verbatim (same
 * row-level scope, same PII gate + audit) and extended with the studio `design`
 * and the member `photo`. `wantsPii` reveals sealed identity only for a caller
 * holding `member:pii_decrypt`, and is audited as `member.pii.decrypt`.
 */
export async function buildPartyCard(
  memberId: string,
  p: Principal,
  wantsPii: boolean,
  ctx: AuditCtx,
): Promise<PartyCard> {
  const found = await query<{
    id: string;
    membership_no: string | null;
    public_code: string | null;
    tier: string;
    status: string;
    region_code: string | null;
    ward: string | null;
    district_code: string | null;
    joined_at: string | null;
    mandate_accepted_at: string | null;
    sealed_pii: any;
    deleted_at: string | null;
  }>('SELECT * FROM members WHERE id = $1', [memberId]);

  const m = found.rows[0];
  if (!m || m.deleted_at) throw ApiError.notFound('Member not found');
  // Row-level scope (D22): a ward-scoped principal is matched on the member's
  // WARD, not their region, exactly as the members list and the old inline card
  // handler did.
  if (!(await principalSeesMember(p, { regionCode: m.region_code, ward: m.ward }))) {
    throw ApiError.forbidden('Member outside your authorized scope');
  }

  const publicCode = m.public_code ?? (await ensurePublicCode(memberId));

  const roles = await query<{ name: string; title: string | null; ward: string | null; status: string }>(
    `SELECT p.name, a.title, a.ward, a.status
       FROM appointments a
       JOIN positions p ON p.code = a.position_code
      WHERE a.member_id = $1 AND a.status <> 'revoked'
      ORDER BY a.created_at DESC`,
    [memberId],
  );

  let identity: { fullName?: string; phone?: string; email?: string } | null = null;
  if (wantsPii) {
    if (!roleHasPermission(p.role, Permission.PII_DECRYPT)) {
      throw ApiError.forbidden('Missing permission: member:pii_decrypt');
    }
    const opened = (await openRecord(m.id, m.sealed_pii)) as Record<string, string>;
    identity = { ...opened };
    await recordAudit({
      action: 'member.pii.decrypt',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'member',
      targetId: memberId,
      regionCode: m.region_code,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { fields: Object.keys(opened), via: 'party_card' },
    });
  }

  const [design, photo] = await Promise.all([getDesign(), getMemberPhoto(memberId)]);

  return {
    memberId: m.id,
    membershipNo: m.membership_no,
    publicCode,
    tier: m.tier,
    status: m.status,
    regionCode: m.region_code,
    districtCode: m.district_code,
    ward: m.ward,
    joinedAt: m.joined_at,
    mandateAcceptedAt: m.mandate_accepted_at,
    roles: roles.rows,
    identity,
    party: PARTY_PROFILE,
    verifyUrl: publicUrl(`/v/${publicCode}`),
    joinUrl: joinUrl(publicCode),
    vcardUrl: publicUrl(`/api/public/verify/${publicCode}/vcard`),
    design,
    photo,
  };
}

/**
 * Build many cards for a batch print run. PII is NEVER revealed here (identity
 * stays null), and any id the caller cannot see — or that does not exist — is
 * reported in `skipped` rather than failing the whole run, so one out-of-scope
 * selection cannot block printing the rest.
 */
export async function buildBatchCards(
  memberIds: string[],
  p: Principal,
  ctx: AuditCtx,
): Promise<{ design: CardDesign; cards: PartyCard[]; skipped: Array<{ memberId: string; reason: string }> }> {
  if (!(await isFlagEnabled('id_cards.batchPrint', true))) {
    throw ApiError.forbidden('Batch card printing is disabled');
  }
  const design = await getDesign();
  const cards: PartyCard[] = [];
  const skipped: Array<{ memberId: string; reason: string }> = [];
  for (const id of memberIds) {
    try {
      cards.push(await buildPartyCard(id, p, false, ctx));
    } catch (err) {
      const reason = err instanceof ApiError ? publicErrorMessage(err.status, err.code) : 'This card is currently unavailable.';
      skipped.push({ memberId: id, reason });
    }
  }
  await recordAudit({
    action: 'id_card.batch.render',
    actorId: p.sub,
    actorRole: p.role,
    targetType: 'member',
    targetId: null,
    regionCode: null,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { requested: memberIds.length, rendered: cards.length, skipped: skipped.length },
  });
  return { design, cards, skipped };
}
