import assert from 'node:assert/strict';
import { api, tokenStore } from '../src/lib/api.ts';

// Network-free tests of authenticated attachment loading and session rotation.
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const storage = new Map();
globalThis.window = { localStorage: {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
} };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const media = () => new Response('attachment', { headers: { 'Content-Type': 'audio/webm' } });
let passed = 0;
async function test(name, run) {
  storage.clear();
  tokenStore.set('expired-access', 'test-refresh');
  await run();
  passed++;
  console.log(`PASS ${name}`);
}
try {
  await test('attachment retries once after refreshing an expired session', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push([url, init]);
      if (url.endsWith('/auth/refresh')) return json({ accessToken: 'fresh-access', refreshToken: 'rotated', permissions: ['patrol:read'], enabledModules: ['patrols'] });
      return init.headers.Authorization === 'Bearer fresh-access' ? media() : json({}, 401);
    };
    const blob = await api.transparencyMediaBlob('fixture');
    assert.equal(blob.type, 'audio/webm');
    assert.equal(await blob.text(), 'attachment');
    assert.equal(calls.length, 3);
    assert.deepEqual(tokenStore.permissions, ['patrol:read']);
  });
  await test('concurrent attachments share one refresh', async () => {
    let refreshes = 0;
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/auth/refresh')) {
        refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return json({ accessToken: 'fresh-access', refreshToken: 'rotated' });
      }
      return init.headers.Authorization === 'Bearer fresh-access' ? media() : json({}, 401);
    };
    const blobs = await Promise.all([api.transparencyMediaBlob('one'), api.transparencyMediaBlob('two')]);
    assert.ok(blobs.every(Boolean));
    assert.equal(refreshes, 1);
  });
  await test('a late expired response uses the already refreshed token', async () => {
    let refreshes = 0;
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/auth/refresh')) { refreshes++; return json({ accessToken: 'fresh-access', refreshToken: 'rotated' }); }
      if (init.headers.Authorization === 'Bearer fresh-access') return media();
      if (url.endsWith('/slow')) await new Promise((resolve) => setTimeout(resolve, 30));
      return json({}, 401);
    };
    assert.ok((await Promise.all([api.transparencyMediaBlob('fast'), api.transparencyMediaBlob('slow')])).every(Boolean));
    assert.equal(refreshes, 1);
  });
  await test('forbidden and missing media never refresh or loop', async () => {
    for (const status of [403, 404]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return json({}, status); };
      assert.equal(await api.transparencyMediaBlob('fixture'), null);
      assert.equal(calls, 1);
    }
  });
  await test('a second unauthorized response stops the retry', async () => {
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      return url.endsWith('/auth/refresh') ? json({ accessToken: 'fresh-access', refreshToken: 'rotated' }) : json({}, 401);
    };
    assert.equal(await api.transparencyMediaBlob('fixture'), null);
    assert.equal(calls, 3);
  });
  await test('aborted attachment does not rotate the session', async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = async (_url, init) => { calls++; assert.equal(init.signal, controller.signal); controller.abort(); return json({}, 401); };
    assert.equal(await api.transparencyMediaBlob('fixture', controller.signal), null);
    assert.equal(calls, 1);
  });
  await test('network failure remains retryable without clearing credentials', async () => {
    globalThis.fetch = async () => { throw new TypeError('Offline'); };
    await assert.rejects(() => api.transparencyMediaBlob('fixture'), /Offline/);
    assert.equal(tokenStore.access, 'expired-access');
  });
  await test('report creation preserves its request ID during access-token replay', async () => {
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/auth/refresh')) return json({ accessToken: 'fresh-access', refreshToken: 'rotated' });
      bodies.push(JSON.parse(init.body));
      return new Headers(init.headers).get('Authorization') === 'Bearer fresh-access' ? json({ id: 'report' }) : json({}, 401);
    };
    const payload = { requestId: '00000000-0000-4000-8000-000000000001', category: 'Other', message: 'Retry fixture', media: [] };
    await api.submitResidentReport(payload);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies, [payload, payload]);
  });
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
console.log(`Client workflow regression: ${passed} passed.`);
