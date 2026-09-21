import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query, withTransaction } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';
import type { Principal } from '../../auth/permissions.js';
import { uploadMedia } from '../transparency/service.js';

/**
 * Structured website content (field-based, versioned, rollbackable).
 *
 * A block is a named JSON document with a `schema` (what the editor renders) and
 * a `draft`/`published` payload pair. Editing writes the draft; publishing copies
 * draft→published, bumps the version and snapshots the whole payload into
 * content_block_versions, so any release can be rolled back. There is no raw HTML
 * anywhere — the public read API only ever serves `published`, never `draft`.
 */

export type BlockKind = 'fields' | 'slider' | 'section';

export interface ContentBlock {
  key: string;
  site: 'marketing' | 'app' | 'shared';
  title: string;
  kind: BlockKind;
  schema: unknown;
  draft: unknown;
  published: unknown;
  version: number;
  updatedAt: string;
  publishedAt: string | null;
}

/** One entry in a page's ordered `sections` array. */
export interface PageSection {
  blockKey: string;
}

export interface ContentPage {
  slug: string;
  site: 'marketing' | 'app';
  title: string;
  sections: PageSection[];
  publishedSections: PageSection[] | null;
  publishedTitle: string | null;
  version: number;
  isActive: boolean;
  updatedAt: string;
  publishedAt: string | null;
}

export async function listBlocks(): Promise<Array<Omit<ContentBlock, 'schema' | 'draft' | 'published'>>> {
  const { rows } = await query(
    `SELECT key, site, title, kind, version, updated_at AS "updatedAt", published_at AS "publishedAt",
            (published IS NOT NULL) AS "hasPublished",
            (draft IS DISTINCT FROM published) AS "hasUnpublishedChanges"
       FROM content_blocks ORDER BY site, key`,
  );
  return rows;
}

export async function getBlock(key: string): Promise<ContentBlock | null> {
  const { rows } = await query<ContentBlock & { updated_at: string }>(
    `SELECT key, site, title, kind, schema, draft, published, version,
            updated_at AS "updatedAt", published_at AS "publishedAt"
       FROM content_blocks WHERE key = $1`,
    [key],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    key: r.key,
    site: r.site,
    title: r.title,
    kind: r.kind,
    schema: r.schema,
    draft: r.draft,
    published: r.published,
    version: r.version,
    updatedAt: r.updatedAt,
    publishedAt: r.publishedAt,
  };
}

/** Save the working draft for a block (does not affect the published payload). */
export async function saveDraft(
  key: string,
  draft: unknown,
  principal: Principal,
): Promise<ContentBlock | null> {
  await query(
    `UPDATE content_blocks
        SET draft = $2::jsonb, updated_by = $3, updated_at = now()
      WHERE key = $1`,
    [key, JSON.stringify(draft ?? {}), principal.sub],
  );
  return getBlock(key);
}

/** Publish the current draft: copy draft→published, bump version, snapshot. */
export async function publishBlock(key: string, principal: Principal): Promise<ContentBlock | null> {
  return withTransaction(async (client) => {
    const cur = await client.query<{ version: number; draft: unknown }>(
      `SELECT version, draft FROM content_blocks WHERE key = $1 FOR UPDATE`,
      [key],
    );
    const row = cur.rows[0];
    if (!row) throw ApiError.notFound('Content block not found');
    const nextVersion = row.version + 1;
    await client.query(
      `UPDATE content_blocks
          SET published = draft, version = $2, updated_by = $3,
              updated_at = now(), published_at = now()
        WHERE key = $1`,
      [key, nextVersion, principal.sub],
    );
    await client.query(
      `INSERT INTO content_block_versions (key, version, payload, published_by)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (key, version) DO NOTHING`,
      [key, nextVersion, JSON.stringify(row.draft ?? {}), principal.sub],
    );
    return row;
  }).then(() => getBlock(key));
}

/** Roll a block's published payload back to a prior snapshot version. */
export async function rollbackBlock(
  key: string,
  toVersion: number,
  principal: Principal,
): Promise<ContentBlock | null> {
  return withTransaction(async (client) => {
    const snap = await client.query<{ payload: unknown }>(
      `SELECT payload FROM content_block_versions WHERE key = $1 AND version = $2`,
      [key, toVersion],
    );
    if (!snap.rows[0]) throw ApiError.notFound('Version snapshot not found');
    const cur = await client.query<{ version: number }>(
      `SELECT version FROM content_blocks WHERE key = $1 FOR UPDATE`,
      [key],
    );
    if (!cur.rows[0]) throw ApiError.notFound('Content block not found');
    const nextVersion = cur.rows[0].version + 1;
    await client.query(
      `UPDATE content_blocks
          SET published = payload, version = $2, updated_by = $3,
              updated_at = now(), published_at = now()
         FROM content_block_versions
        WHERE content_blocks.key = $1 AND content_block_versions.key = $1
          AND content_block_versions.version = $4`,
      [key, nextVersion, principal.sub, toVersion],
    );
    await client.query(
      `INSERT INTO content_block_versions (key, version, payload, published_by)
       SELECT $1, $2, payload, $3 FROM content_block_versions
        WHERE key = $1 AND version = $4
       ON CONFLICT (key, version) DO NOTHING`,
      [key, nextVersion, principal.sub, toVersion],
    );
    return cur.rows[0];
  }).then(() => getBlock(key));
}

/** Version history (metadata only) for a block. */
export async function listVersions(key: string) {
  const { rows } = await query(
    `SELECT version, created_at AS "createdAt", published_by AS "publishedBy"
       FROM content_block_versions WHERE key = $1 ORDER BY version DESC LIMIT 50`,
    [key],
  );
  return rows;
}

/** The public read model: every published block for a site, keyed. */
export async function getPublishedBlocks(site?: 'marketing' | 'app' | 'shared') {
  const { rows } = await query<{ key: string; published: unknown; published_at: string }>(
    site
      ? `SELECT key, published, published_at FROM content_blocks
          WHERE site IN ($1,'shared') AND published IS NOT NULL ORDER BY key`
      : `SELECT key, published, published_at FROM content_blocks
          WHERE published IS NOT NULL ORDER BY key`,
    site ? [site] : [],
  );
  return Object.fromEntries(rows.map((r) => [r.key, { data: r.published, publishedAt: r.published_at }]));
}

// ── Block authoring (create / delete) ──────────────────────────────────────

/** Empty draft payload for a brand-new block, shaped by its kind. */
function emptyDraftForKind(kind: BlockKind): Record<string, unknown> {
  if (kind === 'slider') return { slides: [] };
  return {};
}

/** pg's unique-violation code; create paths translate it into a clean 409. */
function isUniqueViolation(err: unknown): boolean {
  return typeof (err as { code?: unknown })?.code === 'string' && (err as { code: string }).code === '23505';
}

export async function createBlock(input: {
  key: string;
  site: ContentBlock['site'];
  title: string;
  kind: BlockKind;
  schema: unknown;
}, principal: Principal): Promise<ContentBlock> {
  const existing = await query('SELECT 1 FROM content_blocks WHERE key = $1', [input.key]);
  if (existing.rowCount) throw ApiError.conflict('A block with that key already exists');
  try {
    await query(
      `INSERT INTO content_blocks (key, site, title, kind, schema, draft, updated_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
      [input.key, input.site, input.title, input.kind, JSON.stringify(input.schema ?? {}),
        JSON.stringify(emptyDraftForKind(input.kind)), principal.sub],
    );
  } catch (err) {
    // The pre-check above is not atomic; a concurrent create surfaces as 23505.
    if (isUniqueViolation(err)) throw ApiError.conflict('A block with that key already exists');
    throw err;
  }
  const block = await getBlock(input.key);
  if (!block) throw ApiError.internal('Block created but could not be read back');
  return block;
}

/** Delete a block. Refuses if any page still references it (draft or live). */
export async function deleteBlock(key: string, principal: Principal): Promise<void> {
  const block = await getBlock(key);
  if (!block) throw ApiError.notFound('Content block not found');
  const inUse = await query(
    `SELECT 1 FROM content_pages
        WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(sections) e WHERE e->>'blockKey' = $1)
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(published_sections,'[]'::jsonb)) e WHERE e->>'blockKey' = $1)
        LIMIT 1`,
    [key],
  );
  if (inUse.rowCount) throw ApiError.conflict('Remove this block from every page before deleting it');
  await query('DELETE FROM content_blocks WHERE key = $1', [key]);
  void principal;
}

// ── Pages (ordered sections of blocks) ─────────────────────────────────────

function mapPage(r: {
  slug: string; site: 'marketing' | 'app'; title: string;
  sections: PageSection[] | null; published_sections: PageSection[] | null;
  published_title: string | null; version: number; is_active: boolean;
  updated_at: string; published_at: string | null;
}): ContentPage {
  return {
    slug: r.slug,
    site: r.site,
    title: r.title,
    sections: r.sections ?? [],
    publishedSections: r.published_sections ?? null,
    publishedTitle: r.published_title,
    version: r.version,
    isActive: r.is_active,
    updatedAt: r.updated_at,
    publishedAt: r.published_at,
  };
}

const PAGE_FIELDS = `slug, site, title, sections, published_sections, published_title,
  version, is_active, updated_at, published_at`;

export async function listPages(site?: ContentPage['site']): Promise<Array<Omit<ContentPage, 'sections' | 'publishedSections'> & { sectionCount: number }>> {
  const { rows } = await query(
    `SELECT slug, site, title, version, is_active AS "isActive",
            updated_at AS "updatedAt", published_at AS "publishedAt",
            jsonb_array_length(sections) AS "sectionCount",
            (published_sections IS NOT NULL) AS "hasPublished",
            (sections IS DISTINCT FROM published_sections OR title IS DISTINCT FROM published_title) AS "hasUnpublishedChanges"
       FROM content_pages ${site ? 'WHERE site = $1' : ''} ORDER BY site, slug`,
    site ? [site] : [],
  );
  return rows;
}

export async function getPage(slug: string): Promise<ContentPage | null> {
  const { rows } = await query(
    `SELECT ${PAGE_FIELDS} FROM content_pages WHERE slug = $1`,
    [slug],
  );
  return rows[0] ? mapPage(rows[0]) : null;
}

/** Admin view: the page plus each referenced block's draft payload. */
export async function getPageWithBlocks(slug: string) {
  const page = await getPage(slug);
  if (!page) return null;
  const blocks = await Promise.all(page.sections.map((s) => getBlock(s.blockKey)));
  return { page, blocks: blocks.filter(Boolean) as ContentBlock[] };
}

export async function createPage(input: {
  slug: string; site: ContentPage['site']; title: string;
}, principal: Principal): Promise<ContentPage> {
  const existing = await query('SELECT 1 FROM content_pages WHERE slug = $1', [input.slug]);
  if (existing.rowCount) throw ApiError.conflict('A page with that slug already exists');
  try {
    await query(
      `INSERT INTO content_pages (slug, site, title, updated_by) VALUES ($1, $2, $3, $4)`,
      [input.slug, input.site, input.title, principal.sub],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw ApiError.conflict('A page with that slug already exists');
    throw err;
  }
  const page = await getPage(input.slug);
  if (!page) throw ApiError.internal('Page created but could not be read back');
  return page;
}

export async function renamePage(slug: string, title: string, principal: Principal): Promise<ContentPage | null> {
  await query(`UPDATE content_pages SET title = $2, updated_by = $3, updated_at = now() WHERE slug = $1`,
    [slug, title, principal.sub]);
  return getPage(slug);
}

/** Replace the whole ordered draft section list. Validates every key exists. */
export async function updatePageSections(
  slug: string,
  sections: PageSection[],
  principal: Principal,
): Promise<ContentPage | null> {
  const keys = sections.map((s) => s.blockKey);
  if (new Set(keys).size !== keys.length) throw ApiError.badRequest('A page cannot reference the same block twice');
  if (keys.length) {
    const found = await query<{ key: string }>(
      `SELECT key FROM content_blocks WHERE key = ANY($1::text[])`,
      [keys],
    );
    const missing = keys.filter((k) => !found.rows.some((f) => f.key === k));
    if (missing.length) throw ApiError.badRequest(`Unknown block(s): ${missing.join(', ')}`);
  }
  await query(
    `UPDATE content_pages SET sections = $2::jsonb, updated_by = $3, updated_at = now() WHERE slug = $1`,
    [slug, JSON.stringify(sections), principal.sub],
  );
  return getPage(slug);
}

export async function deletePage(slug: string): Promise<void> {
  const r = await query('DELETE FROM content_pages WHERE slug = $1', [slug]);
  if (!r.rowCount) throw ApiError.notFound('Page not found');
}

export async function publishPage(slug: string, principal: Principal): Promise<ContentPage | null> {
  return withTransaction(async (client) => {
    const cur = await client.query<{ version: number; title: string; sections: PageSection[] }>(
      `SELECT version, title, sections FROM content_pages WHERE slug = $1 FOR UPDATE`,
      [slug],
    );
    const row = cur.rows[0];
    if (!row) throw ApiError.notFound('Page not found');
    const nextVersion = row.version + 1;
    await client.query(
      `UPDATE content_pages
          SET published_sections = sections, published_title = title, version = $2,
              updated_by = $3, updated_at = now(), published_at = now()
        WHERE slug = $1`,
      [slug, nextVersion, principal.sub],
    );
    await client.query(
      `INSERT INTO content_page_versions (slug, version, snapshot, published_by)
       VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (slug, version) DO NOTHING`,
      [slug, nextVersion, JSON.stringify({ title: row.title, sections: row.sections ?? [] }), principal.sub],
    );
    return row;
  }).then(() => getPage(slug));
}

export async function rollbackPage(slug: string, toVersion: number, principal: Principal): Promise<ContentPage | null> {
  return withTransaction(async (client) => {
    const snap = await client.query<{ snapshot: { title: string; sections: PageSection[] } }>(
      `SELECT snapshot FROM content_page_versions WHERE slug = $1 AND version = $2`,
      [slug, toVersion],
    );
    if (!snap.rows[0]) throw ApiError.notFound('Version snapshot not found');
    const cur = await client.query<{ version: number }>(
      `SELECT version FROM content_pages WHERE slug = $1 FOR UPDATE`,
      [slug],
    );
    if (!cur.rows[0]) throw ApiError.notFound('Page not found');
    const nextVersion = cur.rows[0].version + 1;
    const restored = snap.rows[0].snapshot;
    await client.query(
      `UPDATE content_pages
          SET published_sections = $2::jsonb, published_title = $3, version = $4,
              updated_by = $5, updated_at = now(), published_at = now()
        WHERE slug = $1`,
      [slug, JSON.stringify(restored.sections ?? []), restored.title, nextVersion, principal.sub],
    );
    await client.query(
      `INSERT INTO content_page_versions (slug, version, snapshot, published_by)
       VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (slug, version) DO NOTHING`,
      [slug, nextVersion, JSON.stringify(restored), principal.sub],
    );
    return cur.rows[0];
  }).then(() => getPage(slug));
}

export async function listPageVersions(slug: string) {
  const { rows } = await query(
    `SELECT version, created_at AS "createdAt", published_by AS "publishedBy"
       FROM content_page_versions WHERE slug = $1 ORDER BY version DESC LIMIT 50`,
    [slug],
  );
  return rows;
}

/** Public read model for a page: its published sections resolved to block payloads. */
export async function getPublishedPage(slug: string) {
  const { rows } = await query<{ slug: string; site: string; published_title: string | null; published_sections: PageSection[] | null; published_at: string }>(
    `SELECT slug, site, published_title, published_sections, published_at
       FROM content_pages WHERE slug = $1 AND is_active AND published_sections IS NOT NULL`,
    [slug],
  );
  const p = rows[0];
  if (!p) return null;
  const keys = (p.published_sections ?? []).map((s) => s.blockKey);
  const { rows: blockRows } = keys.length
    ? await query<{ key: string; kind: BlockKind; published: unknown }>(
        `SELECT key, kind, published FROM content_blocks WHERE key = ANY($1::text[]) AND published IS NOT NULL`,
        [keys],
      )
    : { rows: [] };
  const byKey = new Map(blockRows.map((b) => [b.key, b]));
  // Preserve the published order; skip any block that has since been unpublished.
  const sections = keys
    .filter((k) => byKey.has(k))
    .map((k) => ({ key: k, kind: byKey.get(k)!.kind, data: byKey.get(k)!.published }));
  return { slug: p.slug, site: p.site, title: p.published_title, sections, publishedAt: p.published_at };
}

export async function listPublishedPages(site?: 'marketing' | 'app') {
  const { rows } = await query<{ slug: string; site: string; published_title: string | null }>(
    `SELECT slug, site, published_title FROM content_pages
        WHERE is_active AND published_sections IS NOT NULL ${site ? 'AND site = $1' : ''}
        ORDER BY site, slug`,
    site ? [site] : [],
  );
  return rows.map((r) => ({ slug: r.slug, site: r.site, title: r.published_title }));
}

// ── CMS media (slider imagery etc.) ────────────────────────────────────────

/**
 * Upload an image through the shared media pipeline and register it as CMS
 * media, which is what makes it eligible for public serving. Draft-only assets
 * are still visible to the editor (authorised path) but never publicly.
 */
export async function uploadCmsMedia(
  input: { dataUrl: string },
  principal: Principal,
): Promise<{ mediaId: string; url: string }> {
  const media = await uploadMedia({ dataUrl: input.dataUrl, captureMode: 'photo' }, principal, undefined, 'profile');
  await query(
    `INSERT INTO cms_media (media_id, created_by) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [media.id, principal.sub],
  );
  return { mediaId: media.id, url: `/api/public/content-media/${media.id}` };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a media id was uploaded through the CMS (public-serving allow-list). */
export async function isCmsMedia(mediaId: string): Promise<boolean> {
  if (!UUID_RE.test(mediaId)) return false;
  const { rows } = await query('SELECT 1 FROM cms_media WHERE media_id = $1', [mediaId]);
  return rows.length > 0;
}

/**
 * Whether a media id appears inside any *published* block payload or published
 * page snapshot. Used as a fallback allow-list so images referenced by pre-CMS
 * uploads (e.g. ones pasted in by key) can still be hydrated publicly.
 */
export async function isPublishedContentMedia(mediaId: string): Promise<boolean> {
  if (!UUID_RE.test(mediaId)) return false;
  const { rows } = await query(
    `SELECT 1 FROM (
       SELECT published::text AS blob FROM content_blocks WHERE published IS NOT NULL
       UNION ALL
       SELECT snapshot::text FROM content_page_versions
       UNION ALL
       SELECT published_sections::text FROM content_pages WHERE published_sections IS NOT NULL
     ) b WHERE b.blob LIKE '%' || $1 || '%'
     LIMIT 1`,
    [mediaId],
  );
  return rows.length > 0;
}

/** Resolve a publicly-servable CMS media asset; null when not permitted. */
export async function loadPublicCmsMedia(mediaId: string) {
  const allowed = (await isCmsMedia(mediaId)) || (await isPublishedContentMedia(mediaId));
  if (!allowed) return null;
  const { rows } = await query<{ storage_key: string; content_type: string }>(
    `SELECT storage_key, content_type FROM media_assets WHERE id = $1`,
    [mediaId],
  );
  const row = rows[0];
  if (!row) return null;
  // The public CMS route serves images only: a PDF or any other type must not
  // be fetchable (and cacheable) from an unauthenticated public endpoint.
  if (!row.content_type.startsWith('image/')) return null;
  const buffer = await readFile(join(process.cwd(), row.storage_key));
  return { buffer, contentType: row.content_type };
}
