import { z } from 'zod';

/**
 * Query-string boolean parser. `z.coerce.boolean()` must NOT be used for
 * query params: it runs Boolean(value), and the non-empty string "false"
 * coerces to TRUE — so `?upcoming=false` / `?unread=false` would silently
 * keep the default behaviour instead of turning the filter off.
 * Accepts 1/true/yes and 0/false/no (case-insensitive); anything else fails
 * validation with a 400 rather than guessing.
 */
export const boolQuery = (fallback: boolean) =>
  z.preprocess(
    (v) => (v === undefined ? v : /^(1|true|yes)$/i.test(String(v)) ? true : /^(0|false|no)$/i.test(String(v)) ? false : v),
    z.boolean().default(fallback),
  );
