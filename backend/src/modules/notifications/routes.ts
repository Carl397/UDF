import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { ApiError } from '../../http/errors.js';
import { Permission } from '../../auth/permissions.js';
import { STAFF_ROLES } from '../../auth/scope.js';
import * as service from './service.js';

/** /api/notifications — the in-app alert centre (bell badge + Alerts list). */
export const notificationsRouter = Router();

const listQuery = z.object({
  unread: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createSchema = z.object({
  kind: z.string().max(32).default('alert'),
  title: z.string().min(1).max(140),
  body: z.string().max(2000).optional(),
  link: z.string().max(300).optional(),
  regionCode: z.string().max(32).optional(),
});

notificationsRouter.use(authenticate);

notificationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const isStaff = STAFF_ROLES.has(req.principal!.role);
    res.json(await service.list(req.principal!.sub, { ...q, isStaff }));
  }),
);

notificationsRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const isStaff = STAFF_ROLES.has(req.principal!.role);
    res.json({ unread: await service.unreadCount(req.principal!.sub, isStaff) });
  }),
);

// Manual broadcast (e.g. rally alert) — notify:write.
notificationsRouter.post(
  '/',
  requirePermission(Permission.NOTIFY_WRITE),
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    await service.notify({
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      regionCode: input.regionCode ?? null,
    });
    res.status(201).json({ ok: true });
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const isStaff = STAFF_ROLES.has(req.principal!.role);
    const marked = await service.markAllRead(req.principal!.sub, isStaff);
    res.json({ ok: true, marked });
  }),
);

notificationsRouter.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const isStaff = STAFF_ROLES.has(req.principal!.role);
    const ok = await service.markRead(req.principal!.sub, req.params.id!, isStaff);
    if (!ok) throw ApiError.notFound('Notification not found');
    res.json({ ok: true });
  }),
);
