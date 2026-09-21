import { z } from 'zod';

/**
 * Public beacon contract for `POST /api/public/collect`.
 *
 * Intentionally tiny and forgiving: a pageview beacon should never fail because
 * a field was missing or a client sent a slightly different shape, so every
 * non-essential field is optional and clamped. Nothing here accepts free-form
 * PII — only a path, coarse utm tags and a numeric duration.
 */
export const collectSchema = z.object({
  site: z.enum(['marketing', 'app', 'crm']).default('marketing'),
  eventType: z.string().trim().min(1).max(64).default('pageview'),
  path: z.string().trim().max(512).optional(),
  referrer: z.string().trim().max(512).optional(),
  utmSource: z.string().trim().max(128).optional(),
  utmMedium: z.string().trim().max(128).optional(),
  utmCampaign: z.string().trim().max(128).optional(),
  screen: z.string().trim().max(16).optional(),
  lang: z.string().trim().max(16).optional(),
  durationMs: z.number().int().min(0).max(3_600_000).optional(),
  sessionId: z.string().trim().max(64).optional(),
});

export type CollectInput = z.infer<typeof collectSchema>;

/** Read-API window query shared by the superadmin analytics endpoints. */
export const windowQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  site: z.enum(['marketing', 'app', 'crm']).optional(),
});
