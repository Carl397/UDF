import { z } from 'zod';

/**
 * Ward Job Interest Register & Opportunity Relay (PRD-jobs).
 *
 * HARD RULE (NG1): there is no upload field anywhere in these schemas — the
 * register captures name, email, work types and a short experience note only.
 */

/** A work-type code list; codes are validated against the live taxonomy in the service. */
const workTypes = z
  .array(z.string().min(1).max(24))
  .min(1, 'Select at least one type of work')
  .max(8);

/** FR-K1: member submits/updates their own job-interest row. */
export const upsertInterestSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  surname: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200),
  workTypes,
  /** Optional free-text skills/experience summary. No documents. */
  experience: z.string().trim().max(240).optional().or(z.literal('')),
});
export type UpsertInterest = z.infer<typeof upsertInterestSchema>;

/** FR-M1: councillor/staff record an opportunity. */
const opportunityFields = z.object({
  title: z.string().trim().min(1).max(140),
  company: z.string().trim().min(1).max(140),
  workTypes,
  description: z.string().trim().max(600).optional().or(z.literal('')),
  contactEmail: z.string().trim().email().max(200).optional().or(z.literal('')),
  contactPhone: z.string().trim().max(32).optional().or(z.literal('')),
  contactUrl: z.string().trim().url().max(300).optional().or(z.literal('')),
  projectId: z.string().uuid().optional(),
  /** Defaults to the author's own ward; staff may target a ward in scope. */
  wardCode: z.string().trim().max(32).optional(),
  /** ISO date (YYYY-MM-DD) the advert closes. */
  closesAt: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const createOpportunitySchema = opportunityFields.refine(
  (v) => Boolean(v.contactEmail || v.contactPhone || v.contactUrl),
  { message: 'A company contact (email, phone or URL) is required so members can apply directly', path: ['contactEmail'] },
);
export type CreateOpportunity = z.infer<typeof createOpportunitySchema>;

/** FR-M5: limited post-publish edit surface (ward is immutable after create). */
export const patchOpportunitySchema = opportunityFields.partial().omit({ wardCode: true });
export type PatchOpportunity = z.infer<typeof patchOpportunitySchema>;

/** Query for the aggregate demand view (FR-L). */
export const demandQuery = z.object({
  ward: z.string().trim().max(32).optional(),
});
export type DemandQuery = z.infer<typeof demandQuery>;

/** Query for opportunity lists. */
export const listOpportunitiesQuery = z.object({
  ward: z.string().trim().max(32).optional(),
  status: z.enum(['draft', 'published', 'closed', 'expired']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListOpportunitiesQuery = z.infer<typeof listOpportunitiesQuery>;

/** Anonymous public count query (FR-L4, flag-gated). */
export const publicCountQuery = z.object({
  ward: z.string().trim().max(32),
});
export type PublicCountQuery = z.infer<typeof publicCountQuery>;

// ── FR-N4: national-admin taxonomy + config ──────────────────────────────

/** A work-type code (URL-safe slug). Used for the taxonomy editor param. */
export const workTypeCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .regex(/^[a-z0-9_-]+$/, 'Use lowercase letters, numbers, hyphen or underscore');

/** Create-or-update a work type. `label` is required when the code is new. */
export const workTypeUpsertSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  active: z.boolean().optional(),
  sort: z.number().int().min(0).max(9999).optional(),
});
export type WorkTypeUpsert = z.infer<typeof workTypeUpsertSchema>;

/** Feature flags + relay template + demand windows (all optional; partial update). */
export const adminConfigSchema = z.object({
  flags: z
    .object({
      register: z.boolean().optional(),
      relay: z.boolean().optional(),
      publicCount: z.boolean().optional(),
    })
    .optional(),
  relayEmailSubject: z.string().trim().min(1).max(200).optional(),
  relayEmailBody: z.string().trim().min(1).max(2000).optional(),
  demandStaleDays: z.number().int().min(1).max(3650).optional(),
  duplicateGuardDays: z.number().int().min(1).max(365).optional(),
});
export type AdminConfig = z.infer<typeof adminConfigSchema>;
