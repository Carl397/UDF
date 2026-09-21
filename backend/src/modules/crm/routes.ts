import { Router, type Request } from 'express';
import { asyncHandler } from '../../http/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { Permission, Role } from '../../auth/permissions.js';
import { query } from '../../db/pool.js';
import * as crmService from './service.js';
import * as userService from './userService.js';
import * as campaignService from './campaignService.js';
import * as mediaService from './mediaService.js';
import * as registryService from '../registry/service.js';

const router = Router();

/** Build the audit actor context from the authenticated request. */
function actorOf(req: Request): userService.ActorCtx {
  return {
    actorId: req.principal?.sub ?? null,
    actorRole: req.principal?.role ?? null,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    // The editor's live effective permissions, so userService can enforce the
    // no-escalation rule on permission grants/revokes.
    permissions: req.principal?.permissions,
  };
}

// Every CRM route requires `overview:read`, which national_admin,
// regional_organizer, ward_councillor and analyst hold — it is NOT a
// national_admin gate. Two consequences are enforced here rather than assumed:
//
//   • Routes that disclose more than an overview (the member directory and the
//     audit log) add a second, stricter permission. `analyst` holds
//     `overview:read` but neither `member:read` nor `audit:read`, so it can no
//     longer list members or read the entire audit trail.
//   • Everything returned is filtered to the caller's scope by the service
//     layer (auth/scope.ts), because a regional or ward principal reaching
//     these routes must not see data from outside its region/ward.
router.use(authenticate);
router.use(requirePermission(Permission.OVERVIEW_READ));

/**
 * GET /crm/dashboard
 * High-level metrics for the CRM dashboard, scoped to the caller's ward/region.
 */
router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const stats = await crmService.getDashboardStats(req.principal!);
    res.json(stats);
  }),
);

/**
 * GET /crm/engagements
 * Service requests with filters (ward, status, category, search), scoped to the
 * caller. `search` matches ref no / title / ward code / category — never the
 * reporter, whose identity is sealed (see `getEngagements`).
 */
router.get(
  '/engagements',
  asyncHandler(async (req, res) => {
    const filters = {
      ward: req.query.ward as string | undefined,
      status: req.query.status as string | undefined,
      category: req.query.category as string | undefined,
      search: req.query.search as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };
    const result = await crmService.getEngagements(req.principal!, filters);
    res.json(result);
  }),
);

/**
 * GET /crm/escalations
 * SLA breaches and stuck cases, scoped to the caller's ward/region.
 */
router.get(
  '/escalations',
  asyncHandler(async (req, res) => {
    const result = await crmService.getEscalations(req.principal!);
    res.json(result);
  }),
);

/**
 * GET /crm/members
 * Member list with filters (ward, tier, status, search), scoped to the caller.
 * Requires `member:read` on top of `overview:read` — analyst is excluded.
 */
router.get(
  '/members',
  requirePermission(Permission.MEMBER_READ),
  asyncHandler(async (req, res) => {
    const filters = {
      ward: req.query.ward as string | undefined,
      tier: req.query.tier as string | undefined,
      status: req.query.status as string | undefined,
      search: req.query.search as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };
    const result = await crmService.getMembers(req.principal!, filters);
    res.json(result);
  }),
);

/**
 * GET /crm/audit
 * Audit log with filters (action, actorRole).
 * Requires `audit:read` — national_admin only. The log records actor ids,
 * emails and PII-decryption events, so `overview:read` is not a sufficient
 * gate for it.
 */
router.get(
  '/audit',
  requirePermission(Permission.AUDIT_READ),
  asyncHandler(async (req, res) => {
    const filters = {
      action: req.query.action as string | undefined,
      actorRole: req.query.actorRole as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };
    const result = await crmService.getAuditLog(filters);
    res.json(result);
  }),
);

// ─ User Management (requires role:manage permission) ──────────────────────

/**
 * GET /crm/users
 * List system users with filters.
 */
router.get(
  '/users',
  requirePermission(Permission.ROLE_MANAGE),
  asyncHandler(async (req, res) => {
    const filters = {
      role: req.query.role as string | undefined,
      search: req.query.search as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };
    const result = await userService.listUsers(filters);
    res.json(result);
  }),
);

/**
 * GET /crm/users/:id
 * Get a single user by ID.
 */
router.get(
  '/users/:id',
  requirePermission(Permission.ROLE_MANAGE),
  asyncHandler(async (req, res) => {
    const user = await userService.getUser(req.params.id as string);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json(user);
  }),
);

/**
 * Validate a ward-code list against `regions` (the new TEXT[] columns have no
 * FK). Throws listing every unknown code so the CRM shows one clear error.
 */
async function assertKnownWards(wardCodes: unknown): Promise<string[] | undefined> {
  if (wardCodes === undefined) return undefined;
  const list = Array.isArray(wardCodes)
    ? wardCodes.map((x) => String(x ?? '').trim()).filter(Boolean)
    : [];
  if (!list.length) return list;
  const res = await query<{ code: string }>(
    `SELECT code FROM regions WHERE code = ANY($1) AND level = 'ward'`,
    [[...new Set(list)]],
  );
  const known = new Set(res.rows.map((r) => r.code));
  const unknown = [...new Set(list)].filter((c) => !known.has(c));
  if (unknown.length) {
    throw new Error(`unknown ward code${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  }
  return list;
}

/**
 * POST /crm/users
 * Create a new system user.
 */
router.post(
  '/users',
  requirePermission(Permission.ROLE_MANAGE),
  asyncHandler(async (req, res) => {
    const {
      email, password, role, fullName, regionCodes, wardCode, wardCodes,
      permissionGrants, permissionRevokes, avatarMediaId, bio, title,
    } = req.body;
    if (!email || !password || !role) {
      res.status(400).json({ error: 'email, password, and role are required' });
      return;
    }
    let normalizedWards;
    try {
      normalizedWards = await assertKnownWards(wardCodes);
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? 'invalid ward codes' });
      return;
    }
    const user = await userService.createUser(
      {
        email, password, role, fullName, regionCodes, wardCode,
        wardCodes: normalizedWards,
        permissionGrants, permissionRevokes, avatarMediaId, bio, title,
      },
      actorOf(req),
    );
    res.status(201).json(user);
  }),
);

/**
 * POST /crm/users/import
 * Bulk-provision users (e.g. a ward-councillor list) from parsed CSV rows.
 * Each row is created independently through the same `createUser` path (argon2
 * hash + sealed PII + blind index), so one bad row does not abort the batch.
 * Returns a per-row result summary.
 */
router.post(
  '/users/import',
  requirePermission(Permission.ROLE_MANAGE),
  asyncHandler(async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || rows.length === 0) {
      res.status(400).json({ error: 'rows[] is required' });
      return;
    }
    const defaultPassword = req.body?.defaultPassword as string | undefined;

    // Pre-validate ward codes against regions once (FK would otherwise throw).
    const wardCodes = [...new Set(
      rows.map((r: any) => String(r?.wardCode ?? '').trim()).filter(Boolean),
    )];
    const validWards = new Set<string>();
    if (wardCodes.length) {
      const wr = await query<{ code: string }>(
        `SELECT code FROM regions WHERE code = ANY($1)`,
        [wardCodes],
      );
      wr.rows.forEach((r) => validWards.add(r.code));
    }

    const results: Array<{ row: number; email: string; status: 'created' | 'skipped' | 'error'; message?: string }> = [];
    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const email = String(r?.email ?? '').trim();
      const role = String(r?.role ?? Role.WARD_COUNCILLOR).trim();
      const wardCode = String(r?.wardCode ?? '').trim() || null;
      const password = String(r?.password ?? defaultPassword ?? '');
      try {
        if (!email || !password || password.length < 10) {
          throw new Error('email and a password of at least 10 characters are required');
        }
        if (wardCode && !validWards.has(wardCode)) {
          throw new Error(`unknown ward code: ${wardCode}`);
        }
        const regionCodes = Array.isArray(r?.regionCodes)
          ? r.regionCodes.map((x: unknown) => String(x).trim()).filter(Boolean)
          : String(r?.regionCodes ?? '').split(',').map((x: string) => x.trim()).filter(Boolean);
        await userService.createUser(
          {
            email,
            password,
            role,
            fullName: String(r?.fullName ?? '').trim() || undefined,
            regionCodes,
            wardCode,
          },
          actorOf(req),
        );
        results.push({ row: i + 1, email, status: 'created' });
        created++;
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        const status = /already exists/i.test(msg) ? 'skipped' : 'error';
        if (status === 'skipped') skipped++; else failed++;
        results.push({ row: i + 1, email, status, message: msg });
      }
    }

    res.status(200).json({ total: rows.length, created, skipped, failed, results });
  }),
);

/**
 * PATCH /crm/users/:id
 * Update a user (email, role, regionCodes, wardCode, isActive, permission
 * overrides, avatar/bio/title).
 */
router.patch(
  '/users/:id',
  requirePermission(Permission.ROLE_MANAGE),
  asyncHandler(async (req, res) => {
    const {
      email, role, wardCode, wardCodes, regionCodes, isActive,
      permissionGrants, permissionRevokes, avatarMediaId, bio, title,
    } = req.body;
    let normalizedWards;
    try {
      normalizedWards = await assertKnownWards(wardCodes);
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? 'invalid ward codes' });
      return;
    }
    const user = await userService.updateUser(
      req.params.id as string,
      {
        email, role, wardCode, wardCodes: normalizedWards, regionCodes, isActive,
        permissionGrants, permissionRevokes, avatarMediaId, bio, title,
      },
      actorOf(req),
    );
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json(user);
  }),
);

/**
 * DELETE /crm/users/:id
 * Delete a user.
 */
router.delete(
  '/users/:id',
  requirePermission(Permission.ROLE_MANAGE),
  asyncHandler(async (req, res) => {
    await userService.deleteUser(req.params.id as string, actorOf(req));
    res.json({ success: true });
  }),
);

/**
 * POST /crm/users/:id/reset-password
 * Reset a user's password.
 */
router.post(
  '/users/:id/reset-password',
  requirePermission(Permission.ROLE_MANAGE),
  asyncHandler(async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword) {
      res.status(400).json({ error: 'newPassword is required' });
      return;
    }
    await userService.resetPassword(req.params.id as string, newPassword, actorOf(req));
    res.json({ success: true });
  }),
);

// ─ User profile media (avatars) ───────────────────────────────────────────

/**
 * POST /crm/media
 * Store a base64 data-url as a media asset (reuses the transparency upload
 * pipeline) and return its id, for attaching to a user as avatarMediaId.
 */
router.post(
  '/media',
  requirePermission(Permission.ROLE_MANAGE),
  asyncHandler(async (req, res) => {
    const dataUrl = req.body?.dataUrl as string | undefined;
    if (!dataUrl) {
      res.status(400).json({ error: 'dataUrl is required' });
      return;
    }
    const stored = await mediaService.storeAvatar(dataUrl, req.principal!);
    res.status(201).json({ id: stored.id, url: `/api/crm/media/${stored.id}` });
  }),
);

/**
 * GET /crm/media/:id
 * Stream a stored media asset for CRM avatar previews (any authenticated CRM
 * caller; the asset ids are unguessable UUIDs and carry no PII beyond a photo).
 */
router.get(
  '/media/:id',
  asyncHandler(async (req, res) => {
    const media = await mediaService.loadMediaForPrincipal(req.params.id as string, req.principal!);
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
 * GET /crm/roles/:role/permissions
 * Get permissions for a role.
 */
router.get(
  '/roles/:role/permissions',
  requirePermission(Permission.ROLE_MANAGE),
  asyncHandler(async (req, res) => {
    const permissions = await userService.getRolePermissions(req.params.role as string);
    res.json({ role: req.params.role, permissions });
  }),
);

// ─ Marketing Campaigns (writes require notify:write) ─────────────────────

/**
 * GET /crm/campaigns
 * List marketing campaigns with filters (status, search).
 */
router.get(
  '/campaigns',
  asyncHandler(async (req, res) => {
    const filters = {
      status: req.query.status as string | undefined,
      search: req.query.search as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };
    const result = await campaignService.listCampaigns(filters);
    res.json(result);
  }),
);

/**
 * GET /crm/campaigns/:id
 */
router.get(
  '/campaigns/:id',
  asyncHandler(async (req, res) => {
    const campaign = await campaignService.getCampaign(req.params.id as string);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    res.json(campaign);
  }),
);

/**
 * POST /crm/campaigns
 */
router.post(
  '/campaigns',
  requirePermission(Permission.NOTIFY_WRITE),
  asyncHandler(async (req, res) => {
    const { title, description, target_audience, start_date, end_date, status } = req.body;
    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    const campaign = await campaignService.createCampaign({
      title, description, target_audience, start_date, end_date, status,
      created_by: req.principal?.sub,
    });
    res.status(201).json(campaign);
  }),
);

/**
 * PATCH /crm/campaigns/:id
 */
router.patch(
  '/campaigns/:id',
  requirePermission(Permission.NOTIFY_WRITE),
  asyncHandler(async (req, res) => {
    const campaign = await campaignService.updateCampaign(req.params.id as string, req.body);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    res.json(campaign);
  }),
);

/**
 * DELETE /crm/campaigns/:id
 */
router.delete(
  '/campaigns/:id',
  requirePermission(Permission.NOTIFY_WRITE),
  asyncHandler(async (req, res) => {
    await campaignService.deleteCampaign(req.params.id as string);
    res.json({ success: true });
  }),
);

/**
 * POST /crm/campaigns/:id/engagement
 * Increment engagement metrics (clicks, shares, conversions).
 */
router.post(
  '/campaigns/:id/engagement',
  requirePermission(Permission.NOTIFY_WRITE),
  asyncHandler(async (req, res) => {
    const { clicks, shares, conversions } = req.body;
    const campaign = await campaignService.recordEngagement(req.params.id as string, { clicks, shares, conversions });
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    res.json(campaign);
  }),
);

/**
 * GET /crm/modules
 * The module registry with the per-role gate matrix, for the CRM → Settings →
 * Module registry editor. Gated on `module:manage` (national_admin only) on top
 * of the router-level `overview:read`: the registry can strip a role's access to
 * a whole feature surface, so it must not be readable by the broader CRM
 * audience that `overview:read` admits (regional_organizer, ward_councillor and
 * analyst all hold it).
 */
router.get(
  '/modules',
  requirePermission(Permission.MODULE_MANAGE),
  asyncHandler(async (_req, res) => {
    res.json(await registryService.getRegistry());
  }),
);

/**
 * PUT /crm/modules/:role/:key
 * Enable or disable one module for one role (`{ enabled: boolean }`). The service
 * upserts the gate row, writes an audited `module.gate_change`, and rejects a
 * national-admin lockout (400 `module_lockout`) before touching the DB — an
 * administrator can never switch off the module they need to reach this editor.
 */
router.put(
  '/modules/:role/:key',
  requirePermission(Permission.MODULE_MANAGE),
  asyncHandler(async (req, res) => {
    const { role, key } = req.params as { role: string; key: string };
    const enabled = (req.body as { enabled?: unknown })?.enabled;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    const result = await registryService.setGate(role, key, enabled, {
      actorId: req.principal?.sub ?? null,
      actorRole: req.principal?.role ?? null,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json(result);
  }),
);

export { router as crmRouter };
