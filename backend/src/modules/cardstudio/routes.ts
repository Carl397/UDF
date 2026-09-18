import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, requireModule } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { ApiError } from '../../http/errors.js';
import { Permission, ModuleKey } from '../../auth/permissions.js';
import { storeAvatar } from '../crm/mediaService.js';
import {
  batchBody,
  memberIdParam,
  setPhotoBody,
  SIZE_PRESETS,
  FIELD_KEYS,
} from './schemas.js';
import * as svc from './service.js';

/**
 * /api/id-card — the Party ID Card Studio (migration 022).
 *
 * A dedicated top-level router (NOT nested under `/api/crm`, whose router-level
 * `overview:read` gate `local_coordinator` does not hold) so the card's own
 * surfaces stay reachable by exactly the roles that can see a card. Two audiences:
 *
 *  • NATIONAL ADMIN (`module:manage`) — design the template: GET/PUT `/design`,
 *    upload the party logo. The same permission that guards the module registry.
 *  • CARD VIEWERS (`id_cards` module + `member:read`) — fetch card media (logo or
 *    a visible member's photo) and run a batch print. `member:write` holders may
 *    set/clear a member's photo within their scope.
 *
 * Rendering a single card stays on `GET /api/public/card/:memberId` (unchanged
 * gate); it now shares `svc.buildPartyCard`, so the design + photo ride along.
 */
export const cardStudioRouter = Router();

cardStudioRouter.use(authenticate);

// ── National-admin designer ──────────────────────────────────────────────────

/**
 * GET /id-card/design
 * The active design plus the studio metadata the editor needs (flags, size
 * presets, field keys), so the palette/size/layout controls and the code never
 * drift. National admin only — this is the designer's read, not the card render.
 */
cardStudioRouter.get(
  '/design',
  requirePermission(Permission.MODULE_MANAGE),
  asyncHandler(async (_req, res) => {
    const [design, flags] = await Promise.all([svc.getDesign(), svc.getStudioFlags()]);
    res.json({ design, flags, presets: SIZE_PRESETS, fieldKeys: FIELD_KEYS });
  }),
);

/** PUT /id-card/design — persist a new template (validated, audited, immediate). */
cardStudioRouter.put(
  '/design',
  requirePermission(Permission.MODULE_MANAGE),
  asyncHandler(async (req, res) => {
    const design = await svc.updateDesign(req.body, req.principal!, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json({ design });
  }),
);

/**
 * POST /id-card/logo — upload the party logo (base64 data-url) via the shared CRM
 * media pipeline; returns the media id + url to fold into the design's `logo`.
 */
cardStudioRouter.post(
  '/logo',
  requirePermission(Permission.MODULE_MANAGE),
  asyncHandler(async (req, res) => {
    const dataUrl = req.body?.dataUrl as string | undefined;
    if (!dataUrl) throw ApiError.badRequest('dataUrl is required');
    const stored = await storeAvatar(dataUrl, req.principal!);
    res.status(201).json({ mediaId: stored.id, url: `${svc.CARD_MEDIA_BASE}/${stored.id}` });
  }),
);

// ── Card viewers: media + batch print ────────────────────────────────────────

/**
 * GET /id-card/media/:id
 * Stream a card image — the party logo, or the photo of a member the caller can
 * see. `svc.loadCardMedia` releases nothing else, so this path cannot be used to
 * pull arbitrary report imagery or another ward's face.
 */
cardStudioRouter.get(
  '/media/:id',
  requireModule(ModuleKey.ID_CARDS),
  requirePermission(Permission.MEMBER_READ),
  asyncHandler(async (req, res) => {
    const media = await svc.loadCardMedia(req.params.id as string, req.principal!);
    if (!media) {
      res.status(404).json({ error: 'Media not found' });
      return;
    }
    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(media.buffer);
  }),
);

/**
 * POST /id-card/batch
 * Build many cards for a print run (multi-select → print). PII is never revealed
 * in a batch; out-of-scope/unknown ids come back in `skipped` rather than failing
 * the run.
 */
cardStudioRouter.post(
  '/batch',
  requireModule(ModuleKey.ID_CARDS),
  requirePermission(Permission.MEMBER_READ),
  asyncHandler(async (req, res) => {
    const { memberIds } = batchBody.parse(req.body);
    const result = await svc.buildBatchCards(memberIds, req.principal!, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json(result);
  }),
);

// ── Member photo (crop/zoom) — member:write within scope ─────────────────────

/** PUT /id-card/member/:memberId/photo — set or re-frame a member's card photo. */
cardStudioRouter.put(
  '/member/:memberId/photo',
  requireModule(ModuleKey.ID_CARDS),
  requirePermission(Permission.MEMBER_WRITE),
  asyncHandler(async (req, res) => {
    const { memberId } = memberIdParam.parse(req.params);
    const body = setPhotoBody.parse(req.body);
    const photo = await svc.setMemberPhoto(memberId, body, req.principal!, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json({ photo });
  }),
);

/** DELETE /id-card/member/:memberId/photo — clear it (slot falls back to no photo). */
cardStudioRouter.delete(
  '/member/:memberId/photo',
  requireModule(ModuleKey.ID_CARDS),
  requirePermission(Permission.MEMBER_WRITE),
  asyncHandler(async (req, res) => {
    const { memberId } = memberIdParam.parse(req.params);
    await svc.deleteMemberPhoto(memberId, req.principal!, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json({ success: true });
  }),
);
