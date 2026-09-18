import { createHmac, hkdfSync } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Blind index: a keyed, deterministic hash (HMAC-SHA256) of a normalized PII
 * value. It lets us support equality lookups ("find member by email") while
 * the value itself stays sealed by Layer-3 encryption.
 *
 * Properties:
 *   • Deterministic → same input ⇒ same index (searchable).
 *   • Keyed (HMAC) → an attacker with DB read access cannot brute-force
 *     without the blind key.
 *   • One-way → cannot be reversed to plaintext.
 *
 * The blind key is separate from the encryption KEK so that rotating one does
 * not force re-encrypting/re-indexing the other.
 */

function resolveBlindKey(): Buffer {
  if (env.BLIND_INDEX_KEY) {
    return Buffer.from(env.BLIND_INDEX_KEY, 'hex');
  }
  // Dev fallback: derive a stable key from JWT_SECRET via HKDF-SHA256. Under
  // RS256 there is no shared secret, so an explicit BLIND_INDEX_KEY is required
  // (config/env.ts already enforces this in production).
  if (!env.JWT_SECRET) {
    // eslint-disable-next-line no-console
    console.error(
      '❌ No BLIND_INDEX_KEY set and no JWT_SECRET to derive one from (RS256). Set BLIND_INDEX_KEY (64 hex chars).',
    );
    process.exit(1);
  }
  const derived = hkdfSync(
    'sha256',
    Buffer.from(env.JWT_SECRET, 'utf8'),
    Buffer.from('party-platform-blind-index-salt', 'utf8'),
    Buffer.from('blind-index-v1', 'utf8'),
    32,
  );
  return Buffer.from(derived);
}

const BLIND_KEY = resolveBlindKey();

function normalize(field: string, value: string): string {
  const v = value.trim();
  // Emails and phone numbers are case-insensitive / format-sensitive.
  if (field === 'email') return v.toLowerCase();
  if (field === 'phone') return v.replace(/[^\d+]/g, '');
  return v.toLowerCase();
}

/** Compute the blind index for a (field, value) pair. Returns a Buffer. */
export function blindIndex(field: string, value: string): Buffer {
  const normalized = normalize(field, value);
  return createHmac('sha256', BLIND_KEY)
    .update(`${field}:${normalized}`, 'utf8')
    .digest();
}
