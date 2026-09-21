import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import { logger } from '../src/config/logger.js';
import { listPublishedPages, getPublishedPage } from '../src/modules/content/service.js';
import type { BlockKind } from '../src/modules/content/service.js';

/**
 * Build-time generator for CMS-authored marketing pages.
 *
 * The four original pillar pages are hand-written static HTML; the CMS adds the
 * ability to author NEW marketing pages (and reorder their sections) from the
 * SuperAdmin editor. This script reads every PUBLISHED marketing page straight
 * out of the database (the same read model the public API serves), renders each
 * to `website/<slug>.html` from the shared template below, and writes it next to
 * the hand-written pages so the existing nginx host serves it unchanged.
 *
 * The output is real, crawlable HTML — text and images are baked in, so SEO and
 * first paint never depend on JavaScript. The generated page ALSO carries the
 * same `data-cms` / `data-cms-slider` hooks and loads udf-content.js, so a later
 * edit publishes live (the runtime hydration refreshes the copy) without needing
 * a rebuild; this generator is what creates brand-new routes.
 *
 * Usage: npm run render:marketing  (reads CMS_API_BASE for absolute image URLs)
 */

const API_BASE = (process.env.CMS_API_BASE || 'https://crm.udf-party.co.za/api').replace(/\/+$/, '');
const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../website');

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mediaUrl(mediaId: string): string {
  return `${API_BASE}/public/content-media/${encodeURIComponent(mediaId)}`;
}

interface Slide { imageMediaId?: string; title?: string; text?: string; durationSeconds?: number }

function renderSlider(key: string, data: unknown): string {
  const rows = Array.isArray((data as { slides?: unknown })?.slides) ? ((data as { slides: Slide[] }).slides) : [];
  const slides = rows.map((s, i) => `        <div class="udf-cms-slide"${i === 0 ? '' : ' style="display:none"'}>
          ${s.imageMediaId ? `<img class="udf-cms-slide-img" src="${esc(mediaUrl(s.imageMediaId))}" alt="${esc(s.title)}">` : ''}
          ${(s.title || s.text) ? `          <div class="udf-cms-slide-caption">
            ${s.title ? `<div class="udf-cms-slide-title">${esc(s.title)}</div>` : ''}
            ${s.text ? `<p class="udf-cms-slide-text">${esc(s.text)}</p>` : ''}
          </div>` : ''}
        </div>`).join('\n');
  return `      <div class="udf-cms-slider" data-cms-slider="${esc(key)}" role="region" aria-label="Highlights">
${slides}
      </div>`;
}

function firstString(src: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) if (typeof src[k] === 'string' && src[k]) return src[k] as string;
  return undefined;
}

function renderFields(key: string, data: unknown): string {
  const src = (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  const heading = firstString(src, ['heading', 'title', 'kicker']);
  const body = firstString(src, ['body', 'text', 'subtitle']);
  const items = Array.isArray(src.items) ? (src.items as unknown[]).map(String).filter(Boolean) : [];
  const parts: string[] = [];
  if (heading) parts.push(`        <h2>${esc(heading)}</h2>`);
  if (body) parts.push(`        <p>${esc(body)}</p>`);
  if (items.length) {
    parts.push('        <ul>\n' + items.map((x) => `          <li>${esc(x)}</li>`).join('\n') + '\n        </ul>');
  }
  if (!parts.length) return '';
  return `      <section class="cms-section" data-cms-block="${esc(key)}">\n${parts.join('\n')}\n      </section>`;
}

function renderSection(key: string, kind: BlockKind, data: unknown): string {
  return kind === 'slider' ? renderSlider(key, data) : renderFields(key, data);
}

function renderPage(page: { slug: string; title: string | null; sections: Array<{ key: string; kind: BlockKind; data: unknown }> }): string {
  const title = page.title || page.slug;
  const body = page.sections
    .map((s) => renderSection(s.key, s.kind, s.data))
    .filter(Boolean)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} | udf-party.co.za</title>
  <meta name="description" content="${esc(title)}">
  <link rel="icon" type="image/png" sizes="64x64" href="assets/img/favicon.png">
  <link rel="apple-touch-icon" href="assets/img/udf-logo.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Anton&family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="assets/css/style.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>

<header class="site-header">
  <div class="wrap header-in">
    <a class="brand" href="index.html">
      <img class="brand-mark" src="assets/img/udf-logo.png" alt="UDF Party logo: black flag with gold UDF letters on red">
      <span class="brand-name">United Democratic Front Party<small>udf-party.co.za</small></span>
    </a>
    <button class="nav-toggle" aria-expanded="false" aria-controls="site-nav" aria-label="Toggle navigation"><span></span><span></span><span></span></button>
    <nav class="site-nav" id="site-nav" aria-label="Primary">
      <ul>
        <li><a href="index.html">Home</a></li>
        <li><a href="housing-infrastructure.html">Housing &amp; Infrastructure</a></li>
        <li><a href="safety-communities.html">Safety &amp; Communities</a></li>
        <li><a href="economy-governance.html">Economy &amp; Governance</a></li>
      </ul>
    </nav>
  </div>
</header>

<main id="main">
  <article class="wrap cms-page" data-cms-slug="${esc(page.slug)}">
    <h1>${esc(title)}</h1>
${body}
  </article>
</main>

<footer class="site-footer">
  <div class="wrap footer-bottom">
    <span>© ${new Date().getFullYear()} United Democratic Front Party. All rights reserved.</span>
  </div>
</footer>

<script src="assets/js/udf-content.js" data-api="${esc(API_BASE)}"></script>
<script src="assets/js/main.js"></script>
</body>
</html>
`;
}

async function main(): Promise<void> {
  const published = await listPublishedPages('marketing');
  await mkdir(SITE_ROOT, { recursive: true });
  let count = 0;
  for (const meta of published) {
    const page = await getPublishedPage(meta.slug);
    if (!page) continue;
    const file = resolve(SITE_ROOT, `${page.slug}.html`);
    if (!file.startsWith(SITE_ROOT + '/') && file !== resolve(SITE_ROOT, 'index.html')) {
      logger.warn({ slug: page.slug }, 'skipping page with an unsafe slug');
      continue;
    }
    await writeFile(file, renderPage({ slug: page.slug, title: page.title, sections: page.sections }), 'utf8');
    logger.info({ slug: page.slug, file: file.replace(SITE_ROOT + '/', 'website/') }, 'rendered marketing page');
    count++;
  }
  logger.info({ count }, 'marketing pages rendered');
}

main()
  .then(() => pool.end())
  .catch((err) => {
    logger.error({ err }, 'marketing page render failed');
    process.exit(1);
  });
