import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { z } from 'zod';
import { env } from '../../config/env.js';

export const OFFICIAL_ORIGIN = 'https://crm.udf-party.co.za';
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const artifactSchema = z.object({
  id: z.string(), packageId: z.literal('com.udf.party'),
  versionCode: z.number().int().positive().max(2100000000),
  versionName: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/).max(64),
  sha256: digest, bytes: z.number().int().positive().max(300_000_000),
  signerSha256: digest, path: z.string(),
}).strict().superRefine((a, ctx) => {
  if (a.id !== `${a.versionCode}-${a.sha256}` || a.path !== `/downloads/udf-${a.id}.apk`) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Noncanonical artifact identity' });
  }
});
export type Artifact = z.infer<typeof artifactSchema>;
const catalogSchema = z.object({
  schema: z.literal(1), baselineVersionCode: z.number().int().nonnegative(),
  releases: z.array(z.object({ artifact: artifactSchema, publicVerified: z.boolean() }).strict()).max(200),
}).strict();

// In production even a compromised API identity cannot replace the catalog or
// its parents. APK verification is done offline by the operator tool; requests
// verify these attested identities against bytes, never fetch arbitrary URLs.
async function trustedPath(path: string, directory = false) {
  const st = await lstat(path);
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile())) throw new Error('Invalid catalog path');
  if (env.isProduction && (st.uid !== 0 || (st.mode & 0o022) !== 0 || process.getuid?.() === 0)) {
    throw new Error('Catalog must be root-owned and not writable by the API');
  }
  return st;
}
async function rootDirectory() {
  if (!env.APP_RELEASE_CATALOG_DIR || !env.APP_RELEASE_SIGNER_SHA256) return null;
  const root = resolve(env.APP_RELEASE_CATALOG_DIR);
  for (let p = root; ; p = dirname(p)) {
    await trustedPath(p, true);
    if (p === dirname(p)) break;
  }
  return root;
}
async function readTrusted(path: string, maxBytes: number) {
  await trustedPath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) throw new Error('Invalid catalog file size');
    return await handle.readFile();
  } finally { await handle.close(); }
}
export async function readCatalog() {
  const root = await rootDirectory();
  if (!root) return { root: null, baselineVersionCode: 0, releases: [] };
  const raw = await readTrusted(resolve(root, 'catalog.json'), 1_000_000);
  const data = catalogSchema.parse(JSON.parse(raw.toString('utf8')));
  const seen = new Set<number>();
  for (const { artifact: a } of data.releases) {
    if (a.signerSha256 !== env.APP_RELEASE_SIGNER_SHA256 || seen.has(a.versionCode) || a.versionCode <= data.baselineVersionCode) {
      throw new Error('Catalog signer, version, or uniqueness check failed');
    }
    seen.add(a.versionCode);
  }
  return { root, ...data };
}
const verifiedBytes = new Map<string, Promise<void>>();
export async function verifiedArtifact(id: string): Promise<Artifact | null> {
  const catalog = await readCatalog();
  const entry = catalog.releases.find((r) => r.artifact.id === id);
  if (!catalog.root || !entry?.publicVerified) return null;
  const a = entry.artifact;
  const path = resolve(catalog.root, basename(a.path));
  const st = await trustedPath(path);
  if (st.size !== a.bytes) throw new Error('Prepared APK size mismatch');
  // Rehash changed files, but coalesce concurrent polling of immutable bytes.
  const stamp = (s: typeof st) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode, s.uid].join(':');
  const key = `${path}:${a.sha256}:${stamp(st)}`;
  let verified = verifiedBytes.get(key);
  if (!verified) {
    verified = (async () => {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (stamp(await handle.stat()) !== stamp(st)) throw new Error('Artifact changed during verification');
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        if (hash.digest('hex') !== a.sha256 || stamp(await handle.stat()) !== stamp(st)) {
          throw new Error('Prepared APK bytes do not match catalog');
        }
      } finally { await handle.close(); }
    })();
    if (verifiedBytes.size >= 20) verifiedBytes.clear();
    verifiedBytes.set(key, verified);
  }
  try { await verified; } catch (e) { verifiedBytes.delete(key); throw e; }
  return a;
}
