import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { authenticate } from '../../middleware/authenticate.js';
import { Permission } from '../../auth/permissions.js';
import { principalSeesWard } from '../../auth/scope.js';
import { recordAudit } from '../../security/audit.js';
import {
  createResidentReportSchema,
  createTransparencyRatingSchema,
  updateResidentReportSchema,
  uploadMediaSchema,
  wardLookupQuery,
} from './schemas.js';
import * as svc from './service.js';
import { getMediaPolicy, setMediaPolicy, mediaPolicySchema } from './mediaPolicy.js';

export const transparencyRouter = Router();

transparencyRouter.get('/media-policy', authenticate, async (_req, res, next) => {
  try { res.json(await getMediaPolicy()); } catch (err) { next(err); }
});
transparencyRouter.put('/media-policy', authenticate, requirePermission(Permission.MODULE_MANAGE), async (req, res, next) => {
  try { res.json(await setMediaPolicy(mediaPolicySchema.parse(req.body), req.principal!)); } catch (err) { next(err); }
});

/** FR-B: public geolocation ward + councillor + overview. Coords are ephemeral. */
transparencyRouter.get('/wards/councillor', async (req, res, next) => {
  try {
    const parsed = wardLookupQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
    }
    const { lat, lng, accuracyM } = parsed.data;
    const ward = await svc.resolveWardByPoint({ lat, lng, accuracyM });
    if (!ward) {
      return res.status(404).json({ error: 'No ward found for this location' });
    }
    const overview = await svc.getOverview(ward.code);
    res.json({
      ward,
      accuracyM: accuracyM ?? null,
      accurate: accuracyM == null || accuracyM <= 5,
      councillor: overview?.councillor ?? null,
      vacant: overview?.vacant ?? true,
      overview,
    });
  } catch (err) { next(err); }
});

/**
 * Reverse-geocode a fix to a { ward, street, suburb, area } label for the
 * "where am I" box on a resident report and a patrol stop. Any signed-in
 * caller may resolve their own current position; coordinates are not persisted
 * here. The street lookup is best-effort (server-side, so the tile-free app
 * makes no third-party call) and degrades to just the ward name.
 */
transparencyRouter.get('/reverse-geocode', authenticate, async (req, res, next) => {
  try {
    const parsed = wardLookupQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
    }
    res.json(await svc.reverseGeocode(parsed.data));
  } catch (err) { next(err); }
});
/** FR-C: public aggregate overview for any ward. */
transparencyRouter.get('/wards/:code/overview', async (req, res, next) => {
  try {
    const overview = await svc.getOverview(req.params.code!);
    if (!overview) return res.status(404).json({ error: 'Ward not found' });
    res.json(overview);
  } catch (err) { next(err); }
});

/** FR-D: member-gated ward detail (patrols / projects / logs + ratings). */
transparencyRouter.get('/wards/:code/detail', authenticate, async (req, res, next) => {
  try {
    const code = req.params.code!;
    const p = req.principal!;
    // Being staff does not confer territory. A ward_councillor is scoped to one
    // ward and a local_coordinator to their branch ward; only national-scope
    // principals (national_admin, analyst) may read any ward. Previously the
    // STAFF role list short-circuited the check entirely, so the W079
    // councillor could read the full patrol/project/case detail of the adjacent
    // control ward CPT-W043 — data belonging to a different councillor's
    // residents.
    if (!(await principalSeesWard(p, code))) {
      return res.status(403).json({ error: 'Detail is available only to members and staff of this ward' });
    }
    const detail = await svc.getDetail(code);
    if (!detail) return res.status(404).json({ error: 'Ward not found' });
    await recordAudit({
      action: 'transparency.detail.read',
      actorId: p.sub, actorRole: p.role,
      targetType: 'ward', targetId: code, regionCode: code,
      ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
    });
    res.json(detail);
  } catch (err) { next(err); }
});

/** FR-D5: ward-member rating (1-5, reason mandatory when <=2). */
transparencyRouter.post('/ratings', authenticate, requirePermission(Permission.RATING_WRITE), async (req, res, next) => {
  try {
    const parsed = createTransparencyRatingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const result = await svc.createRating(parsed.data, req.principal!, {
      ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

/** Councillor capture upload (stage imagery / reported pictures). */
transparencyRouter.post('/media', authenticate, requirePermission(Permission.CASE_LOG), async (req, res, next) => {
  try {
    const parsed = uploadMediaSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const result = await svc.uploadMedia(parsed.data, req.principal!);
    res.status(201).json(result);
  } catch (err) { next(err); }
});

/** Serve a media asset, enforcing the privacy tier. */
transparencyRouter.get('/media/:id', authenticate, async (req, res, next) => {
  try {
    const media = await svc.loadMediaForPrincipal(req.params.id!, req.principal!);
    if (!media) return res.status(404).json({ error: 'Media not found' });
    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(media.buffer);
  } catch (err) { next(err); }
});

/**
 * Resident → ward councillor report. Any signed-in resident/member may send
 * information (text + optional photo / video / voice note + optional location)
 * to their ward councillor. Media reuse the existing capture pipeline.
 *
 * Gated on `report:write` — the permission the `reports` module owns — so an
 * administrator who switches the module off removes the submit surface too
 * (member + the four staff roles hold it; analyst does not).
 */
transparencyRouter.post('/reports', authenticate, requirePermission(Permission.REPORT_WRITE), async (req, res, next) => {
  try {
    const parsed = createResidentReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const result = await svc.createResidentReport(parsed.data, req.principal!, {
      ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

/** List reports: `?scope=mine` (default) or `?scope=inbox` (councillor/staff). */
transparencyRouter.get(
  '/reports',
  authenticate,
  // The ward *inbox* (everyone's reports) is the staff-facing surface of the
  // `reports` module and requires `report:read`. `?scope=mine` (the default) is
  // a member reading their OWN reports and needs no permission, so the guard is
  // conditional on the requested scope — it is an inline arrow (no `__permission`
  // tag) precisely so route-inventory keeps reading this route as open-to-any-
  // authenticated-caller, which is what the default scope is.
  (req, res, next) => {
    if (req.query.scope === 'inbox') {
      return requirePermission(Permission.REPORT_READ)(req, res, next);
    }
    next();
  },
  async (req, res, next) => {
    try {
      const scope = req.query.scope === 'inbox' ? 'inbox' : 'mine';
      const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
      const offset = req.query.offset != null ? Number(req.query.offset) : undefined;
      const out = await svc.listResidentReports(req.principal!, { scope, limit, offset });
      res.json(out);
    } catch (err) { next(err); }
  },
);

/** One report (owner or ward staff). */
transparencyRouter.get('/reports/:id', authenticate, async (req, res, next) => {
  try {
    const report = await svc.getResidentReport(req.params.id!, req.principal!);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  } catch (err) { next(err); }
});

/**
 * Staff update: move the report through its lifecycle and/or write follow-up
 * feedback to the resident. Gated on `report:write` (the same permission the
 * `reports` module owns for the inbox), then territory-checked in the service.
 */
transparencyRouter.patch(
  '/reports/:id',
  authenticate,
  requirePermission(Permission.REPORT_WRITE),
  async (req, res, next) => {
    try {
      const parsed = updateResidentReportSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const report = await svc.updateResidentReport(req.params.id!, parsed.data, req.principal!, {
        ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null,
      });
      res.json(report);
    } catch (err) { next(err); }
  },
);
