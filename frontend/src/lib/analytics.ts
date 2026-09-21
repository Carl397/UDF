'use client';

import { API_BASE, tokenStore } from './api';

/**
 * First-party, cookieless analytics for the Next app (member app + CRM).
 *
 * Same contract as the marketing-site beacon (`POST /api/public/collect`), with
 * one difference: when a session token is present we send it, so `app`/`crm`
 * pageviews become attributable to a user id server-side (marketing stays
 * anonymous). The visitor hash is still derived on the server from a rotating
 * daily salt — nothing identifying is stored client-side or shipped as an id.
 *
 * Only `usePathname` (not `useSearchParams`) drives re-tracking, so this stays
 * compatible with the static export; campaign tags are read from the live URL.
 */

type Site = 'app' | 'crm';

function siteFor(path: string): Site {
  return path.startsWith('/crm') ? 'crm' : 'app';
}

function screenBucket(): string {
  const w = Math.max(
    typeof window !== 'undefined' ? window.innerWidth : 0,
    typeof screen !== 'undefined' ? screen.width : 0,
  );
  if (w >= 1920) return '1920+';
  if (w >= 1440) return '1440';
  if (w >= 1280) return '1280';
  if (w >= 1024) return '1024';
  if (w >= 768) return '768';
  return 'small';
}

/** Ephemeral per-tab id (sessionStorage) that groups one visit's events. */
function sessionId(): string | undefined {
  try {
    const key = 'udf_app_sid';
    let v = window.sessionStorage.getItem(key);
    if (!v) {
      v = Math.random().toString(36).slice(2) + Date.now().toString(36);
      window.sessionStorage.setItem(key, v);
    }
    return v;
  } catch {
    return undefined;
  }
}

interface BeaconInput {
  site: Site;
  eventType: string;
  path: string;
  durationMs?: number;
}

function sendBeacon(input: BeaconInput): void {
  if (typeof window === 'undefined') return;
  const body: Record<string, unknown> = { ...input, sessionId: sessionId() };
  if (input.eventType === 'pageview') {
    body.referrer = document.referrer || undefined;
    body.screen = screenBucket();
    body.lang = (navigator.language || '').slice(0, 16);
    try {
      const q = new URLSearchParams(window.location.search);
      if (q.get('utm_source')) body.utmSource = q.get('utm_source')?.slice(0, 128);
      if (q.get('utm_medium')) body.utmMedium = q.get('utm_medium')?.slice(0, 128);
      if (q.get('utm_campaign')) body.utmCampaign = q.get('utm_campaign')?.slice(0, 128);
    } catch {
      /* ignore malformed query */
    }
  }
  const token = tokenStore.access;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Offer the bearer whenever a session exists so app/crm views are
  // attributable; the server ignores it unless it validates, and marketing
  // beacons (from the static site) never carry one.
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    fetch(`${API_BASE}/public/collect`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {
      /* analytics must never surface an error to the user */
    });
  } catch {
    /* offline / fetch unsupported — drop silently */
  }
}

/** Track one pageview for `pathname` and its dwell time until the next nav. */
export function trackPageview(pathname: string, prev: { path: string; at: number } | null): void {
  if (prev && prev.path !== pathname) {
    sendBeacon({ site: siteFor(prev.path), eventType: 'duration', path: prev.path, durationMs: Date.now() - prev.at });
  }
  sendBeacon({ site: siteFor(pathname), eventType: 'pageview', path: pathname });
}

/** Flush the current page's dwell time (called on tab hide / unload). */
export function flushDwell(cur: { path: string; at: number } | null): void {
  if (!cur) return;
  sendBeacon({ site: siteFor(cur.path), eventType: 'duration', path: cur.path, durationMs: Date.now() - cur.at });
}
