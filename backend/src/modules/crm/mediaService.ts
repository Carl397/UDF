import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '../../db/pool.js';
import type { Principal } from '../../auth/permissions.js';
import { uploadMedia, loadMediaForPrincipal } from '../transparency/service.js';
export { loadMediaForPrincipal };

/**
 * CRM media helpers for user profile photos (avatars).
 *
 * Storage reuses the transparency module's media pipeline (base64 data-url ->
 * SHA-256 hash -> `uploads/` -> `media_assets`), so avatars get the same
 * integrity hashing and on-disk layout as captured report imagery rather than a
 * second, divergent upload path.
 */

/** Store a base64 data-url as a media asset and return its id. */
export async function storeAvatar(
  dataUrl: string,
  principal: Principal,
): Promise<{ id: string }> {
  const stored = await uploadMedia({ dataUrl, captureMode: 'photo' }, principal, undefined, 'profile');
  return { id: stored.id };
}

/** Read a media asset's bytes for serving (CRM avatar previews). */
export async function loadMediaBuffer(
  id: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const res = await query<{ storage_key: string; content_type: string }>(
    `SELECT storage_key, content_type FROM media_assets WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  const buffer = await readFile(join(process.cwd(), row.storage_key));
  return { buffer, contentType: row.content_type };
}

/**
 * Serve a leader photo to anonymous visitors ONLY when that media asset is
 * actually published on a public `leaders` row. Anything else (report imagery,
 * internal avatars) stays behind authentication.
 */
export async function loadPublicLeaderMedia(
  id: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const gate = await query<{ id: string }>(
    `SELECT l.id FROM leaders l LEFT JOIN users u ON u.id = l.user_id
         WHERE l.photo_id = $1 AND l.is_public
           AND (l.user_id IS NULL OR (u.is_active AND u.role = 'ward_councillor' AND u.ward_code = l.ward_code))
           AND NOT EXISTS (SELECT 1 FROM resident_report_media WHERE media_asset_id = $1)
           AND NOT EXISTS (SELECT 1 FROM service_request_media WHERE media_asset_id = $1)
           AND NOT EXISTS (SELECT 1 FROM patrol_media WHERE media_asset_id = $1)
           AND NOT EXISTS (SELECT 1 FROM patrol_stops WHERE photo_id = $1)
           AND NOT EXISTS (SELECT 1 FROM project_media WHERE media_id = $1)
         LIMIT 1`,
    [id],
  );
  if (!gate.rows[0]) return null;
  return loadMediaBuffer(id);
}
