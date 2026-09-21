'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { PublicPage } from '../lib/api';
import Slider from './Slider';
import type { SliderSlide } from './Slider';

/**
 * In-app renderer for a published CMS page (`/api/public/pages/:slug`).
 *
 * Renders the page's ordered sections: `slider` blocks become an auto-advancing
 * Slider (per-slide durations), `fields`/`section` blocks become heading/body
 * text plus optional bullet lists. Nothing is rendered when the page is absent
 * or has no published content yet, so callers can leave their static fallback
 * markup in place — the CMS silently takes over once an admin publishes.
 */

interface SectionData {
  heading?: string;
  body?: string;
  items?: string[];
  slides?: SliderSlide[];
}

function coerceSection(kind: string, data: unknown): SectionData {
  const src = (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  if (kind === 'slider') {
    const rows = Array.isArray(src.slides) ? src.slides : [];
    const slides: SliderSlide[] = [];
    for (const r of rows) {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      const mediaId = typeof o.imageMediaId === 'string' ? o.imageMediaId : '';
      const d = typeof o.durationSeconds === 'number' ? o.durationSeconds : 5;
      slides.push({
        imageMediaId: mediaId,
        title: typeof o.title === 'string' ? o.title : '',
        text: typeof o.text === 'string' ? o.text : '',
        durationSeconds: Math.min(Math.max(d, 2), 120),
      });
    }
    return { slides };
  }
  const firstString = (...keys: string[]): string | undefined => {
    for (const k of keys) if (typeof src[k] === 'string' && src[k]) return src[k] as string;
    return undefined;
  };
  const items = Array.isArray(src.items) ? (src.items as unknown[]).map((x) => String(x)).filter(Boolean) : undefined;
  return {
    heading: firstString('heading', 'title', 'kicker'),
    body: firstString('body', 'text', 'subtitle'),
    items,
  };
}

export default function CmsPage({ slug }: { slug: string }) {
  const [page, setPage] = useState<PublicPage | null>(null);

  useEffect(() => {
    let alive = true;
    api.getPublicPage(slug)
      .then((p) => { if (alive) setPage(p); })
      .catch(() => { if (alive) setPage(null); });
    return () => { alive = false; };
  }, [slug]);

  if (!page || !page.sections.length) return null;

  return (
    <div className="cms-page" data-cms-slug={page.slug}>
      {page.sections.map((section) => {
        const data = coerceSection(section.kind, section.data);
        if (section.kind === 'slider') {
          if (!data.slides?.length) return null;
          return <Slider key={section.key} slides={data.slides} />;
        }
        if (!data.heading && !data.body && !data.items?.length) return null;
        return (
          <section key={section.key} data-cms-block={section.key} style={{ margin: '18px 0' }}>
            {data.heading && <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>{data.heading}</h2>}
            {data.body && <p style={{ margin: '0 0 8px', lineHeight: 1.55 }}>{data.body}</p>}
            {data.items && data.items.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
                {data.items.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
