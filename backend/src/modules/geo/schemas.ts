import { z } from 'zod';
import { TierListParam } from '../members/schemas.js';

const TIERS = ['voter', 'volunteer', 'activist', 'donor', 'candidate', 'staff'] as const;

export const geoQuerySchema = z.object({
  regionCode: z.string().max(32).optional(),
  districtCode: z.string().max(32).optional(),
  tier: z.enum(TIERS).optional(),
  /** Multi-select tier filter (map legend). Takes precedence over `tier`. */
  tiers: TierListParam,
  status: z
    .enum(['active', 'inactive', 'lapsed', 'suspended', 'pending'])
    .optional(),
  /** Heat-map grid resolution in degrees (only for /heatmap). */
  precision: z.coerce.number().min(0.001).max(5).default(0.05),
  /** Cap on returned points (only for /points). */
  limit: z.coerce.number().int().min(1).max(20000).default(5000),
  /**
   * Aggregation level for /choropleth. `subcouncil` is the default because
   * `members.region_code` holds the subcouncil code, which is what the layer has
   * always shaded; `ward` groups by `members.ward` for the drilled-in view.
   */
  level: z.enum(['subcouncil', 'ward']).optional(),
});

export type GeoQuery = z.infer<typeof geoQuerySchema>;

/** /region-summary — the same filters plus the region being inspected. */
export const regionSummarySchema = geoQuerySchema.extend({
  code: z.string().min(1).max(32),
});

export type RegionSummaryQuery = z.infer<typeof regionSummarySchema>;
