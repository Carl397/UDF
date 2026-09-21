'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cmsMediaUrl } from '../lib/api';

/**
 * Dependency-free content slider for CMS `slider` blocks.
 *
 * Each slide carries its own duration (seconds). Auto-advance pauses on hover
 * and focus, and is disabled entirely when the visitor prefers reduced motion.
 * Images come from the public CMS media route, so a plain <img> is enough.
 */

export interface SliderSlide {
  imageMediaId: string;
  title: string;
  text: string;
  durationSeconds: number;
}

export default function Slider({ slides }: { slides: SliderSlide[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      setReduced(mq.matches);
      const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
  }, []);

  const count = slides.length;
  // Read the slides array through a ref so a parent re-render that passes an
  // equivalent new array (fresh identity) never restarts the countdown.
  const slidesRef = useRef(slides);
  slidesRef.current = slides;
  const go = useCallback((i: number) => setIndex(((i % count) + count) % count), [count]);

  // A slide list that shrank can leave the cursor out of range.
  useEffect(() => {
    if (index >= count) setIndex(count ? count - 1 : 0);
  }, [count, index]);

  useEffect(() => {
    if (paused || reduced || count <= 1) return;
    const current = slidesRef.current[Math.min(index, slidesRef.current.length - 1)];
    const raw = Number(current?.durationSeconds);
    const ms = (Number.isFinite(raw) ? Math.max(raw, 2) : 5) * 1000;
    timer.current = setTimeout(() => setIndex((i) => (i + 1) % count), ms);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [index, paused, reduced, count]);

  if (!count) return null;

  return (
    <div
      className="udf-slider"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      role="region"
      aria-roledescription="carousel"
      aria-label="Highlights"
    >
      {slides.map((s, i) => (
        <div key={i} className="udf-slide" aria-hidden={i !== index} style={{ display: i === index ? 'block' : 'none' }}>
          {s.imageMediaId && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="udf-slide-img" src={cmsMediaUrl(s.imageMediaId)} alt={s.title || ''} />
          )}
          {(s.title || s.text) && (
            <div className="udf-slide-caption">
              {s.title && <div className="udf-slide-title">{s.title}</div>}
              {s.text && <p className="udf-slide-text">{s.text}</p>}
            </div>
          )}
        </div>
      ))}

      {count > 1 && (
        <>
          <button type="button" className="udf-slider-nav prev" aria-label="Previous slide" onClick={() => go(index - 1)}>‹</button>
          <button type="button" className="udf-slider-nav next" aria-label="Next slide" onClick={() => go(index + 1)}>›</button>
          <div className="udf-slider-dots">
            {slides.map((_, i) => (
              <button
                key={i}
                type="button"
                className={`udf-slider-dot${i === index ? ' active' : ''}`}
                aria-label={`Go to slide ${i + 1}`}
                aria-current={i === index}
                onClick={() => go(i)}
              />
            ))}
          </div>
        </>
      )}

      <style>{`
        .udf-slider { position: relative; border-radius: 12px; overflow: hidden; background: #111; }
        .udf-slide { position: relative; }
        .udf-slide-img { width: 100%; display: block; max-height: 420px; object-fit: cover; }
        .udf-slide-caption {
          position: absolute; left: 0; right: 0; bottom: 0; padding: 16px 48px;
          background: linear-gradient(transparent, rgba(0,0,0,0.65)); color: #fff;
        }
        .udf-slide-title { font-size: 20px; font-weight: 700; }
        .udf-slide-text { margin: 4px 0 0; font-size: 14px; opacity: 0.92; }
        .udf-slider-nav {
          position: absolute; top: 50%; transform: translateY(-50%); z-index: 2;
          width: 36px; height: 36px; border-radius: 50%; border: none; cursor: pointer;
          background: rgba(255,255,255,0.75); color: #111; font-size: 20px; line-height: 1;
        }
        .udf-slider-nav.prev { left: 10px; }
        .udf-slider-nav.next { right: 10px; }
        .udf-slider-dots { position: absolute; bottom: 8px; left: 0; right: 0; display: flex; gap: 6px; justify-content: center; }
        .udf-slider-dot {
          width: 9px; height: 9px; border-radius: 50%; border: none; cursor: pointer;
          background: rgba(255,255,255,0.5); padding: 0;
        }
        .udf-slider-dot.active { background: #fff; }
      `}</style>
    </div>
  );
}
