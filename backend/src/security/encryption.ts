import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { kms, zeroBuffer, type DataKey } from './kms.js';

/**
 * Layer 3 — Application / field-level encryption.
 *
 * Each sensitive record is sealed with a fresh Data Encryption Key (DEK).
 * The DEK is wrapped by the KMS (KEK) and stored alongside the ciphertext,
 * so the database alone never contains enough material to decrypt anything
 * (envelope encryption). GCM provides authenticated encryption (AEAD) and we
 * bind each field to an AAD context (recordId + fieldName) so ciphertexts
 * cannot be swapped between fields or records undetected.
 *
 * Blob wire format (base64): iv(12) || authTag(16) || ciphertext
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGO = 'aes-256-gcm';

export interface SealedRecord {
  /** Wrapped DEK (base64), safe to store. */
  wrappedDek: string;
  /** KEK id/version used to wrap the DEK (supports rotation). */
  keyId: string;
  /** fieldName → sealed blob (base64). */
  fields: Record<string, string>;
}

function encryptWithDek(
  plaintext: string,
  dek: Buffer,
  aad: string,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, dek, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptWithDek(
  blobB64: string,
  dek: Buffer,
  aad: string,
): string {
  const blob = Buffer.from(blobB64, 'base64');
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, dek, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Seal a set of plaintext fields for one record.
 * @param recordId stable id used as AAD context (prevents field swapping)
 * @param fields   map of fieldName → plaintext string
 */
export async function sealRecord(
  recordId: string,
  fields: Record<string, string>,
): Promise<SealedRecord> {
  const dataKey: DataKey = await kms.generateDataKey();
  try {
    const sealed: Record<string, string> = {};
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      sealed[name] = encryptWithDek(String(value), dataKey.plaintext, `${recordId}:${name}`);
    }
    return { wrappedDek: dataKey.wrapped, keyId: dataKey.keyId, fields: sealed };
  } finally {
    zeroBuffer(dataKey.plaintext);
  }
}

/** Reverse of {@link sealRecord}. */
export async function openRecord(
  recordId: string,
  sealed: SealedRecord,
): Promise<Record<string, string>> {
  const dek = await kms.decryptDataKey(sealed.wrappedDek, sealed.keyId);
  try {
    const out: Record<string, string> = {};
    for (const [name, blob] of Object.entries(sealed.fields)) {
      out[name] = decryptWithDek(blob, dek, `${recordId}:${name}`);
    }
    return out;
  } finally {
    zeroBuffer(dek);
  }
}

/** Convenience: seal a single value (own DEK). */
export async function sealValue(recordId: string, field: string, value: string) {
  return sealRecord(recordId, { [field]: value });
}
