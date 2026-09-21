'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export function mapScrollState(scrollHeight: number, clientHeight: number, scrollTop: number, detailsTop: number) {
  const max = Math.max(0, scrollHeight - clientHeight);
  return { overflow: max > 4, atEnd: scrollTop >= Math.min(detailsTop, max) - 4 };
}

/** Keep navigation to the readout outside the SVG's pan/pinch surface. */
export default function MapScrollLayout({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [atEnd, setAtEnd] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!enabled || !el) return;
    const measure = () => {
      const max = el.scrollHeight - el.clientHeight;
      const details = el.querySelector<HTMLElement>('[data-map-details]');
      const destination = details
        ? el.scrollTop + details.getBoundingClientRect().top - el.getBoundingClientRect().top
        : max;
      const state = mapScrollState(el.scrollHeight, el.clientHeight, el.scrollTop, destination);
      setOverflow(state.overflow);
      setAtEnd(state.atEnd);
      el.style.setProperty('--map-scroll-height', `${el.clientHeight}px`);
    };
    const resize = new ResizeObserver(measure);
    const observe = () => {
      resize.disconnect();
      resize.observe(el);
      for (const child of Array.from(el.children)) resize.observe(child);
      measure();
    };
    const mutations = new MutationObserver(observe);
    mutations.observe(el, { childList: true });
    el.addEventListener('scroll', measure, { passive: true });
    observe();
    return () => { resize.disconnect(); mutations.disconnect(); el.removeEventListener('scroll', measure); };
  }, [enabled]);

  if (!enabled) return <div className="udf-map">{children}</div>;

  function navigate() {
    const el = scrollRef.current;
    if (!el) return;
    const details = el.querySelector<HTMLElement>('[data-map-details]');
    const top = atEnd ? 0 : details
      ? el.scrollTop + details.getBoundingClientRect().top - el.getBoundingClientRect().top
      : el.scrollHeight;
    el.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  return (
    <div className="udf-map-layout">
      <div className="udf-map" ref={scrollRef}>{children}</div>
      <div className="udf-map-scroll-footer">
        <button type="button" onClick={navigate} style={{ visibility: overflow ? 'visible' : 'hidden' }}
          className="udf-map-scroll-cue">
          <span>{atEnd ? 'Back to map' : 'View data below'}</span>
          <span aria-hidden="true">{atEnd ? '↑' : '↓'}</span>
        </button>
      </div>
    </div>
  );
}
