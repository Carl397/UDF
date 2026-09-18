import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { Permission } from '../../auth/permissions.js';
import {
  createServiceRequestSchema,
  updateServiceRequestSchema,
  listServiceRequestsQuery,
} from './schemas.js';
import * as service from './service.js';

/**
 * /api/service-requests — service delivery case management.
 *
 * Permissions:
 *   POST   /              — case:log (create a new service request)
 *   GET    /              — case:read (list, territory-scoped, private cases staff-only)
 *   GET    /:id           — case:read (get one + timeline, same territory/tier gate)
 *   PATCH  /:id           — case:update (update status, municipality ref)
 *   POST   /:id/close     — case:close (close a resolved request)
 */
export const serviceRequestsRouter = Router();

// List service requests (ward-scoped)
serviceRequestsRouter.get(
  '/',
  authenticate,
  requirePermission(Permission.CASE_READ),
  asyncHandler(async (req, res) => {
    const q = listServiceRequestsQuery.parse(req.query);
    const { rows, total } = await service.listServiceRequests(q, req.principal!);
    // `items` matches the list envelope used by every other collection endpoint
    // (members, events, posts, bulletins) that the frontend client expects.
    res.json({ items: rows, total, limit: q.limit, offset: q.offset });
  }),
);

// Get one service request + timeline
serviceRequestsRouter.get(
  '/:id',
  authenticate,
  requirePermission(Permission.CASE_READ),
  asyncHandler(async (req, res) => {
    const sr = await service.getServiceRequest(req.params.id!, req.principal!);
    if (!sr) return res.status(404).json({ error: { code: 'not_found', message: 'Service request not found' } });
    const timeline = await service.getServiceRequestTimeline(req.params.id!);
    res.json({ ...sr, timeline });
  }),
);

// Create a service request
serviceRequestsRouter.post(
  '/',
  authenticate,
  requirePermission(Permission.CASE_LOG),
  asyncHandler(async (req, res) => {
    const input = createServiceRequestSchema.parse(req.body);
    const sr = await service.createServiceRequest(input, req.principal!, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.status(201).json(sr);
  }),
);

// Update a service request (status, municipality ref, etc.)
serviceRequestsRouter.patch(
  '/:id',
  authenticate,
  requirePermission(Permission.CASE_UPDATE),
  asyncHandler(async (req, res) => {
    const input = updateServiceRequestSchema.parse(req.body);
    const sr = await service.updateServiceRequest(req.params.id!, input, req.principal!, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json(sr);
  }),
);

// Close a service request (requires case:close permission)
serviceRequestsRouter.post(
  '/:id/close',
  authenticate,
  requirePermission(Permission.CASE_CLOSE),
  asyncHandler(async (req, res) => {
    const note = (req.body as { note?: string })?.note;
    const sr = await service.updateServiceRequest(
      req.params.id!,
      { status: 'closed', note },
      req.principal!,
      { ip: req.ip, userAgent: req.get('user-agent') },
    );
    res.json(sr);
  }),
);
