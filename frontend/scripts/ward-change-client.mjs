import assert from 'node:assert/strict';
import { api, tokenStore, onSessionChange } from '../src/lib/api.ts';

// In-memory browser and API doubles; never access a real account or endpoint.
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const store = new Map();
globalThis.window = { localStorage: {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, value),
  removeItem: (key) => store.delete(key),
} };
const jwt = (wardCode, sub = 'synthetic-member') => `header.${Buffer.from(JSON.stringify({ sub, role: 'member', wardCode })).toString('base64url')}.signature`;
const current = jwt('QA-W1');
const updated = jwt('QA-W2');
const status = { wardCode: 'QA-W2', wardName: 'QA ward 2', regionCode: 'QA-SC', changesUsed: 1, changesRemaining: 2, maxChanges: 3 };
const response = () => Response.json({ ...status, changed: true, accessToken: updated });
const events = [];
const off = onSessionChange((token) => events.push(token));
let passed = 0;
async function test(name, run) {
  store.clear();
  events.length = 0;
  tokenStore.set(current, 'synthetic-refresh');
  tokenStore.setPermissions(['geo:read_own_ward']);
  tokenStore.setModules(['map']);
  store.set('unrelated-preference', 'preserve');
  await run();
  passed++;
  console.log(`PASS ${name}`);
}
try {
  await test('loads the server counter with no-store caching', async () => {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, '/api/members/me/ward');
      assert.equal(init.cache, 'no-store');
      return Response.json(status);
    };
    assert.deepEqual(await api.ownWardChanges(), status);
  });
  await test('sends compare-and-set only and updates scope without clearing session/data', async () => {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, '/api/members/me/ward');
      assert.equal(init.method, 'PATCH');
      assert.deepEqual(JSON.parse(init.body), { wardCode: 'QA-W2', expectedWardCode: 'QA-W1' });
      return response();
    };
    assert.equal((await api.changeOwnWard('QA-W2', 'QA-W1')).changesRemaining, 2);
    assert.equal(tokenStore.access, updated);
    assert.equal(tokenStore.refresh, 'synthetic-refresh');
    assert.deepEqual(tokenStore.permissions, ['geo:read_own_ward']);
    assert.deepEqual(tokenStore.modules, ['map']);
    assert.equal(store.get('unrelated-preference'), 'preserve');
    assert.deepEqual(events, [updated]);
  });
  await test('a 409 or offline error never decrements a counter or changes local scope', async () => {
    globalThis.fetch = async () => Response.json({ error: { code: 'conflict', message: 'All changes used' } }, { status: 409 });
    await assert.rejects(() => api.changeOwnWard('QA-W2', 'QA-W1'), (e) => e.status === 409);
    assert.equal(tokenStore.access, current);
    globalThis.fetch = async () => { throw new Error('Offline'); };
    await assert.rejects(() => api.changeOwnWard('QA-W2', 'QA-W1'));
    assert.equal(tokenStore.access, current);
    assert.deepEqual(events, []);
  });
  await test('expired access token rotates once and adopts the new ward with the rotated session', async () => {
    let attempts = 0;
    globalThis.fetch = async (url) => {
      if (url.endsWith('/auth/refresh')) return Response.json({ accessToken: current, refreshToken: 'rotated-refresh', permissions: ['geo:read_own_ward'], enabledModules: ['map'] });
      if (attempts++ === 0) return Response.json({ error: 'Expired' }, { status: 401 });
      return response();
    };
    await api.changeOwnWard('QA-W2', 'QA-W1');
    assert.equal(attempts, 2);
    assert.equal(tokenStore.refresh, 'rotated-refresh');
    assert.equal(tokenStore.access, updated);
    assert.equal(events.at(-1), updated);
  });
  await test('delayed response cannot restore a logged-out session', async () => {
    globalThis.fetch = async () => { tokenStore.clear(); return response(); };
    await api.changeOwnWard('QA-W2', 'QA-W1');
    assert.equal(tokenStore.access, null);
    assert.equal(tokenStore.refresh, null);
    assert.deepEqual(events, []);
  });
  await test('delayed response cannot replace a different signed-in account', async () => {
    const other = jwt('QA-W3', 'different-synthetic-member');
    globalThis.fetch = async () => { tokenStore.set(other, 'different-refresh'); return response(); };
    await api.changeOwnWard('QA-W2', 'QA-W1');
    assert.equal(tokenStore.access, other);
    assert.equal(tokenStore.refresh, 'different-refresh');
    assert.deepEqual(events, []);
  });
  await test('initial assignment preserves null expected ward in the request', async () => {
    globalThis.fetch = async (_url, init) => {
      assert.equal(JSON.parse(init.body).expectedWardCode, null);
      return response();
    };
    await api.changeOwnWard('QA-W2', null);
  });
} finally {
  off();
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
console.log(`Ward change client: ${passed} passed. No network or persisted browser data used.`);
