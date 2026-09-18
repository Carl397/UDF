import { z } from 'zod';

/**
 * Councillor performance scorecards (PRD-growth FR-S).
 *
 * One WRITE surface — a member rates THEIR OWN ward councillor once per calendar
 * month across the five fixed categories — plus the READ filters the councillor/
 * staff inbox and the CRM rollups use.
 *
 * PRIVACY: no schema accepts or returns sealed PII. Identity travels as the
 * member's PUBLIC CODE and only when the member opted into `shareName` (FR-S7) —
 * the same discipline the recruitment module holds (AC-O2). The reasons are the
 * actionable content; who wrote them stays hidden by default.
 *
 * The 100-word rule (FR-S3) is deliberately NOT enforced here. It is a word count
 * on the trimmed reason, which the service computes so it can return a precise,
 * per-category message ("Availability & accessibility: a score of 2 needs …
 * (you wrote 63)"). These schemas validate shape only: score 1–5, a known
 * category, a bounded reason length.
 */

/** The five fixed rating categories (FR-S1). Mirrors the `rating_category` enum. */
export const RATING_CATEGORIES = [
  'accessibility',
  'service_delivery',
  'communication',
  'accountability',
  'presence',
] as const;
export type RatingCategory = (typeof RATING_CATEGORIES)[number];

/** One category's score plus its conditionally-compulsory reason (FR-S1/S3). */
const scorecardItem = z.object({
  category: z.enum(RATING_CATEGORIES),
  score: z.number().int().min(1).max(5),
  reason: z.string().trim().max(4000).optional().nullable(),
});

/**
 * FR-S2/S3: submit or update THIS calendar month's scorecard. The month is
 * derived server-side (never trusted from the client, so a caller cannot pin a
 * submission to a past or future period); a re-submit updates the month's row
 * until it is acknowledged, after which it is frozen.
 */
export const submitScorecard = z.object({
  items: z.array(scorecardItem).min(1).max(RATING_CATEGORIES.length),
  /** FR-S7: reveal my membership reference to the councillor so they can follow up. */
  shareName: z.boolean().optional().default(false),
});
export type SubmitScorecard = z.infer<typeof submitScorecard>;

/** FR-S6: acknowledge a submission, with an optional short note back to the member. */
export const acknowledgeBody = z.object({
  note: z.string().trim().max(1000).optional().nullable(),
});
export type AcknowledgeBody = z.infer<typeof acknowledgeBody>;

/**
 * READ filter for the inbox / summary / low-reasons rollups. `period` is a
 * calendar month (`YYYY-MM`); omitted ⇒ the current month. `ward` narrows within
 * the caller's scope (out-of-scope ⇒ 403); `status` filters the acknowledgement
 * lifecycle. Scoped automatically to the caller's territory — a ward councillor
 * only ever reaches their own ward.
 */
export const rollupQuery = z.object({
  period: z.string().trim().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM').optional(),
  ward: z.string().trim().max(32).optional(),
  status: z.enum(['submitted', 'viewed', 'acknowledged']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type RollupQuery = z.infer<typeof rollupQuery>;

/** A member's own scorecard history across months (FR-S2). */
export const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(60).default(24),
});
export type HistoryQuery = z.infer<typeof historyQuery>;

/** `{ id }` path param for the view / acknowledge transitions. */
export const idParam = z.object({
  id: z.string().trim().uuid(),
});
export type IdParam = z.infer<typeof idParam>;
