import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { Permission } from '../../auth/permissions.js';
import { recordAudit } from '../../security/audit.js';
import { acknowledgeBody, historyQuery, idParam, rollupQuery, submitScorecard } from './schemas.js';
import * as svc from './service.js';

/**
 * /api/scorecards — Councillor performance scorecards (PRD-growth FR-S).
 *
 * Gating (mirrors the recruitment module: one router, per-route permission +
 * scope). The three permissions split the surface cleanly by audience:
 *  - `rating:scorecard_write` (member only) → the caller's OWN current-month
 *    card, its submission and its history. Staff never hold it (FR-S5), so they
 *    cannot submit a member's scorecard.
 *  - `rating:scorecard_read` (councillor/staff/analyst) → the ward/scope inbox,
 *    the category rollups, the ≤2 reasons queue, and the submitted→viewed mark.
 *    A member never holds it, so they cannot read anyone else's card.
 *  - `rating:acknowledge` (councillor/national) → the viewed→acknowledged mark
 *    that notifies the member (FR-S6).
 *
 * Every submit/view/acknowledge is audited as `rating.scorecard.*` with its ward
 * scope (FR-S9), mirroring the recruitment module's read audits.
 */
export const scorecardsRouter = Router();

scorecardsRouter.use(authenticate);

// ── Member write surface ───────────────────────────────────────────────────

/** FR-S4: the caller's eligibility, this month's status, categories and items. */
scorecardsRouter.get(
  '/current',
  requirePermission(Permission.RATING_SCORECARD_WRITE),
  asyncHandler(async (req, res) => {
    res.json(await svc.getCurrent(req.principal!));
  }),
);

/** FR-S2/S3: submit or update this month's scorecard (100-word rule for ≤2). */
scorecardsRouter.put(
  '/',
  requirePermission(Permission.RATING_SCORECARD_WRITE),
  asyncHandler(async (req, res) => {
    const body = submitScorecard.parse(req.body);
    const saved = await svc.submit(req.principal!, body);
    await recordAudit({
      action: 'rating.scorecard.submit',
      actorId: req.principal!.sub,
      actorRole: req.principal!.role,
      targetType: 'scorecard',
      targetId: saved.id,
      regionCode: saved.wardCode,
      metadata: {
        period: saved.period,
        items: saved.items.length,
        low: saved.items.filter((i) => i.score <= 2).length,
        shareName: saved.shareName,
      },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json(saved);
  }),
);

/** FR-S2: the caller's own scorecards across previous months. */
scorecardsRouter.get(
  '/history',
  requirePermission(Permission.RATING_SCORECARD_WRITE),
  asyncHandler(async (req, res) => {
    const q = historyQuery.parse(req.query);
    res.json(await svc.history(req.principal!, q));
  }),
);

// ── Councillor / staff / CRM read surface ──────────────────────────────────

/** FR-S6/S7: scorecards in scope for the acknowledgement workflow. */
scorecardsRouter.get(
  '/inbox',
  requirePermission(Permission.RATING_SCORECARD_READ),
  asyncHandler(async (req, res) => {
    const q = rollupQuery.parse(req.query);
    const out = await svc.inbox(req.principal!, q);
    await recordAudit({
      action: 'rating.scorecard.inbox',
      actorId: req.principal!.sub,
      actorRole: req.principal!.role,
      targetType: 'ward',
      targetId: q.ward ?? null,
      regionCode: q.ward ?? null,
      metadata: { period: out.period, scope: out.scope, rows: out.rows.length },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json(out);
  }),
);

/** FR-S8: per-category averages, distribution and counts across scope. */
scorecardsRouter.get(
  '/summary',
  requirePermission(Permission.RATING_SCORECARD_READ),
  asyncHandler(async (req, res) => {
    const q = rollupQuery.parse(req.query);
    res.json(await svc.summary(req.principal!, q));
  }),
);

/** FR-S8: the ≤2 reasons queue — the actionable complaints across scope. */
scorecardsRouter.get(
  '/low-reasons',
  requirePermission(Permission.RATING_SCORECARD_READ),
  asyncHandler(async (req, res) => {
    const q = rollupQuery.parse(req.query);
    res.json(await svc.lowReasons(req.principal!, q));
  }),
);

/** FR-S1: the active category taxonomy (labels + order) for the CRM editor. */
scorecardsRouter.get(
  '/categories',
  requirePermission(Permission.RATING_SCORECARD_READ),
  asyncHandler(async (_req, res) => {
    res.json(await svc.categories());
  }),
);

/** FR-S6: opening a submitted scorecard marks it `viewed`. */
scorecardsRouter.post(
  '/:id/view',
  requirePermission(Permission.RATING_SCORECARD_READ),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const sc = await svc.view(req.principal!, id);
    await recordAudit({
      action: 'rating.scorecard.view',
      actorId: req.principal!.sub,
      actorRole: req.principal!.role,
      targetType: 'scorecard',
      targetId: id,
      regionCode: sc.wardCode,
      metadata: { period: sc.period, status: sc.status },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json(sc);
  }),
);

/** FR-S6: acknowledge a scorecard and notify the member. */
scorecardsRouter.post(
  '/:id/acknowledge',
  requirePermission(Permission.RATING_ACKNOWLEDGE),
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = acknowledgeBody.parse(req.body ?? {});
    const sc = await svc.acknowledge(req.principal!, id, body);
    await recordAudit({
      action: 'rating.scorecard.acknowledge',
      actorId: req.principal!.sub,
      actorRole: req.principal!.role,
      targetType: 'scorecard',
      targetId: id,
      regionCode: sc.wardCode,
      metadata: { period: sc.period, note: !!sc.ackNote },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json(sc);
  }),
);
