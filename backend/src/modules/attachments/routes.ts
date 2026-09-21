import { Router } from 'express';
import { authenticate, optionalAuthenticate } from '../../middleware/authenticate.js';
import { requireAnyPermission } from '../../middleware/authorize.js';
import { Permission } from '../../auth/permissions.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { ApiError } from '../../http/errors.js';
import { createAttachmentSchema, listAttachmentsQuery } from './schemas.js';
import * as svc from './service.js';

/**
 * /api/attachments — rich media (PDF / photo / short video) and URL links on a
 * ward bulletin or an event.
 *
 * Reads are gated by the parent's visibility (published content is public; a
 * bulletin draft only its ward staff), so the file route runs `optionalAuthenticate`.
 * Writes enforce the parent's own write permission and territory in the service,
 * so an attachment can never be pushed into a ward or region the caller does not
 * own.
 */
export const attachmentsRouter = Router();

// LIST — anonymous for published parents, staff-scoped for drafts.
attachmentsRouter.get(
  '/',
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const q = listAttachmentsQuery.parse(req.query);
    res.json({ items: await svc.listAttachments(q.parentType, q.parentId, req.principal ?? null) });
  }),
);

// ADD — file (base64) or link. `requireAnyPermission` fails a caller with no
// write capability fast; the service then enforces the PARENT-SPECIFIC permission
// (bulletin:write + ward, or event:write + territory) and territory.
attachmentsRouter.post(
  '/',
  authenticate,
  requireAnyPermission(Permission.BULLETIN_WRITE, Permission.EVENT_WRITE),
  asyncHandler(async (req, res) => {
    const input = createAttachmentSchema.parse(req.body);
    const att = await svc.createAttachment(input, req.principal!, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.status(201).json(att);
  }),
);

// REMOVE.
attachmentsRouter.delete(
  '/:id',
  authenticate,
  requireAnyPermission(Permission.BULLETIN_WRITE, Permission.EVENT_WRITE),
  asyncHandler(async (req, res) => {
    await svc.deleteAttachment(req.params.id!, req.principal!, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.status(204).end();
  }),
);

/**
 * SERVE a file attachment's bytes. `<img>` / `<video>` cannot send a bearer
 * token, so published parents answer anonymously; a draft is fetched by the CRM
 * as a blob with the token (see `attachmentFileBlob`). Links have no file.
 */
attachmentsRouter.get(
  '/:id/file',
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const file = await svc.loadAttachmentFile(req.params.id!, req.principal ?? null);
    if (!file) throw ApiError.notFound('Attachment file not found');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(file.buffer);
  }),
);
