import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { Permission } from '../../auth/permissions.js';
import { recordAudit } from '../../security/audit.js';
import { lineageQuery, reportQuery, treeQuery } from './schemas.js';
import * as svc from './service.js';

/**
 * /api/recruitment — Recruitment genealogy & national growth report (PRD-growth FR-O).
 *
 * Gating (mirrors the jobs module: one router, per-route permission + scope):
 *  - invite   → the caller's OWN reference number + join link (recruitment:read).
 *  - tree     → recruitment:read. A member is hard-rooted at themselves; staff
 *               may open any root within scope (the service enforces it).
 *  - lineage  → recruitment:read. Trace a member up to the root source.
 *  - report   → recruitment:report. The ranked originator report (staff/national;
 *               a member never holds it).
 *
 * Every read is audited with its scope (FR-O7), mirroring PRD-jobs FR-L5.
 */
export const recruitmentRouter = Router();

recruitmentRouter.use(authenticate);

/** FR-O2: the caller's own reference number, join link and QR payload. */
recruitmentRouter.get(
  '/invite',
  requirePermission(Permission.RECRUITMENT_READ),
  asyncHandler(async (req, res) => {
    res.json(await svc.getInvite(req.principal!));
  }),
);

/** FR-O4: a recruitment subtree, depth-capped and scope-checked. */
recruitmentRouter.get(
  '/tree',
  requirePermission(Permission.RECRUITMENT_READ),
  asyncHandler(async (req, res) => {
    const q = treeQuery.parse(req.query);
    const tree = await svc.getTree(req.principal!, q);
    await recordAudit({
      action: 'recruitment.tree.read',
      actorId: req.principal!.sub,
      actorRole: req.principal!.role,
      targetType: 'member',
      targetId: tree.root?.memberId ?? null,
      regionCode: tree.root?.ward ?? null,
      metadata: { scope: tree.scope, depthCap: tree.depthCap, nodes: tree.nodes.length, truncated: tree.truncated },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json(tree);
  }),
);

/** FR-O5: trace a member up to the first source of their branch. */
recruitmentRouter.get(
  '/lineage',
  requirePermission(Permission.RECRUITMENT_READ),
  asyncHandler(async (req, res) => {
    const q = lineageQuery.parse(req.query);
    const lineage = await svc.getLineage(req.principal!, q);
    await recordAudit({
      action: 'recruitment.lineage.read',
      actorId: req.principal!.sub,
      actorRole: req.principal!.role,
      targetType: 'member',
      targetId: q.member,
      regionCode: lineage.chain[0]?.ward ?? null,
      metadata: { scope: lineage.scope, depth: lineage.depth, root: lineage.root?.memberId ?? null },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json(lineage);
  }),
);

/** FR-O6: the ranked recruitment report (ward councillors first). */
recruitmentRouter.get(
  '/report',
  requirePermission(Permission.RECRUITMENT_REPORT),
  asyncHandler(async (req, res) => {
    const q = reportQuery.parse(req.query);
    const report = await svc.getReport(req.principal!, q);
    await recordAudit({
      action: 'recruitment.report.read',
      actorId: req.principal!.sub,
      actorRole: req.principal!.role,
      targetType: 'ward',
      targetId: q.ward ?? null,
      regionCode: q.ward ?? null,
      metadata: { scope: report.scope, rows: report.rows.length, totals: report.totals },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json(report);
  }),
);
