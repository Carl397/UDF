import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../../db/pool.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, requireModule } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { ApiError } from '../../http/errors.js';
import { Permission, ModuleKey } from '../../auth/permissions.js';
import { principalSeesMember } from '../../auth/scope.js';
import { recordAudit } from '../../security/audit.js';
import {
  registerSchema,
  registerMember,
  confirmToken,
  verifyByCode,
  issueToken,
} from '../memberships/service.js';
import { PARTY_PROFILE, MANIFESTO, STANDS_FOR, TERMS, TERMS_VERSION } from './content.js';
import { getPublishedBlocks } from '../content/service.js';
import { loadPublicLeaderMedia } from '../crm/mediaService.js';
import { buildPartyCard } from '../cardstudio/service.js';

/**
 * /api/public — everything reachable without a staff login.
 *
 * Powers the public website and the QR party card:
 *   GET  /meta                 party profile, regions, tiers, position catalog
 *   GET  /manifesto            mission, vision, values, pillars, member guide
 *   GET  /media/:id            a published ward-leader photo (gated to public leaders)
 *   POST /register             membership application → confirmation link
 *   GET  /confirm/:token       confirm membership, or accept a mandate
 *   GET  /verify/:code         public verification of a party ID card
 *   GET  /verify/:code/vcard   downloadable contact card
 *   GET  /card/:memberId       (authenticated) the member's own card + links
 */
export const publicRouter = Router();

/**
 * GET /public/media/:id
 * Serve a ward-leader profile photo to anonymous visitors. Gated server-side to
 * media assets actually referenced by an `is_public` leaders row, so internal
 * avatars and report imagery can never be fetched through this public path.
 */
publicRouter.get(
  '/media/:id',
  asyncHandler(async (req, res) => {
    const media = await loadPublicLeaderMedia(req.params.id as string);
    if (!media) {
      res.status(404).json({ error: 'Media not found' });
      return;
    }
    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    // Public, no-auth image meant to be embedded anywhere. Helmet applies a global
    // CORP of `same-site`, which blocks the mobile WebView (origin http://localhost)
    // from rendering this cross-site inside an <img>; widen it for this response only.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(media.buffer);
  }),
);

/** Public registration is anonymous, so it gets its own stricter budget. */
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'too_many_requests', message: 'Too many registrations — try later' } },
});

/** Keep a published string only when it is non-empty, else fall back to static. */
function keepStr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/**
 * Read the published content blocks for hydration, never throwing: the public
 * `/meta` and `/manifesto` surfaces must keep serving the coded defaults if the
 * content tables are mid-migration or a block is absent, so a CMS hiccup cannot
 * take down the register/manifesto pages.
 */
async function publishedBlocksSafe(): Promise<Record<string, { data: unknown; publishedAt: string }>> {
  try {
    return await getPublishedBlocks();
  } catch {
    return {};
  }
}

/** Overlay the published `shared.brand` block onto the coded PARTY_PROFILE. */
async function publishedParty(): Promise<typeof PARTY_PROFILE> {
  const blocks = await publishedBlocksSafe();
  const b = blocks['shared.brand']?.data as
    | { name?: string; fullName?: string; tagline?: string; slogan?: string; email?: string; website?: string; address?: string }
    | undefined;
  if (!b) return PARTY_PROFILE;
  return {
    ...PARTY_PROFILE,
    name: keepStr(b.name, PARTY_PROFILE.name),
    fullName: keepStr(b.fullName, PARTY_PROFILE.fullName),
    tagline: keepStr(b.tagline, PARTY_PROFILE.tagline),
    slogan: keepStr(b.slogan, PARTY_PROFILE.slogan),
    contacts: {
      ...PARTY_PROFILE.contacts,
      email: keepStr(b.email, PARTY_PROFILE.contacts.email),
      website: keepStr(b.website, PARTY_PROFILE.contacts.website),
      address: keepStr(b.address, PARTY_PROFILE.contacts.address),
    },
  } as typeof PARTY_PROFILE;
}

publicRouter.get(
  '/meta',
  asyncHandler(async (_req, res) => {
    // `parent_code` lets the register form build the ward → subcouncil → region
    // chain client-side (so picking a ward can auto-fill district and region),
    // without a second authenticated call. The column is civic geography, not
    // PII — the same tree is already served to anonymous visitors through
    // `/api/public/wards` and the transparency module.
    const regions = await query<{
      code: string;
      name: string;
      level: string;
      parent_code: string | null;
    }>(
      `SELECT code, name, level, parent_code FROM regions ORDER BY level DESC, name`,
    );
    const positions = await query<{
      code: string;
      name: string;
      level: string;
      tier: string;
      description: string | null;
      term_months: number | null;
    }>('SELECT code, name, level, tier, description, term_months FROM positions ORDER BY level, name');

    res.json({
      party: await publishedParty(),
      standsFor: STANDS_FOR,
      regions: regions.rows.map((r) => ({
        code: r.code,
        name: r.name,
        level: r.level,
        parentCode: r.parent_code,
      })),
      tiers: ['voter', 'volunteer', 'activist', 'donor', 'candidate', 'staff'],
      positions: positions.rows.map((p) => ({
        code: p.code,
        name: p.name,
        level: p.level,
        tier: p.tier,
        description: p.description,
        termMonths: p.term_months,
      })),
      confirmUrlPath: '/confirm/:token',
      verifyUrlPath: '/v/:code',
    });
  }),
);

publicRouter.get(
  '/manifesto',
  asyncHandler(async (_req, res) => {
    const blocks = await publishedBlocksSafe();
    const home = blocks['marketing.home']?.data as
      | { mission?: string; vision?: string }
      | undefined;
    const manifesto = home
      ? {
          ...MANIFESTO,
          mission: keepStr(home.mission, MANIFESTO.mission),
          vision: keepStr(home.vision, MANIFESTO.vision),
        }
      : MANIFESTO;
    res.json({ party: await publishedParty(), standsFor: STANDS_FOR, ...manifesto });
  }),
);

/** Public Terms & Conditions — the app renders these and records acceptance. */
publicRouter.get(
  '/terms',
  asyncHandler(async (_req, res) => {
    res.json(TERMS);
  }),
);

publicRouter.post(
  '/register',
  registerLimiter,
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const deviceId = req.get('x-device-id');
    const result = await registerMember(input, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      deviceId: typeof deviceId === 'string' && deviceId.length > 0 ? deviceId.slice(0, 128) : null,
    });
    res.status(201).json(result);
  }),
);

publicRouter.get(
  '/confirm/:token',
  asyncHandler(async (req, res) => {
    const result = await confirmToken(req.params.token!, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json(result);
  }),
);

publicRouter.get(
  '/verify/:code',
  asyncHandler(async (req, res) => {
    const card = await verifyByCode(req.params.code!.toUpperCase(), {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json(card);
  }),
);

publicRouter.get(
  '/verify/:code/vcard',
  asyncHandler(async (req, res) => {
    const card = await verifyByCode(req.params.code!.toUpperCase(), {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res
      .type('text/vcard')
      .setHeader('Content-Disposition', `attachment; filename="${card.publicCode}.vcf"`)
      .send(card.vcard);
  }),
);

// ── Authenticated: a member's own party card (used by the ID-card screen) ──
publicRouter.get(
  '/card/:memberId',
  authenticate,
  // The party ID card is the `id_cards` module's only surface. It owns no
  // permission of its own (it rides on member:read), so it is gated explicitly:
  // a national admin can switch the whole card surface off without touching the
  // member directory. requireModule runs before requirePermission so a disabled
  // module reads as "module off", not "no member:read".
  requireModule(ModuleKey.ID_CARDS),
  requirePermission(Permission.MEMBER_READ),
  asyncHandler(async (req, res) => {
    // Card building lives in `cardstudio/service.buildPartyCard` so this endpoint
    // and the batch-print run share ONE implementation (row-level scope, the PII
    // gate + audit, and now the studio design + member photo). The gate above is
    // unchanged: the `id_cards` module + `member:read`.
    const wantsPii = req.query.pii === 'true' || req.query.pii === '1';
    const card = await buildPartyCard(req.params.memberId!, req.principal!, wantsPii, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json(card);
  }),
);

// Re-send the membership confirmation link (organiser helping a member).
publicRouter.post(
  '/card/:memberId/confirm-link',
  authenticate,
  requirePermission(Permission.MEMBER_WRITE),
  asyncHandler(async (req, res) => {
    const p = req.principal!;
    const memberId = req.params.memberId!;

    const m = await query<{ id: string; region_code: string | null; ward: string | null; status: string }>(
      'SELECT id, region_code, ward, status FROM members WHERE id = $1 AND deleted_at IS NULL',
      [memberId],
    );
    if (!m.rows[0]) throw ApiError.notFound('Member not found');
    // Same ward-level rule as the card read above. This is a WRITE side effect
    // (it mints a fresh confirmation link), so a region-only test let a
    // ward-scoped `local_coordinator` act on members in neighbouring wards.
    if (!(await principalSeesMember(p, { regionCode: m.rows[0]!.region_code, ward: m.rows[0]!.ward }))) {
      throw ApiError.forbidden('Member outside your authorized scope');
    }

    const issued = await issueToken({ memberId, kind: 'register', ttlDays: 14 });
    await recordAudit({
      action: 'member.confirm_link',
      actorId: p.sub,
      actorRole: p.role,
      targetType: 'member',
      targetId: memberId,
      regionCode: m.rows[0]!.region_code,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json({ confirmUrl: issued.confirmUrl, expiresAt: issued.expiresAt });
  }),
);
