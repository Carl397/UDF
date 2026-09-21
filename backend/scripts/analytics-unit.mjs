import assert from 'node:assert/strict';
import { parseUserAgent } from '../src/modules/analytics/uaParser.ts';
import { visitorHash, downloadIpHash, currentDayKey } from '../src/modules/analytics/identity.ts';

/**
 * Analytics unit tests — pure, DB-free.
 *
 * Covers the two privacy-critical, non-DB surfaces of the first-party
 * analytics pipeline: the user-agent classifier and the cookieless identity
 * hashes. The daily-salt hashing IS the POPIA control (no raw IP/UA is ever
 * stored, and a visitor id cannot be stitched across days), so it is pinned
 * here directly; the aggregation/rollup math runs against Postgres and is
 * covered in workflow-regression.mjs.
 *
 *   npm run test:analytics
 */
let passed = 0;
let failed = 0;
function test(name, run) {
  try {
    run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

// ── User-agent classification ──────────────────────────────────────────────
test('parses iPhone Safari as mobile / iOS / Safari', () => {
  const r = parseUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  );
  assert.deepEqual(r, { deviceType: 'mobile', os: 'iOS', browser: 'Safari' });
});
test('parses iPad as tablet / iPadOS (tablet precedes generic mobile)', () => {
  const r = parseUserAgent(
    'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  );
  assert.equal(r.deviceType, 'tablet');
  assert.equal(r.os, 'iPadOS');
});
test('parses Android Chrome as mobile / Android / Chrome', () => {
  const r = parseUserAgent(
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  );
  assert.deepEqual(r, { deviceType: 'mobile', os: 'Android', browser: 'Chrome' });
});
test('parses Windows Chrome as desktop / Windows / Chrome', () => {
  const r = parseUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  );
  assert.deepEqual(r, { deviceType: 'desktop', os: 'Windows', browser: 'Chrome' });
});
test('prefers Edge over the embedded Chrome token', () => {
  const r = parseUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
  );
  assert.equal(r.browser, 'Edge');
  assert.equal(r.deviceType, 'desktop');
});
test('parses macOS Safari as desktop / macOS / Safari', () => {
  const r = parseUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  );
  assert.deepEqual(r, { deviceType: 'desktop', os: 'macOS', browser: 'Safari' });
});
test('buckets crawlers as bot', () => {
  assert.equal(parseUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)').deviceType, 'bot');
  assert.equal(parseUserAgent('curl/8.4.0').deviceType, 'bot');
  assert.equal(parseUserAgent('HeadlessChrome/120.0.0.0').deviceType, 'bot');
});
test('unknown and empty user agents collapse to other (no wrong guess)', () => {
  assert.equal(parseUserAgent('').deviceType, 'other');
  assert.equal(parseUserAgent(null).deviceType, 'other');
  assert.equal(parseUserAgent(undefined).deviceType, 'other');
  assert.equal(parseUserAgent('some-totally-unknown-agent/0.1').deviceType, 'other');
});

// ── Cookieless daily-salt identity (POPIA control) ─────────────────────────
test('SAST day bucket rotates at the local midnight boundary (UTC+2, DST-free)', () => {
  // 21:30 UTC = 23:30 SAST same day; 22:30 UTC = 00:30 SAST next day.
  assert.equal(currentDayKey(new Date('2026-09-19T21:30:00Z')), '2026-09-19');
  assert.equal(currentDayKey(new Date('2026-09-19T22:30:00Z')), '2026-09-20');
});
test('visitorHash is stable within a day for the same visitor+site', () => {
  const a = visitorHash({ ip: '41.1.2.3', userAgent: 'UA-X', site: 'marketing', dayKey: '2026-09-19' });
  const b = visitorHash({ ip: '41.1.2.3', userAgent: 'UA-X', site: 'marketing', dayKey: '2026-09-19' });
  assert.equal(a, b);
});
test('visitorHash rotates across days so rows cannot be stitched into a profile', () => {
  const d1 = visitorHash({ ip: '41.1.2.3', userAgent: 'UA-X', site: 'marketing', dayKey: '2026-09-19' });
  const d2 = visitorHash({ ip: '41.1.2.3', userAgent: 'UA-X', site: 'marketing', dayKey: '2026-09-20' });
  assert.notEqual(d1, d2);
});
test('visitorHash differs by site and by ip (per-site, per-visitor ids)', () => {
  const mk = visitorHash({ ip: '1.1.1.1', userAgent: 'UA', site: 'marketing', dayKey: '2026-09-19' });
  const app = visitorHash({ ip: '1.1.1.1', userAgent: 'UA', site: 'app', dayKey: '2026-09-19' });
  const otherIp = visitorHash({ ip: '2.2.2.2', userAgent: 'UA', site: 'marketing', dayKey: '2026-09-19' });
  assert.notEqual(mk, app);
  assert.notEqual(mk, otherIp);
});
test('hashes are one-way: 64 hex, never containing the raw ip or user-agent', () => {
  const ip = '196.25.31.7';
  const ua = 'Mozilla/5.0 (SECRET-DEVICE-XYZ)';
  const v = visitorHash({ ip, userAgent: ua, site: 'app', dayKey: '2026-09-19' });
  const d = downloadIpHash({ ip, dayKey: '2026-09-19' });
  assert.match(v, HEX64);
  assert.match(d, HEX64);
  for (const h of [v, d]) {
    assert.ok(!h.includes(ip), 'hash must not embed the raw ip');
    assert.ok(!h.toLowerCase().includes('secret'), 'hash must not embed the raw ua');
  }
});
test('download hash is a distinct domain from the visitor hash (cannot be joined)', () => {
  const ip = '41.1.2.3';
  const v = visitorHash({ ip, userAgent: '', site: 'app', dayKey: '2026-09-19' });
  const d = downloadIpHash({ ip, dayKey: '2026-09-19' });
  assert.notEqual(v, d, 'a download row must not be joinable to an analytics event by hash alone');
});
test('null/blank ip still yields a valid rotating hash (no crash, no leak)', () => {
  const n1 = visitorHash({ ip: null, userAgent: null, site: 'marketing', dayKey: '2026-09-19' });
  const n2 = visitorHash({ ip: null, userAgent: null, site: 'marketing', dayKey: '2026-09-20' });
  assert.match(n1, HEX64);
  assert.notEqual(n1, n2);
});

console.log(`Analytics unit tests: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
