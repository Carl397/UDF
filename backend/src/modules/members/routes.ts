import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, requireRegionInScope } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { Permission, roleHasPermission } from '../../auth/permissions.js';
import { ApiError } from '../../http/errors.js';
import {
  createMemberSchema,
  updateMemberSchema,
  listMembersQuerySchema,
  idParamSchema,
} from './schemas.js';
import * as service from './service.js';
import { changeOwnWard, changeOwnWardSchema, getOwnWardChanges } from './wardChanges.js';

/**
 * /api/members — CRUD for party members.
 * All routes require authentication; permissions gate each action; PII
 * decryption is a separate, audited, explicitly-requested operation.
 */
export const membersRouter = Router();

function actorCtx(req: any) {
  return {
    actorId: req.principal?.sub ?? null,
    actorRole: req.principal?.role ?? null,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

membersRouter.use(authenticate);

// Own profile only; no member-directory or staff write permission is granted.
membersRouter.get('/me/ward', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await getOwnWardChanges(req.principal!));
}));
membersRouter.patch('/me/ward', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await changeOwnWard(req.principal!, changeOwnWardSchema.parse(req.body)));
}));

// LIST — member:read, scope-limited results (ward for a councillor/member,
// regions for a regional organizer, unfiltered only for national scope).
//
// `?pii=true` is REFUSED here rather than silently ignored. Previously the list
// schema dropped the unknown parameter, so a caller without `member:pii_decrypt`
// got a 200 and no indication that decryption had not happened — and a caller
// WITH the permission could bulk-decrypt an entire directory in one request.
// Sealed PII is disclosed one record at a time through GET /api/members/:id,
// where each decryption is audited individually.
membersRouter.get(
  '/',
  requirePermission(Permission.MEMBER_READ),
  requireRegionInScope((req) => (req.query.regionCode as string) || undefined),
  asyncHandler(async (req, res) => {
    if (req.query.pii === 'true' || req.query.pii === '1') {
      if (!roleHasPermission(req.principal!.role, Permission.PII_DECRYPT)) {
        throw ApiError.forbidden('Missing permission: member:pii_decrypt');
      }
      throw ApiError.badRequest(
        'Bulk PII disclosure is not permitted. Request GET /api/members/:id?pii=true for a single member.',
      );
    }
    const q = listMembersQuerySchema.parse(req.query);
    const result = await service.listMembers(q, req.principal!);
    res.json(result);
  }),
);

// CREATE — member:write.
membersRouter.post(
  '/',
  requirePermission(Permission.MEMBER_WRITE),
  requireRegionInScope((req) => (req.body as any)?.regionCode),
  asyncHandler(async (req, res) => {
    const input = createMemberSchema.parse(req.body);
    const member = await service.createMember(input, {
      principal: req.principal!,
      ...actorCtx(req),
    });
    res.status(201).json(member);
  }),
);

// READ (single) — member:read. `?pii=true` requests decryption (needs PII_DECRYPT).
membersRouter.get(
  '/:id',
  requirePermission(Permission.MEMBER_READ),
  asyncHandler(async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const wantsPii = req.query.pii === 'true' || req.query.pii === '1';

    if (wantsPii) {
      if (!roleHasPermission(req.principal!.role, Permission.PII_DECRYPT)) {
        throw ApiError.forbidden('Missing permission: member:pii_decrypt');
      }
    }

    const member = await service.getMember(id, req.principal!, {
      decryptPii: wantsPii,
      ...actorCtx(req),
    });
    res.json(member);
  }),
);

// UPDATE — member:write.
membersRouter.patch(
  '/:id',
  requirePermission(Permission.MEMBER_WRITE),
  asyncHandler(async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    const input = updateMemberSchema.parse(req.body);
    const member = await service.updateMember(id, input, {
      principal: req.principal!,
      ...actorCtx(req),
    });
    res.json(member);
  }),
);

// DELETE — member:delete (soft delete / right-to-erasure).
membersRouter.delete(
  '/:id',
  requirePermission(Permission.MEMBER_DELETE),
  asyncHandler(async (req, res) => {
    const { id } = idParamSchema.parse(req.params);
    await service.deleteMember(id, { principal: req.principal!, ...actorCtx(req) });
    res.status(204).end();
  }),
);
