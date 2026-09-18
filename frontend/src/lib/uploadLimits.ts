/**
 * Upload size limits, mirrored from the backend so the UI can state the cap
 * up-front and refuse an oversized file before it is sent.
 *
 * Server caps below must stay in sync with their backend counterparts.
 * Smaller client preparation budgets are called out separately:
 *  - `MEDIA_DATAURL_MAX`  ← `reportMediaSchema` / `patrolMediaSchema` /
 *    `caseMediaSchema` `dataUrl: z.string().max(8 * 1024 * 1024)`
 *  - `CARD_PHOTO_DATAURL_MAX` ← `setPhotoBody` `dataUrl: max(12_000_000)`
 *  - `REQUEST_MAX` ← `express.json({ limit: '25mb' })` in `backend/src/app.ts`
 *    and nginx `client_max_body_size 25m`
 *
 * Sizes are measured on the base64 **data URL** (what actually crosses the
 * wire), not the raw file, because that is what the server validates. A data
 * URL is ~1.33x the original file, and the limits below are expressed the same
 * way so the number shown to the user is the number enforced.
 */

/** Per-attachment cap for report / patrol / case-log media. */
export const MEDIA_DATAURL_MAX = 8 * 1024 * 1024;

/** Per-file cap for a member's ID-card photo. */
export const CARD_PHOTO_DATAURL_MAX = 12_000_000;

/** Whole-request cap enforced by Express and nginx. */
export const REQUEST_MAX = 25 * 1024 * 1024;

/**
 * Total attachment budget for one submission. Deliberately below `REQUEST_MAX`:
 * the per-file cap times the allowed file count (e.g. 10 x 8 MB) is far more
 * than one request may carry, so without a total budget a user could attach
 * files that each pass validation and still have the whole submission rejected
 * as "request entity too large". The headroom covers the message text, the
 * JSON envelope and base64 padding.
 */
export const MEDIA_TOTAL_MAX = 20 * 1024 * 1024;

/** Existing client-side image preparation budgets (encoded bytes). */
export const CARD_PHOTO_UPLOAD_MAX = 1_500_000;
export const CARD_LOGO_UPLOAD_MAX = 4_000_000;
export const AVATAR_UPLOAD_MAX = 200_000;
/** Client import budget, leaving room inside the whole-request cap. */
export const IMPORT_MAX = 20 * 1024 * 1024;

/** Human size, e.g. `8 MB` / `512 KB`. Whole numbers where they read cleanly. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(2)} MB`;
  }
  return bytes === 0 ? '0 KB' : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The wire size of a data URL, in bytes. */
export function dataUrlBytes(dataUrl: string): number {
  return dataUrl.length;
}

/** Validate both captured files and the final submission before sending. */
export function mediaLimitError(sizes: number[], maxFiles: number): string | null {
  if (sizes.length > maxFiles) return `You can attach at most ${maxFiles} files.`;
  if (sizes.some((n) => n > MEDIA_DATAURL_MAX)) {
    return `Maximum ${formatBytes(MEDIA_DATAURL_MAX)} encoded per photo, video or voice note (about 6 MB original). Choose a smaller file or shorter recording.`;
  }
  if (sizes.reduce((total, n) => total + n, 0) > MEDIA_TOTAL_MAX) {
    return `Maximum ${formatBytes(MEDIA_TOTAL_MAX)} encoded in one submission. Remove an attachment to proceed.`;
  }
  return null;
}
