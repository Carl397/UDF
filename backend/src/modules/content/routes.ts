import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/asyncHandler.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { ApiError } from '../../http/errors.js';
import { Permission } from '../../auth/permissions.js';
import * as content from './service.js';

/** A draft payload is an arbitrary JSON object; cap its size to keep rows sane. */
const draftSchema = z.record(z.any());
const rollbackSchema = z.object({ version: z.coerce.number().int().positive() });

const blockKind = z.enum(['fields', 'slider', 'section']);
const SITE = z.enum(['marketing', 'app', 'shared']);
const PAGE_SITE = z.enum(['marketing', 'app']);
// Keys/slugs are restricted to a URL/host-safe alphabet so they can be used
// directly in the public read paths and generated marketing filenames.
const SLUG = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, . _ - only');

const blockCreateSchema = z.object({
  key: SLUG,
  site: SITE,
  title: z.string().min(1).max(160),
  kind: blockKind.default('fields'),
  schema: z.record(z.any()).default({}),
});
const sectionSchema = z.object({ blockKey: SLUG });
const sectionsSchema = z.object({ sections: z.array(sectionSchema).max(100) });
const pageCreateSchema = z.object({
  slug: SLUG,
  site: PAGE_SITE,
  title: z.string().min(1).max(160),
});
const pageRenameSchema = z.object({ title: z.string().min(1).max(160) });
// Slider images etc. — same data-url envelope as the shared media pipeline.
const cmsMediaSchema = z.object({ dataUrl: z.string().min(16).max(8 * 1024 * 1024) });

/**
 * /api/crm/superadmin/content — the website editor (SuperAdmin only).
 * Gated on `content:manage`; reads list/edit blocks + pages, publish/rollback
 * move the live published payload. Drafts are never exposed publicly.
 */
export const contentAdminRouter = Router();
contentAdminRouter.use(authenticate, requirePermission(Permission.CONTENT_MANAGE));

// ── Pages ────────────────────────────────────────────────────────────────
// Registered (via a sub-router) BEFORE the block `/:key` routes so a slug never
// collides with a block key on the shared prefix.
const pagesRouter = Router();
contentAdminRouter.use('/pages', pagesRouter);

pagesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const site = req.query.site as content.ContentPage['site'] | undefined;
    res.json({ pages: await content.listPages(site) });
  }),
);

pagesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const page = await content.createPage(pageCreateSchema.parse(req.body), req.principal!);
    res.status(201).json({ page });
  }),
);

pagesRouter.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const slug = z.string().max(160).parse(req.params.slug);
    const view = await content.getPageWithBlocks(slug);
    if (!view) throw ApiError.notFound('Page not found');
    res.json({ ...view, versions: await content.listPageVersions(slug) });
  }),
);

pagesRouter.put(
  '/:slug/sections',
  asyncHandler(async (req, res) => {
    const slug = z.string().max(160).parse(req.params.slug);
    const { sections } = sectionsSchema.parse(req.body);
    const page = await content.updatePageSections(slug, sections, req.principal!);
    if (!page) throw ApiError.notFound('Page not found');
    res.json({ page });
  }),
);

pagesRouter.patch(
  '/:slug',
  asyncHandler(async (req, res) => {
    const slug = z.string().max(160).parse(req.params.slug);
    const { title } = pageRenameSchema.parse(req.body);
    const page = await content.renamePage(slug, title, req.principal!);
    if (!page) throw ApiError.notFound('Page not found');
    res.json({ page });
  }),
);

pagesRouter.post(
  '/:slug/publish',
  asyncHandler(async (req, res) => {
    const slug = z.string().max(160).parse(req.params.slug);
    const page = await content.publishPage(slug, req.principal!);
    if (!page) throw ApiError.notFound('Page not found');
    res.json({ page });
  }),
);

pagesRouter.post(
  '/:slug/rollback',
  asyncHandler(async (req, res) => {
    const slug = z.string().max(160).parse(req.params.slug);
    const { version } = rollbackSchema.parse(req.body ?? {});
    const page = await content.rollbackPage(slug, version, req.principal!);
    if (!page) throw ApiError.notFound('Page not found');
    res.json({ page });
  }),
);

pagesRouter.delete(
  '/:slug',
  asyncHandler(async (req, res) => {
    const slug = z.string().max(160).parse(req.params.slug);
    await content.deletePage(slug);
    res.json({ ok: true });
  }),
);

// ── Blocks ─────────────────────────────────────────────────────────────────
contentAdminRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ blocks: await content.listBlocks() });
  }),
);

contentAdminRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const block = await content.createBlock(blockCreateSchema.parse(req.body), req.principal!);
    res.status(201).json({ block });
  }),
);

/** Upload a CMS image (slide etc.); returns the id + public URL for payloads. */
contentAdminRouter.post(
  '/media',
  asyncHandler(async (req, res) => {
    const { dataUrl } = cmsMediaSchema.parse(req.body);
    res.status(201).json(await content.uploadCmsMedia({ dataUrl }, req.principal!));
  }),
);

contentAdminRouter.get(
  '/:key',
  asyncHandler(async (req, res) => {
    const block = await content.getBlock(req.params.key!);
    if (!block) throw ApiError.notFound('Content block not found');
    res.json({ block, versions: await content.listVersions(req.params.key!) });
  }),
);

contentAdminRouter.put(
  '/:key/draft',
  asyncHandler(async (req, res) => {
    const draft = draftSchema.parse(req.body?.draft ?? req.body ?? {});
    const block = await content.saveDraft(req.params.key!, draft, req.principal!);
    if (!block) throw ApiError.notFound('Content block not found');
    res.json({ block });
  }),
);

contentAdminRouter.post(
  '/:key/publish',
  asyncHandler(async (req, res) => {
    const block = await content.publishBlock(req.params.key!, req.principal!);
    if (!block) throw ApiError.notFound('Content block not found');
    res.json({ block });
  }),
);

contentAdminRouter.post(
  '/:key/rollback',
  asyncHandler(async (req, res) => {
    const { version } = rollbackSchema.parse(req.body ?? {});
    const block = await content.rollbackBlock(req.params.key!, version, req.principal!);
    if (!block) throw ApiError.notFound('Content block not found');
    res.json({ block });
  }),
);

contentAdminRouter.delete(
  '/:key',
  asyncHandler(async (req, res) => {
    await content.deleteBlock(req.params.key!, req.principal!);
    res.json({ ok: true });
  }),
);

/**
 * /api/public/content — the runtime hydration source for the static site and the
 * app landing page. Serves only published payloads, cheaply and cacheable.
 */
export const contentPublicRouter = Router();

contentPublicRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const site = req.query.site as 'marketing' | 'app' | 'shared' | undefined;
    const blocks = await content.getPublishedBlocks(site);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ blocks });
  }),
);

contentPublicRouter.get(
  '/:key',
  asyncHandler(async (req, res) => {
    const block = await content.getBlock(req.params.key!);
    if (!block || block.published == null) throw ApiError.notFound('Content not found');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ key: block.key, site: block.site, kind: block.kind, data: block.published, publishedAt: block.publishedAt });
  }),
);

/**
 * /api/public/pages — published page trees for the marketing + in-app renderers.
 * A page resolves to its ordered published sections (each = a block payload).
 */
export const contentPublicPagesRouter = Router();

contentPublicPagesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const site = req.query.site as 'marketing' | 'app' | undefined;
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ pages: await content.listPublishedPages(site) });
  }),
);

contentPublicPagesRouter.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const page = await content.getPublishedPage(z.string().max(160).parse(req.params.slug));
    if (!page) throw ApiError.notFound('Page not found');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(page);
  }),
);

/**
 * /api/public/content-media — serve images referenced by CMS content (slides
 * etc.). Allow-listed to ids uploaded through the CMS editor or present in a
 * published payload, so internal report/subject media can never be fetched.
 */
export const contentPublicMediaRouter = Router();

contentPublicMediaRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const media = await content.loadPublicCmsMedia(req.params.id!);
    if (!media) throw ApiError.notFound('Media not found');
    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    // Public, no-auth image meant to be embedded anywhere. Helmet applies a global
    // CORP of `same-site`, which blocks the mobile WebView (origin http://localhost)
    // from rendering this cross-site inside an <img>; widen it for this response only.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(media.buffer);
  }),
);
