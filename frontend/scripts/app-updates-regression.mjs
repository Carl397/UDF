import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdateController, parseAppUpdate } from '../src/lib/appUpdates.ts';
import MapScrollLayoutModule, { mapScrollState } from '../src/components/MapScrollLayout.tsx';

// tsx wraps this workspace's TSX default export in a CommonJS namespace.
const MapScrollLayout = typeof MapScrollLayoutModule === 'function' ? MapScrollLayoutModule : MapScrollLayoutModule.default;
assert.equal(typeof MapScrollLayout, 'function');
globalThis.React = React;
const timers = new Map(); let timerId = 0;
const originals = { setTimeout, clearTimeout, setInterval, clearInterval };
globalThis.setTimeout = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, interval: false }); return id; };
globalThis.setInterval = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, interval: true }); return id; };
globalThis.clearTimeout = globalThis.clearInterval = (id) => { timers.delete(id); };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const fixture = (versionCode = 8) => ({ announcementId: '11111111-1111-4111-8111-111111111111',
  artifactId: `${versionCode}-${'a'.repeat(64)}`, packageId: 'com.udf.party', versionCode,
  versionName: `1.0.${versionCode - 1}`, bytes: 30_000_000, sha256: 'a'.repeat(64), notes: 'Test notes', publishedAt: '2026-09-21T00:00:00Z',
  downloadUrl: `https://crm.udf-party.co.za/api/public/download/app-release/${versionCode}-${'a'.repeat(64)}` });
let controller;
function harness(build = 7) {
  const h = { value: fixture(), online: true, count: 0, urls: [], prefs: new Map(), clock: 1000, error: false, openOK: true };
  controller = new UpdateController(build, {
    fetchUpdate: async (signal) => { h.count++; if (h.fetch) return h.fetch(signal); if (h.error) throw new Error('offline/404/500'); return h.value; },
    getPreference: async (key) => h.prefs.get(key) ?? null,
    setPreference: async (key, value) => { if (h.storageError) throw new Error('storage'); h.prefs.set(key, value); },
    openUrl: async (url) => { h.urls.push(url); return h.openOK; },
    online: () => h.online, changed: () => {}, now: () => h.clock,
  });
  h.ctl = controller; return h;
}
let passed = 0, failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack}`); }
  finally { controller?.stop(); controller = undefined; timers.clear(); }
}
try {
  await test('numeric build comparison: older, equal, newer and 9 to 10', async () => {
    for (const [installed, announced, shown] of [[7,8,true],[8,8,false],[9,8,false],[9,10,true]]) {
      const h = harness(installed); h.value = fixture(announced); h.ctl.setActive(true); await flush();
      assert.equal(Boolean(h.ctl.state.available), shown); h.ctl.stop();
    }
  });
  await test('null announcement and invalid metadata never produce a prompt', async () => {
    assert.equal(parseAppUpdate(null), null);
    for (const patch of [{ packageId: 'com.udf.mail' }, { downloadUrl: 'javascript:alert(1)' }, { versionCode: '10' }, { versionCode: 1.5 }, { sha256: 'bad' }, { bytes: -1 }, { notes: 'x'.repeat(2001) }]) assert.throws(() => parseAppUpdate({ ...fixture(), ...patch }));
    const h = harness(); h.value = null; h.ctl.setActive(true); await h.ctl.check(true); assert.equal(h.ctl.state.available, null); assert.match(h.ctl.state.message, /up to date/);
  });
  await test('startup, foreground and 60-second active polling; inactive does not poll', async () => {
    const h = harness(); h.ctl.setActive(true); await flush(); assert.equal(h.count, 1);
    const poll = [...timers.values()].find(t => t.interval); assert.equal(poll.ms, 60000);
    poll.fn(); await flush(); assert.equal(h.count, 2);
    h.ctl.setActive(false); await h.ctl.check(); assert.equal(h.count, 2); assert.equal(timers.size, 0);
    h.ctl.setActive(true); await flush(); assert.equal(h.count, 3);
    h.ctl.stop(); assert.equal(timers.size, 0);
  });
  await test('simultaneous checks deduplicate and manual check joins pending auto check', async () => {
    const h = harness(); let resolve;
    h.fetch = () => new Promise(r => { resolve = r; }); h.ctl.setActive(true);
    const first = h.ctl.check(), second = h.ctl.check(true); assert.equal(first, second); assert.equal(h.count, 1);
    resolve(fixture()); await second; assert.ok(h.ctl.state.available); assert.match(h.ctl.state.message, /available/);
  });
  await test('background and unmount abort; delayed responses cannot update state', async () => {
    const h = harness(); let resolve, signal;
    h.fetch = (s) => { signal = s; return new Promise(r => { resolve = r; }); };
    h.ctl.setActive(true); h.ctl.setActive(false); assert.equal(signal.aborted, true);
    resolve(fixture()); await flush(); assert.equal(h.ctl.state.available, null);
    h.ctl.setActive(true); h.ctl.stop(); assert.equal(signal.aborted, true);
    resolve(fixture()); await flush(); assert.equal(h.ctl.state.available, null); assert.equal(timers.size, 0);
  });
  await test('offline is silent automatically, explicit manually, and recovers online', async () => {
    const h = harness(); h.online = false; h.ctl.setActive(true); await flush(); assert.equal(h.count, 0); assert.equal(h.ctl.state.message, '');
    await h.ctl.check(true); assert.match(h.ctl.state.message, /Offline/);
    h.online = true; await h.ctl.check(); assert.ok(h.ctl.state.available);
  });
  await test('server errors are silent automatically and retryable manually', async () => {
    const h = harness(); h.error = true; h.ctl.setActive(true); await flush(); assert.equal(h.ctl.state.message, '');
    await h.ctl.check(true); assert.match(h.ctl.state.message, /Unable/); assert.equal(h.ctl.state.busy, false);
    h.error = false; await h.ctl.check(true); assert.ok(h.ctl.state.available);
  });
  await test('10-second timeout aborts the network and a later check recovers', async () => {
    const h = harness(); let signal;
    h.fetch = (s) => { signal = s; return new Promise((_, reject) => s.addEventListener('abort', () => reject(new Error('aborted')))); };
    h.ctl.setActive(true); const pending = h.ctl.check(true);
    const timeout = [...timers.values()].find(t => !t.interval); assert.equal(timeout.ms, 10000); timeout.fn();
    await pending; assert.equal(signal.aborted, true); assert.equal(h.ctl.state.busy, false);
    h.fetch = null; await h.ctl.check(true); assert.ok(h.ctl.state.available);
  });
  await test('24-hour per-release deferral expires and a higher release bypasses it', async () => {
    const h = harness(); h.ctl.setActive(true); await flush(); await h.ctl.later();
    assert.equal(h.prefs.size, 1); await h.ctl.check(); assert.equal(h.ctl.state.available, null);
    h.clock += 86400000 - 1; await h.ctl.check(); assert.equal(h.ctl.state.available, null);
    h.value = fixture(9); await h.ctl.check(); assert.equal(h.ctl.state.available.versionCode, 9);
    h.value = fixture(8); h.clock++; await h.ctl.check(); assert.equal(h.ctl.state.available.versionCode, 8);
  });
  await test('manual check bypasses deferral and periodic checks do not dismiss its prompt', async () => {
    const h = harness(); h.ctl.setActive(true); await flush(); await h.ctl.later();
    await h.ctl.check(true); assert.ok(h.ctl.state.available); await h.ctl.check(); assert.ok(h.ctl.state.available);
  });
  await test('failed preferences retain in-session deferral without touching auth', async () => {
    const h = harness(); h.storageError = true; h.prefs.set('auth', 'synthetic-preserve'); h.ctl.setActive(true); await flush(); await h.ctl.later();
    await h.ctl.check(); assert.equal(h.ctl.state.available, null); assert.equal(h.prefs.get('auth'), 'synthetic-preserve');
  });
  await test('withdrawal clears stale prompt and prevents browser handoff', async () => {
    const h = harness(); h.ctl.setActive(true); await flush(); h.value = null; await h.ctl.download();
    assert.equal(h.ctl.state.available, null); assert.equal(h.urls.length, 0);
  });
  await test('changed release during download revalidation requires fresh user action', async () => {
    const h = harness(); h.ctl.setActive(true); await flush(); h.value = fixture(9); await h.ctl.download();
    assert.equal(h.urls.length, 0); assert.equal(h.ctl.state.available.versionCode, 9);
  });
  await test('double download clicks hand off once and defer only after success', async () => {
    const h = harness(); h.ctl.setActive(true); await flush();
    await Promise.all([h.ctl.download(), h.ctl.download()]); assert.equal(h.urls.length, 1);
    assert.equal(h.urls[0], fixture().downloadUrl); assert.equal(h.ctl.state.available, null); assert.equal(h.prefs.size, 1);
  });
  await test('failed handoff keeps the prompt with no deferral and supports retry', async () => {
    const h = harness(); h.openOK = false; h.ctl.setActive(true); await flush(); await h.ctl.download();
    assert.equal(h.prefs.size, 0); assert.ok(h.ctl.state.available); assert.match(h.ctl.state.message, /Could not open/);
    h.openOK = true; await h.ctl.download(); assert.equal(h.prefs.size, 1);
  });
  await test('Later during revalidation cancels browser handoff and prompt resurrection', async () => {
    const h = harness(); h.ctl.setActive(true); await flush(); let resolve;
    h.fetch = () => new Promise(r => { resolve = r; }); const download = h.ctl.download();
    await h.ctl.later(); resolve(fixture()); await download; assert.equal(h.urls.length, 0); assert.equal(h.ctl.state.available, null);
  });
  await test('map cue state covers overflow, details reached, bottom clamping and resize', async () => {
    assert.deepEqual(mapScrollState(900, 500, 0, 550), { overflow: true, atEnd: false });
    assert.deepEqual(mapScrollState(1200, 300, 550, 550), { overflow: true, atEnd: true });
    assert.deepEqual(mapScrollState(900, 500, 400, 550), { overflow: true, atEnd: true });
    assert.equal(mapScrollState(500, 900, 0, 550).overflow, false);
    assert.equal(mapScrollState(504, 500, 0, 550).overflow, false);
  });
  await test('mobile footer is outside scroll surface; desktop opt-out stays unchanged', async () => {
    const mobile = renderToStaticMarkup(React.createElement(MapScrollLayout, { enabled: true }, React.createElement('span', null, 'content')));
    const desktop = renderToStaticMarkup(React.createElement(MapScrollLayout, { enabled: false }, 'content'));
    assert.match(mobile, /<div class="udf-map"><span>content<\/span><\/div><div class="udf-map-scroll-footer">/);
    assert.match(mobile, /View data below/); assert.equal(desktop, '<div class="udf-map">content</div>');
  });
  await test('root integration excludes browser/iOS; cleanup and reduced-motion hooks are wired', async () => {
    const source = await readFile(new URL('../src/components/AppUpdateProvider.tsx', import.meta.url), 'utf8');
    assert.match(source, /!Capacitor.isNativePlatform\(\) \|\| Capacitor.getPlatform\(\) !== 'android'/);
    assert.match(source, /removeEventListener\('visibilitychange'/); assert.match(source, /removeEventListener\('online'/);
    assert.match(source, /h.remove\(\)/); assert.match(source, /credentials: 'omit'/);
    const map = await readFile(new URL('../src/components/MapScrollLayout.tsx', import.meta.url), 'utf8');
    assert.match(map, /prefers-reduced-motion: reduce/); assert.match(map, /resize.disconnect\(\); mutations.disconnect\(\)/);
  });
} finally {
  Object.assign(globalThis, originals); delete globalThis.React;
}
console.log(`Update/map regression: ${passed} passed, ${failed} failed. Native bridges/browser rendering not exercised.`);
if (failed) process.exitCode = 1;
