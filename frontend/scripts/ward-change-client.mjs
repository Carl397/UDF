import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { publicErrorMessage } from '../../backend/src/http/errors.ts';

// Load both through the same CommonJS graph so instanceof uses one class identity.
const require = createRequire(import.meta.url);
const { api, tokenStore, onSessionChange, ApiClientError, apiErrorMessage } = require('../src/lib/api.ts');
const { wardErrorMessage } = require('../src/components/tabs/WardSettings.tsx');

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
  await test('legacy missing-route responses never expose methods, paths or details', async () => {
    const before = new Map(store);
    globalThis.fetch = async () => Response.json({ error: {
      code: 'not_found', message: 'No route for GET /api/members/me/ward',
      details: { stack: 'Error at /opt/udf/backend/routes.js:12', query: 'SELECT * FROM users' },
    } }, { status: 404 });
    for (const run of [() => api.ownWardChanges(), () => api.changeOwnWard('QA-W2', 'QA-W1')]) {
      await assert.rejects(run, (error) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.status, 404);
        assert.equal(error.code, 'not_found');
        assert.equal(error.message, 'This service or item is currently unavailable. Please try again later.');
        assert.equal(wardErrorMessage(error, 'load'), 'Unable to load your registered ward right now. Please try again later.');
        assert.equal(error.details, undefined);
        assert.doesNotMatch(error.message, /GET|\/api|SELECT|routes\.js/);
        return true;
      });
    }
    assert.deepEqual(store, before);
    assert.deepEqual(events, []);
  });
  await test('technical server messages and malformed error envelopes use fixed copy', async () => {
    tokenStore.clear();
    for (const httpStatus of [400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 504]) {
      for (const body of [{ error: { code: 'error', message: 'SELECT users at /opt/internal', details: 'trace' } },
        { error: { code: { raw: 'internal' }, message: ['trace'] } }, null, 'backend failure']) {
        globalThis.fetch = async () => Response.json(body, { status: httpStatus });
        await assert.rejects(() => api.publicMeta(), (error) => error instanceof ApiClientError &&
          error.status === httpStatus && error.message === apiErrorMessage(httpStatus, 'error'));
      }
    }
  });
  await test('HTML errors and invalid successful JSON are never returned as empty success', async () => {
    for (const httpStatus of [200, 404, 502]) {
      globalThis.fetch = async () => new Response('<html>nginx /opt/internal</html>', { status: httpStatus, statusText: 'Technical upstream failure' });
      await assert.rejects(() => api.ownWardChanges(), (error) => error instanceof ApiClientError &&
        error.status === httpStatus && !/nginx|internal|upstream|html/.test(error.message));
    }
    globalThis.fetch = async () => Response.json({ error: { message: 'Internal failure disguised as success' } });
    await assert.rejects(() => api.publicMeta(), (error) => error.code === 'invalid_response');
  });
  await test('malformed ward data cannot fake success or overwrite session and allowance', async () => {
    const before = new Map(store);
    for (const body of [null, {}, [], { ...status, changesUsed: '1' }, { ...status, changesRemaining: 99 },
      { ...status, wardCode: undefined }, { ...status, maxChanges: 4 }]) {
      globalThis.fetch = async () => Response.json(body);
      await assert.rejects(() => api.ownWardChanges(), (error) => error.code === 'invalid_response');
      await assert.rejects(() => api.changeOwnWard('QA-W2', 'QA-W1'), (error) => error.code === 'invalid_response');
    }
    for (const body of [{ ...status, changed: true }, { ...status, accessToken: updated }]) {
      globalThis.fetch = async () => Response.json(body);
      await assert.rejects(() => api.changeOwnWard('QA-W2', 'QA-W1'), (error) => error.code === 'invalid_response');
    }
    globalThis.fetch = async () => new Response(null, { status: 204 });
    await assert.rejects(() => api.ownWardChanges(), (error) => error.code === 'invalid_response');
    assert.equal(await api.deleteAttachment('synthetic'), undefined);
    assert.deepEqual(store, before);
    assert.deepEqual(events, []);
  });
  await test('network failures never show URLs or native transport diagnostics', async () => {
    const before = new Map(store);
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch https://internal/api/members/me/ward: ECONNREFUSED'); };
    for (const run of [() => api.ownWardChanges(), () => api.changeOwnWard('QA-W2', 'QA-W1'),
      () => api.coverBlob('/cover'), () => api.transparencyMediaBlob('fixture'),
      () => api.cardMediaBlob('fixture'), () => api.attachmentFileBlob('fixture')]) {
      await assert.rejects(run, (error) => error instanceof ApiClientError && error.code === 'network_error' &&
        error.message === 'Unable to connect. Please check your connection and try again.');
    }
    assert.deepEqual(store, before);
    assert.deepEqual(events, []);
  });
  await test('response body failures are sanitized and cancellation remains recognizable', async () => {
    globalThis.fetch = async () => ({ ok: true, blob: async () => { throw new Error('stream failed at /internal'); } });
    await assert.rejects(() => api.coverBlob('/cover'), (error) => error.code === 'network_error');
    const controller = new AbortController();
    controller.abort('private cancellation reason');
    globalThis.fetch = async () => { throw new Error('private cancellation reason'); };
    await assert.rejects(() => api.coverBlob('/cover', controller.signal), (error) =>
      error.name === 'AbortError' && error.code === 'request_cancelled' && error.message === 'The request was canceled. Please try again.');
  });
  await test('known business errors preserve useful wording without trusting server text', async () => {
    for (const [httpStatus, code] of [[409, 'ward_change_limit'], [409, 'ward_change_stale'], [400, 'invalid_ward'],
      [400, 'invalid_current_password'], [400, 'password_reused'], [403, 'ward_profile_unavailable'], [403, 'device_banned']]) {
      globalThis.fetch = async () => Response.json({ error: { code, message: 'Internal diagnostic /api/secret' } }, { status: httpStatus });
      await assert.rejects(() => api.changeOwnWard('QA-W2', 'QA-W1'), (error) =>
        error.code === code && wardErrorMessage(error, 'save') === apiErrorMessage(httpStatus, code));
    }
    assert.match(apiErrorMessage(409, 'ward_change_limit'), /all 3 ward changes/);
    assert.match(apiErrorMessage(409, 'ward_change_stale'), /reload/);
  });
  await test('backend and client public wording match with no inherited or mismatched-code lookup', async () => {
    const codes = ['error', 'validation_error', 'bad_request', 'unauthorized', 'forbidden', 'not_found',
      'device_banned', 'account_banned', 'account_suspended', 'invalid_current_password', 'password_reused',
      'module_lockout', 'unknown_module', 'duplicate_page_section', 'ward_profile_unavailable', 'ward_members_only',
      'ward_change_stale', 'ward_change_limit', 'invalid_ward', '__proto__', 'constructor', 'toString'];
    for (const httpStatus of [400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504]) {
      for (const code of codes) assert.equal(apiErrorMessage(httpStatus, code), publicErrorMessage(httpStatus, code));
    }
    assert.equal(apiErrorMessage(500, 'ward_change_limit'), 'Something went wrong. Please try again later.');
    assert.equal(wardErrorMessage(new Error('No route for GET /api/internal'), 'save'),
      'We could not confirm your ward change. Please reload your registered ward before trying again.');
    const tampered = new ApiClientError(409, 'ward_change_stale');
    tampered.message = 'SELECT internal';
    assert.equal(wardErrorMessage(tampered, 'save'), apiErrorMessage(409, 'ward_change_stale'));
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
