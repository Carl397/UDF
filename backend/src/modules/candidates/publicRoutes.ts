import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../http/asyncHandler.js';
import { ApiError } from '../../http/errors.js';

/**
 * /api/public/candidates — the voter-facing "Meet our ward councillors" feed.
 * Only active candidates, in editorial order; the homepage hydrates a card grid
 * from this, and photos are served publicly as image bytes.
 */
export const candidatesPublicRouter = Router();

candidatesPublicRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const r = await query<{
      id: string;
      full_name: string;
      role_label: string;
      wards_label: string;
      bio: string;
      photo_media_id: string | null;
    }>(
      `SELECT id, full_name, role_label, wards_label, bio, photo_media_id
         FROM ward_candidates
        WHERE is_active
        ORDER BY sort_order ASC, full_name ASC`,
    );
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({
      items: r.rows.map((c) => ({
        id: c.id,
        fullName: c.full_name,
        roleLabel: c.role_label,
        wardsLabel: c.wards_label,
        bio: c.bio,
        hasPhoto: Boolean(c.photo_media_id),
      })),
    });
  }),
);

candidatesPublicRouter.get(
  '/:id/photo',
  asyncHandler(async (req, res) => {
    const r = await query<{ photo_media_id: string | null }>(
      'SELECT photo_media_id FROM ward_candidates WHERE id = $1 AND is_active',
      [req.params.id],
    );
    if (!r.rows[0]) throw ApiError.notFound('Candidate not found');
    if (!r.rows[0].photo_media_id) throw ApiError.notFound('Candidate has no photo');
    const asset = await query<{ storage_key: string; content_type: string }>(
      'SELECT storage_key, content_type FROM media_assets WHERE id = $1',
      [r.rows[0].photo_media_id],
    );
    if (!asset.rows[0]) throw ApiError.notFound('Photo not found');
    const buffer = await readFile(join(process.cwd(), asset.rows[0].storage_key));
    res.setHeader('Content-Type', asset.rows[0].content_type);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    // Public, no-auth image meant to be embedded anywhere. Helmet applies a global
    // CORP of `same-site`, which blocks the mobile WebView (origin http://localhost)
    // from rendering this cross-site inside an <img>; widen it for this response only.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(buffer);
  }),
);
