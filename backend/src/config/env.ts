import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Central, validated environment configuration.
 * Failing fast here means a misconfigured secret can never silently
 * degrade the security posture of the app.
 */
const HexKey32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex chars (32 bytes / AES-256)');

/**
 * Boolean env flag. NOTE: `z.coerce.boolean()` must NOT be used here — it runs
 * `Boolean(value)`, so the literal string "false" would coerce to `true`.
 */
const envBool = (fallback = false) =>
  z
    .string()
    .optional()
    .default(fallback ? 'true' : 'false')
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.toLowerCase()));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  // Interface to bind. Set to 127.0.0.1 in production behind nginx so the API
  // is only reachable via the reverse proxy (never directly from the internet).
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().url(),
  PGSSL: envBool(false),

  // Access-token signing. Dev/test use a shared HS256 secret; production MUST
  // use an RS256 key pair so tokens are signed with a private key and verified
  // with a public key (no shared symmetric secret to leak). Provide PEM strings
  // (via env or a mounted file's contents). RS256 is selected automatically when
  // both keys are present.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be >= 32 chars').optional(),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  // File-path alternatives (RECOMMENDED in production): a systemd EnvironmentFile
  // cannot hold a multi-line PEM value, so point these at the key files instead.
  JWT_PRIVATE_KEY_PATH: z.string().optional(),
  JWT_PUBLIC_KEY_PATH: z.string().optional(),
  JWT_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // Layer 3 — field-level envelope encryption
  KMS_PROVIDER: z.enum(['local', 'aws-kms']).default('local'),
  LOCAL_KEK: HexKey32.optional(),
  AWS_REGION: z.string().optional(),
  AWS_KMS_KEY_ID: z.string().optional(),

  // Deterministic blind index (HMAC) key for equality lookups on sealed PII.
  // Optional: if omitted, a key is derived from JWT_SECRET via HKDF (dev only).
  BLIND_INDEX_KEY: HexKey32.optional(),

  // Layer 1 — in transit
  ENABLE_HSTS: envBool(false),

  // Public web origin used to build membership / mandate confirmation links.
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

  // ── Outbound mail (FR-Q) ────────────────────────────────────────────────
  // The production host runs a local postfix (loopback submission, DKIM signed
  // by the on-box opendkim milter), so the defaults need no credentials: the
  // app hands the message to 127.0.0.1:25 and postfix relays + signs it. Set
  // SMTP_HOST/PORT/USER/PASS + SMTP_STARTTLS for a remote relay instead. When
  // MAIL_FROM is empty the mailer captures to `email_outbox` instead of sending
  // (dev fallback), so nothing crashes without SMTP.
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().positive().default(25),
  /** Implicit TLS on connect (port 465). Mutually exclusive with STARTTLS. */
  SMTP_SECURE: envBool(false),
  /** Upgrade a plaintext connection with STARTTLS (port 587 relay). */
  SMTP_STARTTLS: envBool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** RFC-5322 From header, e.g. `UDF Party <no-reply@udfparty.example>`. */
  MAIL_FROM: z.string().default(''),
  /** Envelope MAIL FROM (bounce address). Defaults to MAIL_FROM's address. */
  MAIL_RETURN_PATH: z.string().optional(),

  // ── Reverse geocoding (street/area labels on reports & patrol stops) ─────
  // The app itself is tile-free and never calls a map provider; street names
  // are resolved server-side (best-effort) so no third-party reference is baked
  // into the mobile bundle. `{lat}`/`{lon}` are substituted into the template.
  // Defaults to the public OSM Nominatim reverse endpoint; set to an empty
  // string to disable street lookup entirely (the ward name is still returned).
  GEOCODER_URL: z
    .string()
    .default('https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat={lat}&lon={lon}&zoom=18&addressdetails=1'),
  /** Nominatim's usage policy requires an identifying User-Agent / contact. */
  GEOCODER_USER_AGENT: z.string().default('UDF-Party-CRM/1.0 (+https://crm.udf-party.co.za)'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:');
  // eslint-disable-next-line no-console
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const raw = parsed.data;

// Provider-specific validation of the master key (KEK).
if (raw.KMS_PROVIDER === 'local' && !raw.LOCAL_KEK) {
  // eslint-disable-next-line no-console
  console.error('❌ KMS_PROVIDER=local requires LOCAL_KEK (64 hex chars).');
  process.exit(1);
}
if (raw.KMS_PROVIDER === 'aws-kms' && (!raw.AWS_REGION || !raw.AWS_KMS_KEY_ID)) {
  // eslint-disable-next-line no-console
  console.error('❌ KMS_PROVIDER=aws-kms requires AWS_REGION and AWS_KMS_KEY_ID.');
  process.exit(1);
}

// Access-token signing: RS256 when a key pair is present, otherwise HS256.
// Keys may be inline (JWT_PRIVATE_KEY/JWT_PUBLIC_KEY) or read from files
// (JWT_PRIVATE_KEY_PATH/JWT_PUBLIC_KEY_PATH) — file paths are the recommended
// production method so PEM material is never embedded in an EnvironmentFile.
function resolvePem(
  inline: string | undefined,
  filePath: string | undefined,
  label: string,
): string | undefined {
  if (inline && inline.trim()) return inline;
  if (filePath) {
    try {
      return readFileSync(filePath, 'utf8');
    } catch {
      // eslint-disable-next-line no-console
      console.error(`❌ Could not read ${label} file: ${filePath}`);
      process.exit(1);
    }
  }
  return undefined;
}
const privateKey = resolvePem(raw.JWT_PRIVATE_KEY, raw.JWT_PRIVATE_KEY_PATH, 'JWT_PRIVATE_KEY_PATH');
const publicKey = resolvePem(raw.JWT_PUBLIC_KEY, raw.JWT_PUBLIC_KEY_PATH, 'JWT_PUBLIC_KEY_PATH');

const rs256 = Boolean(privateKey && publicKey);
if (!rs256 && !raw.JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.error(
    '❌ Provide JWT_SECRET (HS256, dev/test) or both JWT_PRIVATE_KEY[_PATH] and JWT_PUBLIC_KEY[_PATH] (RS256).',
  );
  process.exit(1);
}
if (rs256 && (!privateKey?.includes('PRIVATE KEY') || !publicKey?.includes('PUBLIC KEY'))) {
  // eslint-disable-next-line no-console
  console.error('❌ JWT key material must be PEM-encoded (-----BEGIN …-----).');
  process.exit(1);
}
if (raw.NODE_ENV === 'production') {
  if (!rs256) {
    // eslint-disable-next-line no-console
    console.error('❌ Production requires RS256: set JWT_PRIVATE_KEY[_PATH] and JWT_PUBLIC_KEY[_PATH] (PEM).');
    process.exit(1);
  }
  // Never derive the blind-index key from the JWT secret in production (the
  // secret may not even exist under RS256). It must be an explicit 32-byte key.
  if (!raw.BLIND_INDEX_KEY) {
    // eslint-disable-next-line no-console
    console.error('❌ Production requires an explicit BLIND_INDEX_KEY (64 hex chars).');
    process.exit(1);
  }
  // FR-Q6: onboarding/starter-pack mail is a production capability, so the
  // sending identity must be a real, DKIM-aligned address. Without it the app
  // would silently fall back to outbox capture and no member would ever receive
  // their OTP — a fail-fast here is louder than a member who cannot sign in.
  if (!raw.MAIL_FROM.trim()) {
    // eslint-disable-next-line no-console
    console.error('❌ Production requires MAIL_FROM (e.g. "UDF Party <no-reply@your-domain>").');
    process.exit(1);
  }
}

export const env = {
  ...raw,
  // Resolved RS256 key material (inline value, or contents of the *_PATH file).
  JWT_PRIVATE_KEY: privateKey,
  JWT_PUBLIC_KEY: publicKey,
  isProduction: raw.NODE_ENV === 'production',
  /** Access-token signing algorithm resolved from the provided key material. */
  jwtAlg: rs256 ? ('RS256' as const) : ('HS256' as const),
  corsOrigins: raw.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  /** True once a sending identity is set; false ⇒ the mailer captures to the outbox. */
  smtpConfigured: raw.MAIL_FROM.trim().length > 0,
  /** Envelope bounce address: explicit MAIL_RETURN_PATH, else MAIL_FROM's address. */
  mailReturnPath:
    raw.MAIL_RETURN_PATH?.trim() || raw.MAIL_FROM.match(/<([^>]+)>/)?.[1] || raw.MAIL_FROM.trim(),
} as const;

export type Env = typeof env;
