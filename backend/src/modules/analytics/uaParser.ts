/**
 * Minimal, dependency-free user-agent classifier for first-party analytics.
 *
 * We deliberately do NOT ship a full UA database: the dashboard only needs a
 * coarse device type plus the dominant OS/browser family to break traffic down.
 * A small ordered set of regexes gets us there with no supply-chain surface and
 * no per-request allocation beyond a handful of tests. Unknowns collapse to
 * 'other' / null rather than a wrong guess.
 */

export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'bot' | 'other';

export interface UaInfo {
  deviceType: DeviceType;
  os: string | null;
  browser: string | null;
}

/** Bots/crawlers we want bucketed out of human traffic. */
const BOT_RE =
  /(bot|crawler|spider|slurp|curl|wget|python-requests|go-http-client|headlesschrome|lighthouse|mediapartners|facebookexternalhit|telegrambot|whatsapp)/i;

/**
 * Tablet heuristics must run before the generic "mobile" test: many tablets
 * (iPad, large Android) send "Mobile" too, so we detect the tablet shape first.
 */
const TABLET_RE = /(ipad|tablet|sm-[tab]|galaxy tab|nexus 7|nexus 10|playbook|silk)/i;
const MOBILE_RE = /(iphone|ipod|android|windows phone|iemobile|blackberry|bb10|opera mini|mobile)/i;

function osOf(ua: string): string | null {
  if (/windows nt 10\.0|windows 11|windows nt 11/i.test(ua)) return 'Windows';
  if (/windows/i.test(ua)) return 'Windows';
  // Android must precede Linux (Android UAs contain "Linux").
  if (/android/i.test(ua)) return 'Android';
  // iOS: iPhone/iPod, and iPad plus modern desktop-class Safari iPhones.
  if (/(iphone|ipod)/i.test(ua)) return 'iOS';
  if (/\(iPad.*cpu os/i.test(ua)) return 'iPadOS';
  if (/mac os x|macintosh/i.test(ua)) return 'macOS';
  if (/cros/i.test(ua)) return 'ChromeOS';
  if (/linux/i.test(ua)) return 'Linux';
  return null;
}

function browserOf(ua: string): string | null {
  // Order matters: Edge/OPR embed "Chrome", Chrome embeds "Safari".
  if (/edg\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/samsungbrowser/i.test(ua)) return 'Samsung Internet';
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/crios/i.test(ua)) return 'Chrome';
  if (/chrome|chromium/i.test(ua)) return 'Chrome';
  if (/version\/.*safari/i.test(ua)) return 'Safari';
  return null;
}

/** Classify a raw user-agent string. An empty UA is treated as 'other'. */
export function parseUserAgent(ua: string | null | undefined): UaInfo {
  const raw = (ua ?? '').slice(0, 512);
  if (!raw) return { deviceType: 'other', os: null, browser: null };
  if (BOT_RE.test(raw)) return { deviceType: 'bot', os: osOf(raw), browser: browserOf(raw) };
  if (TABLET_RE.test(raw)) return { deviceType: 'tablet', os: osOf(raw), browser: browserOf(raw) };
  if (MOBILE_RE.test(raw)) return { deviceType: 'mobile', os: osOf(raw), browser: browserOf(raw) };
  const os = osOf(raw);
  // A desktop OS implies desktop; otherwise an unrecognised UA is 'other'.
  if (os === 'Windows' || os === 'macOS' || os === 'Linux' || os === 'ChromeOS') {
    return { deviceType: 'desktop', os, browser: browserOf(raw) };
  }
  return { deviceType: 'other', os, browser: browserOf(raw) };
}
