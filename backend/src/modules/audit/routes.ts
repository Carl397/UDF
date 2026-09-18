import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { Permission } from '../../auth/permissions.js';
import { verifyChain } from '../../security/audit.js';
import { query } from '../../db/pool.js';

/** /api/audit — integrity + inspection of the tamper-evident log. */
export const auditRouter = Router();

auditRouter.use(authenticate, requirePermission(Permission.AUDIT_READ));

// Recompute the hash chain and report whether it is intact.
auditRouter.get(
  '/verify',
  asyncHandler(async (_req, res) => {
    res.json(await verifyChain());
  }),
);

// Recent entries (metadata only — never contains plaintext PII).
auditRouter.get(
  '/entries',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const res2 = await query(
      `SELECT seq, id, action, actor_id, actor_role, target_type, target_id,
              region_code, metadata, created_at
         FROM audit_log ORDER BY seq DESC LIMIT $1`,
      [limit],
    );
    res.json({ items: res2.rows });
  }),
);
