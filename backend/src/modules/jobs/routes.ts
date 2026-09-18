import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { Permission } from '../../auth/permissions.js';
import { recordAudit } from '../../security/audit.js';
import {
  adminConfigSchema,
  createOpportunitySchema,
  demandQuery,
  listOpportunitiesQuery,
  patchOpportunitySchema,
  publicCountQuery,
  upsertInterestSchema,
  workTypeCodeSchema,
  workTypeUpsertSchema,
} from './schemas.js';
import * as svc from './service.js';

/**
 * /api/jobs — Ward Job Interest Register & Opportunity Relay (PRD-jobs).
 *
 * Gating:
 *  - interest read/write  → the signed-in member's OWN row (jobs:interest_write).
 *  - opportunity list     → members see own-ward published; staff see their scope.
 *  - demand aggregates    → jobs:demand_read (councillor/staff/analyst), audited.
 *  - opportunity writes   → jobs:opportunity_write (councillor/staff).
 *  - public-count         → anonymous aggregate (flag-gated in the client).
 */
export const jobsRouter = Router();

// ── Public / anonymous ───────────────────────────────────────────────────
/** FR-L4: anonymous, aggregate "people looking for work" count for a ward. */
jobsRouter.get(
  '/public-count',
  asyncHandler(async (req, res) => {
    const q = publicCountQuery.parse(req.query);
    res.json(await svc.publicCount(q.ward));
  }),
);

// ── Authenticated ────────────────────────────────────────────────────────
jobsRouter.use(authenticate);

/** Active work-type taxonomy (form chips + CRM editor). */
jobsRouter.get(
  '/work-types',
  asyncHandler(async (_req, res) => {
    res.json({ items: await svc.listWorkTypes() });
  }),
);

/** §9.7: public feature-flag booleans the client uses to gate the jobs UI. */
jobsRouter.get(
  '/flags',
  asyncHandler(async (_req, res) => {
    res.json(await svc.getPublicFlags());
  }),
);

/** The signed-in member's own interest (or null). */
jobsRouter.get(
  '/interest',
  asyncHandler(async (req, res) => {
    res.json({ interest: await svc.getOwnInterest(req.principal!) });
  }),
);

/** FR-K1/K4: create-or-update own interest. */
jobsRouter.put(
  '/interest',
  requirePermission(Permission.JOBS_INTEREST_WRITE),
  asyncHandler(async (req, res) => {
    const input = upsertInterestSchema.parse(req.body);
    const interest = await svc.upsertInterest(input, req.principal!, {
      ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
    });
    res.json({ interest });
  }),
);

/** FR-K5: withdraw = hard delete of own row. */
jobsRouter.delete(
  '/interest',
  requirePermission(Permission.JOBS_INTEREST_WRITE),
  asyncHandler(async (req, res) => {
    const result = await svc.withdrawInterest(req.principal!, {
      ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
    });
    res.json(result);
  }),
);

/** FR-K6 (member) / FR-N2 (staff): list opportunities, scoped by role. */
jobsRouter.get(
  '/opportunities',
  asyncHandler(async (req, res) => {
    const q = listOpportunitiesQuery.parse(req.query);
    res.json(await svc.listOpportunities(req.principal!, q));
  }),
);

/** FR-L: aggregate, PII-free ward work-demand (audited per FR-L5). */
jobsRouter.get(
  '/demand',
  requirePermission(Permission.JOBS_DEMAND_READ),
  asyncHandler(async (req, res) => {
    const q = demandQuery.parse(req.query);
    const demand = await svc.getDemand(req.principal!, q.ward);
    await recordAudit({
      action: 'jobs.demand.read',
      actorId: req.principal!.sub, actorRole: req.principal!.role,
      targetType: 'ward', targetId: q.ward ?? null, regionCode: q.ward ?? null,
      metadata: { scope: demand.scope }, ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
    });
    res.json(demand);
  }),
);

/** FR-M1: record an opportunity (draft). */
jobsRouter.post(
  '/opportunities',
  requirePermission(Permission.JOBS_OPPORTUNITY_WRITE),
  asyncHandler(async (req, res) => {
    const input = createOpportunitySchema.parse(req.body);
    const opportunity = await svc.createOpportunity(input, req.principal!, {
      ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
    });
    res.status(201).json({ opportunity });
  }),
);

/** Single opportunity (member own-ward published, or staff in scope). */
jobsRouter.get(
  '/opportunities/:id',
  asyncHandler(async (req, res) => {
    res.json({ opportunity: await svc.getOpportunity(req.params.id!, req.principal!) });
  }),
);

/** FR-M5: limited edit. */
jobsRouter.patch(
  '/opportunities/:id',
  requirePermission(Permission.JOBS_OPPORTUNITY_WRITE),
  asyncHandler(async (req, res) => {
    const input = patchOpportunitySchema.parse(req.body);
    const opportunity = await svc.patchOpportunity(req.params.id!, input, req.principal!, {
      ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
    });
    res.json({ opportunity });
  }),
);

/** FR-M2: publish + relay to matched members (returns delivery counts only). */
jobsRouter.post(
  '/opportunities/:id/publish',
  requirePermission(Permission.JOBS_OPPORTUNITY_WRITE),
  asyncHandler(async (req, res) => {
    const result = await svc.publishOpportunity(req.params.id!, req.principal!, {
      ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
    });
    res.json(result);
  }),
);

/** FR-M5: close an opportunity. */
jobsRouter.post(
  '/opportunities/:id/close',
  requirePermission(Permission.JOBS_OPPORTUNITY_WRITE),
  asyncHandler(async (req, res) => {
    const opportunity = await svc.closeOpportunity(req.params.id!, req.principal!, {
      ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
    });
    res.json({ opportunity });
  }),
);

// ── FR-N4: national-admin taxonomy + config (jobs:admin) ─────────────────

/** Full work-type taxonomy including inactive codes. */
jobsRouter.get(
  '/admin/work-types',
  requirePermission(Permission.JOBS_ADMIN),
  asyncHandler(async (_req, res) => {
    res.json({ items: await svc.listAllWorkTypes() });
  }),
);

/** Create or update a work type (label / active / sort). */
jobsRouter.put(
  '/admin/work-types/:code',
  requirePermission(Permission.JOBS_ADMIN),
  asyncHandler(async (req, res) => {
    const code = workTypeCodeSchema.parse(req.params.code);
    const input = workTypeUpsertSchema.parse(req.body);
    const workType = await svc.upsertWorkType(code, input, req.principal!, {
      ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
    });
    res.json({ workType });
  }),
);

/** Current flags + relay template + demand windows. */
jobsRouter.get(
  '/admin/config',
  requirePermission(Permission.JOBS_ADMIN),
  asyncHandler(async (_req, res) => {
    res.json(await svc.getAdminConfig());
  }),
);

/** Update flags / relay template / windows (partial). */
jobsRouter.put(
  '/admin/config',
  requirePermission(Permission.JOBS_ADMIN),
  asyncHandler(async (req, res) => {
    const input = adminConfigSchema.parse(req.body);
    const config = await svc.updateAdminConfig(input, req.principal!, {
      ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
    });
    res.json(config);
  }),
);
