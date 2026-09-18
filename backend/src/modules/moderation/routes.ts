import { Router, type Request } from 'express';
import { asyncHandler } from '../../http/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { Permission } from '../../auth/permissions.js';
import * as svc from './service.js';
import { applyActionSchema, listUsersQuerySchema } from './schemas.js';

/**
 * /api/moderation — the ban/suspend ladder + device bans back-office.
 * Gated by MODERATE_USERS (national admin). Every write is audited and
 * recorded in `moderation_actions`.
 */
export const moderationRouter = Router();

function actorOf(req: Request): svc.ActorCtx {
  return {
    actorId: req.principal?.sub ?? null,
    actorRole: req.principal?.role ?? null,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

moderationRouter.use(authenticate);
moderationRouter.use(requirePermission(Permission.MODERATE_USERS));

/** GET /moderation/users — searchable moderation queue. */
moderationRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    const filters = listUsersQuerySchema.parse(req.query);
    res.json(await svc.listUsers(filters));
  }),
);

/** GET /moderation/users/:id — status + T&C + action history + audit trail. */
moderationRouter.get(
  '/users/:id',
  asyncHandler(async (req, res) => {
    res.json(await svc.getProfile(req.params.id as string));
  }),
);

/** GET /moderation/devices — banned-device register. */
moderationRouter.get(
  '/devices',
  asyncHandler(async (_req, res) => {
    res.json(await svc.listDevices());
  }),
);

/** POST /moderation/actions — apply warn/suspend/ban/reinstate/device_ban/device_unban. */
moderationRouter.post(
  '/actions',
  asyncHandler(async (req, res) => {
    const input = applyActionSchema.parse(req.body);
    const result = await svc.applyAction(input, actorOf(req));
    res.status(201).json(result);
  }),
);
