import { createHmac, hkdfSync } from 'node:crypto';
import type { Request } from 'express';
import { env } from '../../config/env.js';

/**
 * Cookieless visitor + IP identity for first-party analytics.
 *
 * POPIA posture (mirrors the sealed-PII design elsewhere): we never persist a
 * raw IP or set a cookie. Instead each event carries a one-way hash of
 * (day, ip, user-agent, site). The day is folded into the HMAC message, so a
 * visitor's id is stable WITHIN a day (enabling unique-visitor / returning
 * counts) but is different EVERY day (so rows cannot be stitched into a
 * cross-day profile). The key is an analytics-specific HKDF subkey, separate
 * from the PII blind index, so rotating one does not disturb the other.
 */

function resolveAnalyticsKey(): Buffer {
  const base =
    env.BLIND_INDEX_KEY ?? env.JWT_SECRET ?? env.LOCAL_KEK ?? 'udf-analytics-fallback-salt';
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(base, 'utf8'),
      Buffer.from('udf-analytics-visitor-salt', 'utf8'),
      Buffer.from('analytics-v1', 'utf8'),
      32,
    ),
  );
}

const ANALYTICS_KEY = resolveAnalyticsKey();

/** Local (SAST) calendar day used as the rotation bucket, e.g. "2026-09-19". */
export function currentDayKey(date = new Date()): string {
  // Africa/Johannesburg is UTC+2 with no DST, so a fixed offset is exact.
  const sast = new Date(date.getTime() + 2 * 60 * 60 * 1000);
  return sast.toISOString().slice(0, 10);
}

function hmac(message: string): string {
  return createHmac('sha256', ANALYTICS_KEY).update(message, 'utf8').digest('hex');
}

/** Stable-within-day, rotating-across-days visitor id (64 hex chars). */
export function visitorHash(opts: {
  ip: string | null;
  userAgent: string | null;
  site: string;
  dayKey?: string;
}): string {
  const day = opts.dayKey ?? currentDayKey();
  const ip = (opts.ip ?? '').trim();
  const ua = (opts.userAgent ?? '').trim().slice(0, 512);
  return hmac(`${day}|${ip}|${ua}|${opts.site}`);
}

/**
 * De-dup hash for downloads. Kept distinct from visitorHash (different purpose
 * string) so a download row can never be joined to an analytics event by the
 * hash alone.
 */
export function downloadIpHash(opts: {
  ip: string | null;
  dayKey?: string;
}): string {
  const day = opts.dayKey ?? currentDayKey();
  const ip = (opts.ip ?? '').trim();
  return hmac(`dl|${day}|${ip}`);
}

/**
 * Coarse geography from trusted proxy headers. nginx's `geoip2` module (when
 * enabled) sets X-Client-Country/Region/City; absent that (dev, or nginx
 * without the module) everything is null and the dashboard simply shows no
 * geo split rather than a wrong one. We never resolve IPs in-process.
 */
export function geoFromRequest(req: Request): {
  country: string | null;
  region: string | null;
  city: string | null;
} {
  const country = req.get('x-client-country')?.trim().toUpperCase();
  const region = req.get('x-client-region')?.trim();
  const city = req.get('x-client-city')?.trim();
  return {
    country: country && country.length === 2 ? country.slice(0, 2) : null,
    region: region ? region.slice(0, 128) : null,
    city: city ? city.slice(0, 128) : null,
  };
}
