import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * False on the server and on the very first client render, true afterwards.
 *
 * Every public page is statically prerendered (`output: 'export'` for the
 * Capacitor build rules out `dynamic = 'force-dynamic'`), so the prerendered
 * HTML can never contain a code, token or referral that only exists in the
 * visitor's URL. Gating on this keeps the first client render byte-identical to
 * the server HTML — otherwise React reports a hydration mismatch and throws the
 * whole Suspense boundary away to re-render on the client.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * Reads a public-link token that can arrive in either of two shapes:
 *
 *   • query form — `/v?code=UDF-ABC-XYZ`, `/confirm?token=…`
 *   • pretty path — `/v/UDF-ABC-XYZ`, `/confirm/…`, which is what the backend
 *     prints on QR party cards, SMS invites and confirmation emails.
 *
 * The pretty paths are served by `rewrites` in next.config.mjs, because the
 * Capacitor build uses `output: 'export'` and therefore cannot have dynamic
 * route segments. A rewrite is applied on the server only: the browser address
 * bar keeps the path form, so after hydration `useSearchParams()` reports an
 * empty query string. Falling back to the trailing path segment keeps both
 * shapes working from the very first client render.
 *
 * The value is resolved in a lazy `useState` initializer rather than an effect
 * so the first paint already has it — otherwise the page would flash its
 * "no code supplied" error state before recovering.
 *
 * @param queryKey query parameter name, e.g. `code` or `token`
 * @param basePath route the page is mounted on, e.g. `/v` or `/confirm`
 */
export function usePublicToken(queryKey: string, basePath: string): string {
  const search = useSearchParams();
  const fromQuery = search.get(queryKey);

  const [fromPath] = useState(() => {
    if (typeof window === 'undefined') return '';
    const path = window.location.pathname.replace(/\/+$/, '');
    // Only treat what follows the mount point as the token, so a bare `/v`
    // (no code at all) does not yield `"v"`.
    if (!path.startsWith(basePath)) return '';
    const segment = path.slice(basePath.length).split('/').filter(Boolean).pop();
    if (!segment) return '';
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });

  return fromQuery || fromPath;
}
