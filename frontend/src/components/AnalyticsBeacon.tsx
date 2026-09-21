'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { trackPageview, flushDwell } from '../lib/analytics';

/**
 * Route-change analytics beacon for the Next app. Renders nothing; mounted once
 * in the root layout so every member-app and CRM navigation records a
 * cookieless pageview and, on leave, the page's dwell time.
 *
 * `startRef` holds the currently-open page so a dwell is emitted exactly once
 * per view — on the next navigation, on tab hide, and on unload.
 */
export default function AnalyticsBeacon() {
  const pathname = usePathname();
  const startRef = useRef<{ path: string; at: number } | null>(null);
  const firstRef = useRef(true);

  useEffect(() => {
    if (!pathname) return;
    // Skip a duplicate view of the same path on mount (App Router fires the
    // effect once per pathname change; the initial one is the real first view).
    const prev = startRef.current;
    trackPageview(pathname, firstRef.current ? null : prev);
    firstRef.current = false;
    startRef.current = { path: pathname, at: Date.now() };
  }, [pathname]);

  useEffect(() => {
    const onHide = () => {
      const cur = startRef.current;
      if (!cur) return;
      if (document.visibilityState === 'hidden') {
        flushDwell({ ...cur });
        // Reset the open timer so a return-to-tab measures the new dwell only.
        startRef.current = { path: cur.path, at: Date.now() };
      }
    };
    const onUnload = () => flushDwell(startRef.current);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onUnload);
    };
  }, []);

  return null;
}
