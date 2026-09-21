import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import pg from 'pg';
import express from 'express';
import { env } from '../src/config/env.ts';
import { pool } from '../src/db/pool.ts';
import { Role, Permission, permissionsForRole } from '../src/auth/permissions.ts';
import { signAccessToken } from '../src/auth/tokens.ts';
import { errorHandler } from '../src/middleware/errorHandler.ts';
import { appReleasesAdminRouter, appReleasesPublicRouter } from '../src/modules/appReleases/routes.ts';
import { artifactSchema, readCatalog, verifiedArtifact } from '../src/modules/appReleases/catalog.ts';
import { publishRelease, withdrawRelease, activeUpdate, listReleases, publishSchema } from '../src/modules/appReleases/service.ts';

if (env.isProduction || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.DATABASE_URL).hostname)) {
  throw new Error('Requires a local non-production database');
}
const schema = `qa_release_${randomUUID().replaceAll('-', '')}`;
const dir = resolve('../.tmp-verify', schema);
const admin = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
const testPool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 8,
  options: `-c search_path=${schema},public -c statement_timeout=10000` });
const old = { query: pool.query, connect: pool.connect, dir: env.APP_RELEASE_CATALOG_DIR, signer: env.APP_RELEASE_SIGNER_SHA256 };
const signer = 'a'.repeat(64);
let server, base, passed = 0, failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack}`); }
}
const rejects = (run, status) => assert.rejects(run, e => e.status === status);
async function user(role = Role.SUPERADMIN, grants = []) {
  const sub = randomUUID();
  await testPool.query('INSERT INTO users(id,password_hash,role,permission_grants) VALUES ($1,$2,$3,$4)', [sub, 'not-a-login-hash', role, grants]);
  const p = { sub, role, permissions: [...permissionsForRole(role)] };
  return { ...p, token: signAccessToken(p, 0) };
}
const catalog = { schema: 1, baselineVersionCode: 6, releases: [] };
const save = () => writeFile(resolve(dir, 'catalog.json'), JSON.stringify(catalog));
async function artifact(code) {
  const data = Buffer.from(`Synthetic APK fixture ${code}; NOT INSTALLABLE`);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const id = `${code}-${sha256}`;
  const a = { id, packageId: 'com.udf.party', versionCode: code, versionName: `1.0.${code - 1}`, sha256,
    bytes: data.length, signerSha256: signer, path: `/downloads/udf-${id}.apk` };
  await writeFile(resolve(dir, basename(a.path)), data);
  catalog.releases.push({ artifact: a, publicVerified: true });
  await save();
  return a;
}
const input = (a, expectedAnnouncementId = null, notes = 'Synthetic update notice') => ({ artifactId: a.id, expectedAnnouncementId, notes });
async function http(path, p, body) {
  return fetch(base + path, { method: body ? 'POST' : 'GET', redirect: 'manual',
    headers: { ...(p ? { Authorization: `Bearer ${p.token}` } : {}), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
try {
  await mkdir(dir, { recursive: true });
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const t of ['users', 'role_module_gates', 'app_downloads']) {
    await admin.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
  }
  await testPool.query(await readFile(new URL('../src/db/migrations/052_app_releases.sql', import.meta.url), 'utf8'));
  pool.query = testPool.query.bind(testPool); pool.connect = testPool.connect.bind(testPool);
  env.APP_RELEASE_CATALOG_DIR = dir; env.APP_RELEASE_SIGNER_SHA256 = signer;
  const p = await user();
  const a7 = await artifact(7), a8 = await artifact(8), a9 = await artifact(9), a10 = await artifact(10);
  const app = express(); app.use(express.json());
  app.use('/admin', appReleasesAdminRouter); app.use('/public', appReleasesPublicRouter); app.use(errorHandler);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await test('management denies anonymous and every lower role even with an explicit grant', async () => {
    assert.equal((await http('/admin')).status, 401);
    for (const role of Object.values(Role).filter(r => r !== Role.SUPERADMIN)) {
      const u = await user(role, [Permission.APP_RELEASE_MANAGE]);
      assert.equal((await http('/admin', u)).status, 403);
      assert.equal((await http('/admin/publish', u, input(a7))).status, 403);
      assert.equal((await http('/admin/withdraw', u, { announcementId: randomUUID() })).status, 403);
    }
  });
  await test('live permission revoke and disabled superadmin module deny access', async () => {
    await testPool.query('UPDATE users SET permission_revokes=$2 WHERE id=$1', [p.sub, [Permission.APP_RELEASE_MANAGE]]);
    assert.equal((await http('/admin', p)).status, 403);
    await testPool.query('UPDATE users SET permission_revokes=ARRAY[]::text[] WHERE id=$1', [p.sub]);
    await testPool.query("INSERT INTO role_module_gates(role,module_key,enabled) VALUES ('superadmin','superadmin',false)");
    assert.equal((await http('/admin/publish', p, input(a7))).status, 403);
    await testPool.query("DELETE FROM role_module_gates WHERE role='superadmin'");
  });
  await test('no active release is public null without authentication and no-store', async () => {
    const r = await http('/public/app-update'); assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(await r.json(), null);
  });
  await test('strict input rejects URLs, extra metadata, malformed IDs and oversized notes', async () => {
    for (const x of [{ ...input(a7), url: 'https://invalid.example/x.apk' }, { ...input(a7), artifactId: '../x' }, input(a7, null, 'x'.repeat(2001)), input(a7, null, ' ')]) {
      assert.equal(publishSchema.safeParse(x).success, false);
      assert.equal((await http('/admin/publish', p, x)).status, 400);
    }
  });
  await test('catalog rejects package, signer, version duplication and noncanonical paths', async () => {
    for (const patch of [{ packageId: 'com.udf.mail' }, { path: 'https://evil.test/app.apk' }, { versionCode: 1.5 }, { id: '../etc' }]) {
      assert.equal(artifactSchema.safeParse({ ...a7, ...patch }).success, false);
    }
    catalog.releases[0].artifact = { ...a7, signerSha256: 'b'.repeat(64) }; await save(); await assert.rejects(readCatalog);
    catalog.releases[0].artifact = a7; catalog.releases.push(catalog.releases[0]); await save(); await assert.rejects(readCatalog);
    catalog.releases.pop(); await save();
  });
  await test('unpublished, missing, corrupt and symlink artifacts cannot be announced', async () => {
    catalog.releases[0].publicVerified = false; await save(); await rejects(() => publishRelease(p, input(a7)), 409);
    catalog.releases[0].publicVerified = true; await save();
    const path = resolve(dir, basename(a7.path)); const original = await readFile(path);
    assert.ok(await verifiedArtifact(a7.id));
    await writeFile(path, Buffer.alloc(original.length, 120)); await assert.rejects(() => publishRelease(p, input(a7)));
    await writeFile(path, original); assert.ok(await verifiedArtifact(a7.id));
    const missing = { ...a7, versionCode: 11, versionName: '1.0.10', id: `11-${a7.sha256}`, path: `/downloads/udf-11-${a7.sha256}.apk` };
    catalog.releases.push({ artifact: missing, publicVerified: true }); await save();
    await assert.rejects(() => verifiedArtifact(missing.id));
    await symlink(path, resolve(dir, basename(missing.path))); await assert.rejects(() => verifiedArtifact(missing.id));
    catalog.releases.pop(); await save();
    assert.equal(await activeUpdate(), null);
  });
  let n7;
  await test('concurrent identical publication is idempotent with exactly one durable audit', async () => {
    const results = await Promise.all([publishRelease(p, input(a7)), publishRelease(p, input(a7))]);
    assert.equal(results.filter(r => r.changed).length, 1); assert.equal(results[0].announcementId, results[1].announcementId);
    n7 = results[0].announcementId;
    assert.equal((await testPool.query('SELECT count(*)::int AS n FROM app_release_events')).rows[0].n, 1);
  });
  await test('public safe metadata has no actors, signer or filesystem path', async () => {
    const v = await (await http('/public/app-update')).json();
    assert.equal(v.versionCode, 7); assert.equal(v.notes, 'Synthetic update notice');
    for (const key of ['publishedBy', 'signerSha256', 'path', 'root', 'events']) assert.equal(key in v, false);
    assert.equal(v.downloadUrl, `https://crm.udf-party.co.za/api/public/download/app-release/${a7.id}`);
  });
  await test('release redirect is immutable and records existing APK analytics', async () => {
    const r = await http(`/public/download/app-release/${a7.id}`);
    assert.equal(r.status, 302); assert.equal(r.headers.get('location'), `https://crm.udf-party.co.za${a7.path}`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal((await testPool.query('SELECT count(*)::int AS n FROM app_downloads')).rows[0].n, 1);
  });
  await test('stale expected state and conflicting same-version notes rejected', async () => {
    await rejects(() => publishRelease(p, input(a8)), 409);
    await rejects(() => publishRelease(p, input(a7, n7, 'Changed notes')), 409);
  });
  let current;
  await test('different concurrent publications have one winner and preserve supersede audit', async () => {
    const result = await Promise.allSettled([publishRelease(p, input(a8, n7)), publishRelease(p, input(a9, n7))]);
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
    current = await activeUpdate(); assert.ok([8, 9].includes(current.versionCode));
    assert.equal((await http(`/public/download/app-release/${a7.id}`)).status, 404);
    const state = await listReleases(p); assert.equal(state.history.length, 2); assert.equal(state.events.length, 3);
  });
  await test('immutable identity and audit cannot be changed in place', async () => {
    await assert.rejects(() => testPool.query('UPDATE app_release_artifacts SET artifact=artifact'));
    await assert.rejects(() => testPool.query("UPDATE app_release_events SET action='withdraw'"));
  });
  await test('audit failure rolls back state, history, and artifact registration', async () => {
    await testPool.query("ALTER TABLE app_release_events ADD CONSTRAINT qa_fail CHECK(action <> 'publish') NOT VALID");
    await assert.rejects(() => publishRelease(p, input(a10, current.announcementId)));
    await testPool.query('ALTER TABLE app_release_events DROP CONSTRAINT qa_fail');
    assert.equal((await activeUpdate()).announcementId, current.announcementId);
    assert.equal((await testPool.query('SELECT count(*)::int AS n FROM app_release_artifacts WHERE version_code=10')).rows[0].n, 0);
  });
  await test('withdrawal is idempotent, clears public response, refuses rollback/resurrection', async () => {
    assert.equal((await withdrawRelease(p, { announcementId: current.announcementId })).changed, true);
    assert.equal((await withdrawRelease(p, { announcementId: current.announcementId })).changed, false);
    assert.equal(await activeUpdate(), null);
    await rejects(() => publishRelease(p, input(a7)), 409);
    await rejects(() => publishRelease(p, input(catalog.releases.find(r => r.artifact.id === current.artifactId).artifact)), 409);
    assert.equal((await http(`/public/download/app-release/${current.artifactId}`)).status, 404);
    const next = await publishRelease(p, input(a10));
    await withdrawRelease(p, { announcementId: current.announcementId });
    assert.equal((await activeUpdate()).announcementId, next.announcementId);
  });
} finally {
  if (server) await new Promise(r => server.close(r));
  pool.query = old.query; pool.connect = old.connect;
  env.APP_RELEASE_CATALOG_DIR = old.dir; env.APP_RELEASE_SIGNER_SHA256 = old.signer;
  await testPool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); await pool.end();
}
console.log(`App releases: ${passed} passed, ${failed} failed. Only isolated synthetic data used.`);
if (failed) process.exitCode = 1;
