import { z } from 'zod';

/**
 * Recruitment genealogy (PRD-growth FR-O).
 *
 * These are READ surfaces only. Recruitment edges are written exactly once, at
 * registration (`memberships/service.ts` resolves the referral code into
 * `members.referred_by_member_id`), and re-parenting is a separate national-only
 * audited action guarded by the DB cycle trigger — neither lives here.
 *
 * PRIVACY: no schema accepts or returns sealed PII. The tree/lineage/report speak
 * in member PUBLIC CODES (`UDF-XXX-YYY`, the QR verify token), tiers, join dates,
 * wards and aggregate counts. There is no upload field anywhere (mirrors the jobs
 * module's NG1 discipline).
 */

/** FR-O4: read a recruitment subtree. `root` defaults to the caller's own member. */
export const treeQuery = z.object({
  root: z.string().trim().uuid().optional(),
  /** Depth cap for the walk (PRD §10: default 8, hard max 16). */
  depth: z.coerce.number().int().min(1).max(16).default(8),
});
export type TreeQuery = z.infer<typeof treeQuery>;

/** FR-O5: trace one member up to the root source of their branch. */
export const lineageQuery = z.object({
  member: z.string().trim().uuid(),
});
export type LineageQuery = z.infer<typeof lineageQuery>;

/**
 * FR-O6: the ranked recruitment report. Scoped automatically to the caller's
 * territory (a member never reaches this — it is gated on `recruitment:report`);
 * `ward` narrows to a single ward within that scope.
 */
export const reportQuery = z.object({
  ward: z.string().trim().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ReportQuery = z.infer<typeof reportQuery>;
