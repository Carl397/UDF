import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, requireRegionInScope, requireAnyPermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { Permission, isNationalScope } from '../../auth/permissions.js';
import { geoQuerySchema, regionSummarySchema } from './schemas.js';
import * as service from './service.js';
import { getHeatmapData } from '../patrols/service.js';
import type { MemberScope } from '../members/types.js';

/**
 * /api/geo — map, heat map, and choropleth data.
 * Requires geo:read (granted to analyst and above). Scope enforced: national
 * callers see everything, a regional caller only their regions, a ward-scoped
 * caller only their ward.
 */
export const geoRouter = Router();

function scopeFor(req: any): MemberScope {
  const p = req.principal;
  if (isNationalScope(p)) return null;
  return { ward: p.wardCode ?? null, regions: p.regionCodes ?? [] };
}

// ── Wave 4: the restricted member map ──────────────────────────────────────
// Mounted BEFORE the router-wide `requirePermission(GEO_READ)` below so a member
// — who holds `geo:read_own_ward` but NOT `geo:read` — can reach it. The guard
// accepts EITHER permission, and both handlers hard-scope to
// `principal.wardCode`, so a caller only ever receives their OWN ward: the
// subcouncil → ward shapes + councillor bio + service-delivery progress
// (my-ward), and the ward's non-private case heat (my-ward/heatmap). No member
// points, no choropleth, no cross-ward or municipality/region drill. A principal
// with no ward gets 404. Disabling the `map` module strips both permissions and
// so 403s here automatically.
geoRouter.get(
  '/my-ward',
  authenticate,
  requireAnyPermission(Permission.GEO_READ, Permission.GEO_READ_OWN_WARD),
  asyncHandler(async (req, res) => {
    res.json(await service.getMyWard(req.principal!));
  }),
);

geoRouter.get(
  '/my-ward/heatmap',
  authenticate,
  requireAnyPermission(Permission.GEO_READ, Permission.GEO_READ_OWN_WARD),
  asyncHandler(async (req, res) => {
    const wardCode = req.principal!.wardCode;
    if (!wardCode) {
      res.status(404).json({ error: 'No ward on record' });
      return;
    }
    // Reuses the case-heat aggregator (private cases excluded, ward scope AND-ed
    // inside the service) but pinned to the caller's OWN ward — the request
    // carries no wardCode, so it can never widen to another ward.
    res.json({ points: await getHeatmapData(req.principal!, wardCode) });
  }),
);

/**
 * Open / resolved / follow-up case counts for every area of all three map
 * layers, in one call — the numbers behind the static map's bar chart.
 *
 * Mounted with the member guard, and deliberately NOT territory-scoped, for the
 * same reason as `/boundaries` below: the payload is pure aggregate counts with
 * no reporter, coordinate or title in it, and the transparency module already
 * publishes the identical per-ward figures to anonymous visitors. Scoping it
 * would hide the movement's own service-delivery record from its members while
 * protecting nothing. The whole map's counts arrive together because the layer
 * buttons switch instantly and the payload is a few KB.
 */
geoRouter.get(
  '/case-stats',
  authenticate,
  requireAnyPermission(Permission.GEO_READ, Permission.GEO_READ_OWN_WARD),
  asyncHandler(async (_req, res) => {
    res.json(await service.getCaseStats());
  }),
);

geoRouter.use(authenticate, requirePermission(Permission.GEO_READ));

const regionGuard = requireRegionInScope((req) => (req.query.regionCode as string) || undefined);

// Point layer for the interactive map + client-side heatmap.
geoRouter.get(
  '/points',
  regionGuard,
  asyncHandler(async (req, res) => {
    const q = geoQuerySchema.parse(req.query);
    res.json(await service.getPoints(q, scopeFor(req)));
  }),
);

// Server-aggregated heat cells (efficient for dense data).
geoRouter.get(
  '/heatmap',
  regionGuard,
  asyncHandler(async (req, res) => {
    const q = geoQuerySchema.parse(req.query);
    res.json(await service.getHeatmap(q, scopeFor(req)));
  }),
);

// Per-region aggregates for choropleth shading.
geoRouter.get(
  '/choropleth',
  regionGuard,
  asyncHandler(async (req, res) => {
    const q = geoQuerySchema.parse(req.query);
    res.json(await service.getChoropleth(q, scopeFor(req)));
  }),
);

// Administrative boundary outlines (wards, subcouncils).
//
// Deliberately NOT territory-scoped. Boundary geometry is published civic
// geography: `GET /api/public/meta` already returns every region's code and name
// to anonymous visitors, and the transparency module publishes per-ward
// overviews. Scoping this would hide the map of the country from a councillor
// without protecting anything, so it is left national and the audit harness
// treats ward names/codes as part of the public baseline.
geoRouter.get(
  '/boundaries',
  asyncHandler(async (req, res) => {
    const level = (req.query.level as string) || 'ward';
    if (level !== 'ward' && level !== 'subcouncil') {
      res.status(400).json({ error: 'level must be ward or subcouncil' });
      return;
    }
    const parentCode = req.query.parentCode as string | undefined;
    res.json(await service.getBoundaries(level, parentCode));
  }),
);

/**
 * Drill-down for ONE region (the map's tap-a-shape sheet): its own member
 * counts, its children with their counts and published councillor, and — for a
 * ward — the public service-delivery overview.
 *
 * Deliberately NOT behind `regionGuard`: that guard tests `regionCode`, and a
 * ward-scoped principal legitimately drills into their own SUBCOUNCIL (the parent
 * of their ward), which the guard would refuse. Nothing is gained by refusing it
 * here either — every count is AND-ed with `scopeFor()` inside the service, so an
 * out-of-territory region returns zeros rather than data, region names/geometry
 * are the public baseline (see /boundaries), and the ward overview is already
 * served to anonymous visitors by the transparency module.
 */
geoRouter.get(
  '/region-summary',
  asyncHandler(async (req, res) => {
    const q = regionSummarySchema.parse(req.query);
    res.json(await service.getRegionSummary(q, scopeFor(req)));
  }),
);
