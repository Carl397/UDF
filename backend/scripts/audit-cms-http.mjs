// Live-HTTP CMS + geo audit probe (read/rollback only against real data).
// Runs the WHOLE authoring flow through an in-process app on an ephemeral port,
// inside one rollback-only transaction (same savepoint patch as
// workflow-regression.mjs), so no row, version or page is ever committed.
// Media files written by the upload pipeline are deleted afterwards.
// Usage: node --import tsx scripts/audit-cms-http.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { createApp } from '../src/app.ts';
import { signAccessToken } from '../src/auth/tokens.ts';
import { env } from '../src/config/env.ts';
import { pool } from '../src/db/pool.ts';
import { Role, permissionsForRole } from '../src/auth/permissions.ts';

if (env.isProduction || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.DATABASE_URL).hostname)) {
  throw new Error('Audit probe requires a local, non-production database');
}

const client = await pool.connect();
const originalQuery = pool.query;
const originalConnect = pool.connect;
let savepoint = 0;
pool.query = client.query.bind(client);
pool.connect = async () => {
  const name = `audit_${++savepoint}`;
  return {
    query(text, values) {
      if (text === 'BEGIN') return client.query(`SAVEPOINT ${name}`);
      if (text === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${name}`);
      if (text === 'ROLLBACK') return client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(text, values);
    },
    release() {},
  };
};

let passed = 0;
let failed = 0;
async function test(name, run) {
  const point = `t_${++savepoint}`;
  await client.query(`SAVEPOINT ${point}`);
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
    await client.query(`ROLLBACK TO SAVEPOINT ${point}`);
  }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PDF = 'data:application/pdf;base64,JVBERi0xLjAKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAzIDNdPj4KZW5kb2JqCnRyYWlsZXIKPDwvUm9vdCAxIDAgUj4+CjUlCg==';

const su = (await client.query(
  `SELECT id, ward_code, region_codes, permission_revokes FROM users WHERE role='superadmin' AND is_active ORDER BY created_at LIMIT 1`,
)).rows[0];
assert.ok(su, 'a superadmin user must exist in the dev DB');
const principal = {
  sub: su.id, role: Role.SUPERADMIN, wardCode: su.ward_code ?? null,
  regionCodes: su.region_codes ?? [], permissions: [...permissionsForRole(Role.SUPERADMIN)],
};
const token = signAccessToken(principal);
const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const member = (await client.query(`SELECT id FROM users WHERE is_active AND role <> 'superadmin' LIMIT 1`)).rows[0];
const memberPrincipal = { sub: member.id, role: Role.MEMBER, wardCode: su.ward_code, regionCodes: [], permissions: [...permissionsForRole(Role.MEMBER)] };

const suffix = randomUUID().slice(0, 8);
const writtenFiles = [];

await client.query('BEGIN');

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  await test('CMS routes require auth and content:manage', async () => {
    assert.equal((await fetch(`${base}/api/crm/superadmin/content`)).status, 401);
    const r = await fetch(`${base}/api/crm/superadmin/content`, { headers: { Authorization: `Bearer ${signAccessToken(memberPrincipal)}` } });
    assert.equal(r.status, 403, 'a member must be denied the CMS authoring surface');
  });

  let pngMediaId = '';
  await test('CMS media upload serves publicly and is an image', async () => {
    const up = await (await fetch(`${base}/api/crm/superadmin/content/media`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ dataUrl: PNG }) })).json();
    pngMediaId = up.mediaId;
    assert.ok(pngMediaId, 'upload returned a mediaId');
    const row = await client.query('SELECT storage_key FROM media_assets WHERE id=$1', [pngMediaId]);
    writtenFiles.push(row.rows[0].storage_key);
    const served = await fetch(`${base}/api/public/content-media/${pngMediaId}`);
    assert.equal(served.status, 200);
    assert.match(served.headers.get('content-type'), /^image\//);
    assert.match(served.headers.get('cache-control') ?? '', /max-age=86400/);
  });

  await test('CMS media upload is image-only (a PDF is refused outright)', async () => {
    // uploadCmsMedia pins captureMode:'photo', so parseCapturedMedia rejects a
    // PDF ("type does not match capture mode") before it can ever be registered.
    const bad = await fetch(`${base}/api/crm/superadmin/content/media`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ dataUrl: PDF }) });
    assert.equal(bad.status, 400, 'a non-image CMS upload must be rejected');
    // The public route also guards by content-type, and never serves an
    // arbitrary internal media id that was not CMS-registered.
    assert.equal((await fetch(`${base}/api/public/content-media/${randomUUID()}`)).status, 404);
  });

  let blockKey = '';
  await test('slider block create -> draft invisible -> publish -> public', async () => {
    blockKey = `qa.${suffix}.hero`;
    const created = await (await fetch(`${base}/api/crm/superadmin/content`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ key: blockKey, site: 'marketing', title: `QA slider ${suffix}`, kind: 'slider', schema: {} }),
    })).json();
    assert.equal(created.block.kind, 'slider');
    assert.equal(created.block.version, 0);

    // Duplicate create must 409 cleanly, not 500.
    const dup = await fetch(`${base}/api/crm/superadmin/content`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ key: blockKey, site: 'marketing', title: 'dup', kind: 'slider', schema: {} }),
    });
    assert.equal(dup.status, 409, 'a duplicate block key is a 409');

    const draft = { slides: [
      { imageMediaId: pngMediaId, title: 'Slide one', text: 'First', durationSeconds: 4 },
      { imageMediaId: '', title: 'Slide two', text: 'Second', durationSeconds: 'oops' },
    ] };
    const saved = await (await fetch(`${base}/api/crm/superadmin/content/${blockKey}/draft`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ draft }),
    })).json();
    assert.equal(saved.block.published, null, 'a draft is never published');
    assert.equal((await fetch(`${base}/api/public/content/${blockKey}`)).status, 404, 'public cannot read a draft');

    await fetch(`${base}/api/crm/superadmin/content/${blockKey}/publish`, { method: 'POST', headers: authHeaders });
    const pub = await (await fetch(`${base}/api/public/content/${blockKey}`)).json();
    assert.equal(pub.kind, 'slider');
    assert.equal(pub.data.slides.length, 2);
    assert.equal(pub.data.slides[0].durationSeconds, 4, 'per-slide durations round-trip');
    assert.equal(pub.data.slides[0].imageMediaId, pngMediaId);
  });

  let pageSlug = '';
  await test('page CRUD: create, sections, publish-only, duplicate guard, rollback', async () => {
    pageSlug = `qa-${suffix}`;
    const page = await (await fetch(`${base}/api/crm/superadmin/content/pages`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ slug: pageSlug, site: 'marketing', title: 'QA page' }),
    })).json();
    assert.equal(page.page.version, 0);
    assert.equal((await fetch(`${base}/api/public/pages/${pageSlug}`)).status, 404, 'an unpublished page is not public');

    // Bad slug (path-ish) must be rejected.
    assert.equal((await fetch(`${base}/api/crm/superadmin/content/pages`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ slug: '../evil', site: 'marketing', title: 'evil' }),
    })).status, 400);

    const sec = await (await fetch(`${base}/api/crm/superadmin/content/pages/${pageSlug}/sections`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ sections: [{ blockKey }] }),
    })).json();
    assert.equal(sec.page.sections[0].blockKey, blockKey);

    // Duplicate blockKey references are refused.
    const dupe = await fetch(`${base}/api/crm/superadmin/content/pages/${pageSlug}/sections`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ sections: [{ blockKey }, { blockKey }] }),
    });
    assert.equal(dupe.status, 400, 'the same block twice in one page is refused');
    const err = await dupe.json();
    assert.match(err.error.message, /twice/);

    // A referenced block cannot be deleted.
    assert.equal((await fetch(`${base}/api/crm/superadmin/content/${blockKey}`, { method: 'DELETE', headers: authHeaders })).status, 409);

    await fetch(`${base}/api/crm/superadmin/content/pages/${pageSlug}/publish`, { method: 'POST', headers: authHeaders });
    const view = await (await fetch(`${base}/api/public/pages/${pageSlug}`)).json();
    assert.equal(view.title, 'QA page');
    assert.deepEqual(view.sections.map((s) => s.key), [blockKey], 'published page resolves ordered blocks');
    assert.equal(view.sections[0].data.slides[1].durationSeconds, 'oops', 'non-numeric duration survives raw and must be clamped client-side');

    // Index lists it; rollback to v1 republishes as v3.
    const index = await (await fetch(`${base}/api/public/pages?site=marketing`)).json();
    assert.ok(index.pages.some((p) => p.slug === pageSlug), 'public page index includes the published page');
    const rolled = await (await fetch(`${base}/api/crm/superadmin/content/pages/${pageSlug}/rollback`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ version: 1 }),
    })).json();
    assert.equal(rolled.page.version, 2, 'rollback of a 1-version page republishes as v2');

    // Unpublish path: delete page then block (order matters, then it is allowed).
    assert.equal((await fetch(`${base}/api/crm/superadmin/content/pages/${pageSlug}`, { method: 'DELETE', headers: authHeaders })).status, 200);
    assert.equal((await fetch(`${base}/api/crm/superadmin/content/${blockKey}`, { method: 'DELETE', headers: authHeaders })).status, 200, 'an unreferenced block deletes fine');
  });

  await test('event list upcoming flag parses query booleans correctly', async () => {
    await client.query(
      `INSERT INTO events (id, title, kind, starts_at, status)
       VALUES ($1, $2, 'meeting', now() - interval '2 days', 'done')`,
      [randomUUID(), `QA past event ${suffix}`],
    );
    const pastVisible = await (await fetch(`${base}/api/events?upcoming=false&limit=200`)).json();
    assert.ok(pastVisible.items.some((e) => e.title === `QA past event ${suffix}`), 'upcoming=false must include past events');
    const pastHidden = await (await fetch(`${base}/api/events?upcoming=true&limit=200`)).json();
    assert.ok(!pastHidden.items.some((e) => e.title === `QA past event ${suffix}`), 'upcoming=true excludes them');
    const garbage = await fetch(`${base}/api/events?upcoming=maybe`);
    assert.equal(garbage.status, 400, 'a non-boolean upcoming value is refused, not silently coerced');
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
  await client.query('ROLLBACK');
  pool.query = originalQuery;
  pool.connect = originalConnect;
  client.release();
  for (const key of writtenFiles) {
    await unlink(key).catch(() => undefined);
  }
  await pool.end();
}

console.log(`Audit probe: ${passed} passed, ${failed} failed. All rows rolled back, uploaded files removed.`);
process.exit(failed ? 1 : 0);
