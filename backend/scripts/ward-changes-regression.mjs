import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import express from 'express';
import { env } from '../src/config/env.ts';
import { pool } from '../src/db/pool.ts';
import { Role, permissionsForRole } from '../src/auth/permissions.ts';
import { signAccessToken, verifyAccessToken } from '../src/auth/tokens.ts';
import { authenticate } from '../src/middleware/authenticate.ts';
import { errorHandler } from '../src/middleware/errorHandler.ts';
import { membersRouter } from '../src/modules/members/routes.ts';
import { getOwnWardChanges, changeOwnWard, changeOwnWardSchema } from '../src/modules/members/wardChanges.ts';

if (env.isProduction || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.DATABASE_URL).hostname)) {
  throw new Error('Ward regression requires a local non-production database');
}
// Separate, empty copies of the real tables: concurrent transactions are real,
// but no member, user, role gate, or session in the application schema is edited.
const schema = `qa_ward_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
const testPool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 8,
  options: `-c search_path=${schema},public -c statement_timeout=10000` });
const originalQuery = pool.query;
const originalConnect = pool.connect;
let server;
let passed = 0;
let failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack}`); }
}
const rejects = (run, status) => assert.rejects(run, (e) => e.status === status);
const region = 'QA-WARD-SC';
const ward = 'QA-WARD-W1';
const nextWard = 'QA-WARD-W2';
const thirdWard = 'QA-WARD-W3';
let sequence = 0;
async function fixture({ used = 0, current = ward, role = Role.MEMBER, linked = true } = {}) {
  const sub = randomUUID();
  const memberId = randomUUID();
  await testPool.query(`INSERT INTO members(id, ward, region_code, status, ward_changes_used, tags)
    VALUES ($1,$2,$3,'active',$4,ARRAY['keep-tag',$5::text])`, [memberId, current, region, used, `ward:${current}`]);
  await testPool.query(`INSERT INTO users(id, password_hash, role, ward_code, region_codes, member_id)
    VALUES ($1,'not-a-login-hash',$2,$3,ARRAY[$4::text],$5)`, [sub, role, current, region, linked ? memberId : null]);
  return { sub, role, wardCode: current ?? undefined, regionCodes: [region], memberId,
    permissions: [...permissionsForRole(role)] };
}
const input = (wardCode = nextWard, expectedWardCode = ward) => ({ wardCode, expectedWardCode });
async function snapshot(p) {
  return (await testPool.query('SELECT ward, ward_changes_used FROM members WHERE id=$1', [p.memberId])).rows[0];
}
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const table of ['regions', 'members', 'users', 'ward_change_log', 'role_module_gates', 'refresh_tokens']) {
    await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  // LIKE does not copy foreign keys. Recreate those the feature writes so a
  // broken ward/member/user reference fails exactly as in the application.
  await testPool.query(`ALTER TABLE ward_change_log
    ADD FOREIGN KEY(member_id) REFERENCES members(id),
    ADD FOREIGN KEY(from_ward) REFERENCES regions(code),
    ADD FOREIGN KEY(to_ward) REFERENCES regions(code),
    ADD FOREIGN KEY(changed_by) REFERENCES users(id)`);
  await testPool.query(`ALTER TABLE users ADD FOREIGN KEY(member_id) REFERENCES members(id),
    ADD FOREIGN KEY(ward_code) REFERENCES regions(code)`);
  await testPool.query(`ALTER TABLE members ADD FOREIGN KEY(region_code) REFERENCES regions(code)`);
  pool.query = testPool.query.bind(testPool);
  pool.connect = testPool.connect.bind(testPool);
  await testPool.query("INSERT INTO regions(code,name,level) VALUES ($1,'QA subcouncil','subcouncil')", [region]);
  for (const code of [ward, nextWard, thirdWard]) {
    await testPool.query("INSERT INTO regions(code,name,level,parent_code) VALUES ($1,$2,'ward',$3)", [code, `QA ward ${++sequence}`, region]);
  }

  await test('canonical linked profile exposes only ward and authoritative allowance', async () => {
    const p = await fixture();
    assert.deepEqual(await getOwnWardChanges(p), { wardCode: ward, wardName: 'QA ward 1', regionCode: region,
      changesUsed: 0, changesRemaining: 3, maxChanges: 3 });
    const unrelated = await fixture();
    await testPool.query('UPDATE members SET created_by=$1, ward_changes_used=3 WHERE id=$2', [p.sub, unrelated.memberId]);
    assert.equal((await getOwnWardChanges(p)).changesRemaining, 3);
  });
  await test('three changes including changing back succeed; fourth is refused', async () => {
    const p = await fixture();
    for (const [to, from, remaining] of [[nextWard, ward, 2], [ward, nextWard, 1], [thirdWard, ward, 0]]) {
      const result = await changeOwnWard(p, input(to, from));
      assert.equal(result.changed, true);
      assert.equal(result.changesRemaining, remaining);
      assert.equal(verifyAccessToken(result.accessToken).wardCode, to);
    }
    await rejects(() => changeOwnWard(p, input(ward, thirdWard)), 409);
    assert.deepEqual(await snapshot(p), { ward: thirdWard, ward_changes_used: 3 });
    const history = (await testPool.query('SELECT * FROM ward_change_log WHERE member_id=$1 ORDER BY created_at', [p.memberId])).rows;
    assert.equal(history.length, 3);
    assert.ok(history.every((r) => r.changed_by === p.sub && r.otp_verified_at === null && r.overridden_by === null));
  });
  await test('same ward and retry of the last successful change consume nothing', async () => {
    const p = await fixture({ used: 2 });
    assert.equal((await changeOwnWard(p, input(ward, ward))).changesUsed, 2);
    await changeOwnWard(p, input());
    const retry = await changeOwnWard(p, input());
    assert.equal(retry.changed, false);
    assert.equal(retry.changesUsed, 3);
    assert.equal((await testPool.query('SELECT count(*)::int AS n FROM ward_change_log WHERE member_id=$1', [p.memberId])).rows[0].n, 1);
  });
  await test('stale screen cannot spend a second change after another update', async () => {
    const p = await fixture();
    await changeOwnWard(p, input());
    await rejects(() => changeOwnWard(p, input(thirdWard, ward)), 409);
    assert.equal((await snapshot(p)).ward_changes_used, 1);
  });
  await test('invalid, non-ward, null, and client-supplied counter/identity are rejected', async () => {
    const p = await fixture();
    for (const code of ['unknown', region]) await rejects(() => changeOwnWard(p, input(code)), 400);
    for (const value of [{ ...input(), wardCode: null }, { ...input(), changesUsed: 0 }, { ...input(), memberId: randomUUID() }, { wardCode: nextWard }]) {
      assert.equal(changeOwnWardSchema.safeParse(value).success, false);
    }
    assert.deepEqual(await snapshot(p), { ward, ward_changes_used: 0 });
  });
  await test('initial assignment is free and does not reset existing history', async () => {
    const p = await fixture({ current: null });
    assert.equal((await changeOwnWard(p, input(ward, null))).changesRemaining, 3);
    assert.equal((await changeOwnWard(p, input())).changesRemaining, 2);
    const exhausted = await fixture({ current: null, used: 3 });
    await rejects(() => changeOwnWard(exhausted, input(ward, null)), 409);
  });
  await test('counter persists across an old term date and a new session', async () => {
    const p = await fixture({ used: 3 });
    await testPool.query("UPDATE members SET term_started_at='2000-01-01' WHERE id=$1", [p.memberId]);
    const fresh = verifyAccessToken(signAccessToken(p));
    assert.equal((await getOwnWardChanges(fresh)).changesRemaining, 0);
    await rejects(() => changeOwnWard(fresh, input()), 409);
  });
  await test('historical logs cannot be erased by a lower stored counter', async () => {
    const p = await fixture();
    await testPool.query(`INSERT INTO ward_change_log(member_id,from_ward,to_ward,reason,changed_by,created_at)
      SELECT $1,$2,$3,'Fixture',$4,now()-interval '10 years' FROM generate_series(1,3)`, [p.memberId, ward, nextWard, p.sub]);
    assert.equal((await getOwnWardChanges(p)).changesRemaining, 0);
    await rejects(() => changeOwnWard(p, input()), 409);
  });
  await test('unlinked, deleted, disabled and staff accounts cannot use self-service', async () => {
    for (const role of [Role.WARD_COUNCILLOR, Role.NATIONAL_ADMIN, Role.SUPERADMIN]) {
      const p = await fixture({ role });
      await rejects(() => getOwnWardChanges(p), 403);
      await rejects(() => changeOwnWard(p, input()), 403);
    }
    const unlinked = await fixture({ linked: false });
    await rejects(() => changeOwnWard(unlinked, input()), 403);
    const deleted = await fixture();
    await testPool.query('UPDATE members SET deleted_at=now() WHERE id=$1', [deleted.memberId]);
    await rejects(() => changeOwnWard(deleted, input()), 403);
    const disabled = await fixture();
    await testPool.query('UPDATE users SET is_active=false WHERE id=$1', [disabled.sub]);
    await rejects(() => changeOwnWard(disabled, input()), 401);
    const changedRole = await fixture();
    await testPool.query("UPDATE users SET role='ward_councillor' WHERE id=$1", [changedRole.sub]);
    await rejects(() => changeOwnWard(changedRole, input()), 403);
  });
  await test('ward, region, tags and account scope move together; refresh session is retained', async () => {
    const p = await fixture();
    const refresh = randomUUID();
    await testPool.query(`INSERT INTO refresh_tokens(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')`,
      [refresh, p.sub, Buffer.from(randomUUID())]);
    await changeOwnWard(p, input());
    const row = (await testPool.query(`SELECT m.ward,m.region_code,m.district_code,m.location,m.tags,u.ward_code,u.ward_codes,u.region_codes
      FROM members m JOIN users u ON u.member_id=m.id WHERE u.id=$1`, [p.sub])).rows[0];
    assert.equal(row.ward, nextWard);
    assert.equal(row.region_code, region);
    assert.equal(row.district_code, null);
    assert.equal(row.location, null);
    assert.deepEqual(row.tags, ['keep-tag', `ward:${nextWard}`]);
    assert.deepEqual(row.ward_codes, [nextWard]);
    assert.deepEqual(row.region_codes, [region]);
    assert.equal(row.ward_code, nextWard);
    assert.equal((await testPool.query('SELECT revoked_at FROM refresh_tokens WHERE id=$1', [refresh])).rows[0].revoked_at, null);
  });
  await test('legacy noncanonical member ward can move without fabricating a boundary', async () => {
    const p = await fixture();
    await testPool.query("UPDATE members SET ward='legacy-number' WHERE id=$1", [p.memberId]);
    const result = await changeOwnWard(p, input(nextWard, 'legacy-number'));
    assert.equal(result.changesUsed, 1);
    assert.equal((await testPool.query('SELECT from_ward FROM ward_change_log WHERE member_id=$1', [p.memberId])).rows[0].from_ward, null);
  });
  await test('audit insertion failure rolls back member, counter and user scope', async () => {
    const p = await fixture();
    await testPool.query(`ALTER TABLE ward_change_log ADD CONSTRAINT reject_fixture CHECK (changed_by <> '${p.sub}'::uuid)`);
    try {
      await assert.rejects(() => changeOwnWard(p, input()));
      assert.deepEqual(await snapshot(p), { ward, ward_changes_used: 0 });
      assert.equal((await testPool.query('SELECT ward_code FROM users WHERE id=$1', [p.sub])).rows[0].ward_code, ward);
    } finally { await testPool.query('ALTER TABLE ward_change_log DROP CONSTRAINT reject_fixture'); }
  });
  await test('two genuine concurrent requests cannot exceed the last allowance', async () => {
    const p = await fixture({ used: 2 });
    const results = await Promise.allSettled([changeOwnWard(p, input()), changeOwnWard(p, input(thirdWard))]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
    assert.equal((await snapshot(p)).ward_changes_used, 3);
  });
  await test('concurrent duplicate submission spends only one allowance', async () => {
    const p = await fixture();
    const results = await Promise.all([changeOwnWard(p, input()), changeOwnWard(p, input())]);
    assert.equal(results.filter((r) => r.changed).length, 1);
    assert.equal((await snapshot(p)).ward_changes_used, 1);
  });

  const app = express();
  app.use(express.json());
  app.use('/api/members', membersRouter);
  app.get('/api/qa-scope', authenticate, (req, res) => res.json({ wardCode: req.principal.wardCode, regionCodes: req.principal.regionCodes }));
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  await test('HTTP routes require authentication, reject staff and validate strict input', async () => {
    assert.equal((await fetch(`${base}/api/members/me/ward`)).status, 401);
    const p = await fixture();
    const staff = await fixture({ role: Role.SUPERADMIN });
    for (const method of ['GET', 'PATCH']) {
      assert.equal((await fetch(`${base}/api/members/me/ward`, { method, headers: { Authorization: `Bearer ${signAccessToken(staff)}`, 'Content-Type': 'application/json' }, ...(method === 'PATCH' ? { body: JSON.stringify(input()) } : {}) })).status, 403);
    }
    const headers = { Authorization: `Bearer ${signAccessToken(p)}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base}/api/members/me/ward`, { method: 'PATCH', headers, body: JSON.stringify({ ...input(), changesUsed: 0 }) })).status, 400);
    const response = await fetch(`${base}/api/members/me/ward`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).changesRemaining, 3);
  });
  await test('old access token immediately sees only the new ward scope after HTTP change', async () => {
    const p = await fixture();
    const headers = { Authorization: `Bearer ${signAccessToken(p)}`, 'Content-Type': 'application/json' };
    const response = await fetch(`${base}/api/members/me/ward`, { method: 'PATCH', headers, body: JSON.stringify(input()) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(verifyAccessToken(result.accessToken).wardCode, nextWard);
    assert.deepEqual(await (await fetch(`${base}/api/qa-scope`, { headers })).json(), { wardCode: nextWard, regionCodes: [region] });
  });
  await test('even a member with member:write cannot bypass the cap via generic PATCH', async () => {
    const p = await fixture({ used: 3 });
    await testPool.query("UPDATE users SET permission_grants=ARRAY['member:write'] WHERE id=$1", [p.sub]);
    const response = await fetch(`${base}/api/members/${p.memberId}`, { method: 'PATCH',
      headers: { Authorization: `Bearer ${signAccessToken(p)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ward: nextWard }) });
    assert.equal(response.status, 403);
    assert.deepEqual(await snapshot(p), { ward, ward_changes_used: 3 });
  });
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await testPool.end();
  pool.query = originalQuery;
  pool.connect = originalConnect;
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
console.log(`Ward changes: ${passed} passed, ${failed} failed. Isolated fixtures removed.`);
if (failed) process.exitCode = 1;
