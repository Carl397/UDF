import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config/env.js';

/**
 * KMS abstraction — the trust anchor for Layer 3 (field-level) encryption.
 *
 * Envelope encryption model:
 *   • A Data Encryption Key (DEK) encrypts the actual record field.
 *   • The KMS's Key Encryption Key (KEK) wraps/protects the DEK.
 *   • Only the wrapped DEK is stored next to the ciphertext; the plaintext
 *     DEK is generated in memory and wiped after use.
 *
 * Swapping `local` for a real HSM/KMS (AWS KMS, GCP KMS, Vault) requires no
 * changes to callers — they only use the {@link KmsProvider} interface.
 */
export interface DataKey {
  /** Plaintext DEK. MUST be zeroed after use (see crypto util). */
  plaintext: Buffer;
  /** Wrapped (encrypted) DEK, safe to persist. base64. */
  wrapped: string;
  /** Identifies which KEK/version wrapped this DEK (for rotation). */
  keyId: string;
}

export interface KmsProvider {
  readonly name: string;
  generateDataKey(): Promise<DataKey>;
  decryptDataKey(wrapped: string, keyId: string): Promise<Buffer>;
}

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/** Local, file/env-backed KMS. FOR DEVELOPMENT ONLY. */
class LocalKmsProvider implements KmsProvider {
  readonly name = 'local';
  private readonly kek: Buffer;

  constructor(kekHex: string) {
    this.kek = Buffer.from(kekHex, 'hex');
    if (this.kek.length !== 32) {
      throw new Error('LOCAL_KEK must decode to exactly 32 bytes (AES-256).');
    }
    if (env.isProduction && /^0+$/.test(kekHex)) {
      throw new Error('Refusing to run in production with an all-zero KEK.');
    }
  }

  async generateDataKey(): Promise<DataKey> {
    const plaintext = randomBytes(32); // AES-256 DEK
    const wrapped = this.wrap(plaintext);
    return { plaintext, wrapped, keyId: 'local:kek:v1' };
  }

  async decryptDataKey(wrapped: string): Promise<Buffer> {
    return this.unwrap(wrapped);
  }

  /** AES-256-GCM: iv(12) || tag(16) || ciphertext */
  private wrap(dek: Buffer): string {
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64');
  }

  private unwrap(blobB64: string): Buffer {
    const blob = Buffer.from(blobB64, 'base64');
    const iv = blob.subarray(0, GCM_IV_BYTES);
    const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
    const ct = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.kek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}

/**
 * AWS KMS provider — integration point. Wire up @aws-sdk/client-kms here:
 *   generateDataKey → kms:GenerateDataKey (KeySpec=AES_256)
 *   decryptDataKey  → kms:Decrypt
 * Left as a stub so the scaffold has no hard cloud dependency.
 */
class AwsKmsProvider implements KmsProvider {
  readonly name = 'aws-kms';
  async generateDataKey(): Promise<DataKey> {
    throw new Error('AwsKmsProvider not implemented — add @aws-sdk/client-kms.');
  }
  async decryptDataKey(): Promise<Buffer> {
    throw new Error('AwsKmsProvider not implemented — add @aws-sdk/client-kms.');
  }
}

function buildProvider(): KmsProvider {
  switch (env.KMS_PROVIDER) {
    case 'aws-kms':
      return new AwsKmsProvider();
    case 'local':
      return new LocalKmsProvider(env.LOCAL_KEK as string);
    default:
      throw new Error(`Unsupported KMS_PROVIDER: ${env.KMS_PROVIDER}`);
  }
}

export const kms: KmsProvider = buildProvider();

/** Overwrite a sensitive buffer in place (best-effort; V8 may have copies). */
export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}

/** Constant-time string comparison for tokens/secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
