import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from '../src/app.ts';
import { signAccessToken } from '../src/auth/tokens.ts';
import { env } from '../src/config/env.ts';
import { pool } from '../src/db/pool.ts';
import { Permission, Role, permissionsForRole, modulesForRole, effectivePermissions, PERMISSION_MODULE, ModuleKey } from '../src/auth/permissions.ts';
import * as reports from '../src/modules/transparency/service.ts';
import * as content from '../src/modules/content/service.ts';
import { applyReportAction, reportWorkflowView } from '../src/modules/transparency/reportWorkflow.ts';
import { reportAccountability, listManagedReports, reportFilterOptions } from '../src/modules/transparency/reportManagement.ts';
import { listReportTasks, reportAssignees, saveReportTask } from '../src/modules/transparency/reportTasks.ts';
import { reportListQuerySchema, createReportTaskSchema, updateReportTaskSchema } from '../src/modules/transparency/schemas.ts';
import { parseCapturedMedia, validateMediaBatch, setMediaPolicy } from '../src/modules/transparency/mediaPolicy.ts';
import { getDashboardActivity } from '../src/modules/crm/activityStats.ts';
import { updateUser } from '../src/modules/crm/userService.ts';
import * as patrols from '../src/modules/patrols/service.ts';
import { createResidentReportSchema, updateResidentReportSchema } from '../src/modules/transparency/schemas.ts';
import { addPatrolStopSchema } from '../src/modules/patrols/schemas.ts';
import { sealRecord } from '../src/security/encryption.ts';
import { getRegionSummary } from '../src/modules/geo/service.ts';
import { regionSummarySchema } from '../src/modules/geo/schemas.ts';
import { rollupAnalyticsDay, rollupDownloadDay } from '../src/modules/analytics/service.ts';

// All service calls share one rollback-only connection. Nested service
// transactions become savepoints; no fixture or audit record is committed.
if (env.isProduction || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.DATABASE_URL).hostname)) {
  throw new Error('Workflow regression requires a local, non-production database');
}
const client = await pool.connect();
const originalQuery = pool.query;
const originalConnect = pool.connect;
let savepoint = 0;
pool.query = client.query.bind(client);
pool.connect = async () => {
  const name = `workflow_${++savepoint}`;
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
const ctx = { ip: null, userAgent: null };
async function test(name, run) {
  const point = `test_${++savepoint}`;
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
  await client.query(`RELEASE SAVEPOINT ${point}`);
}
const rejects = (run, status) => assert.rejects(run, (e) => e.status === status || e.statusCode === status);
const suffix = randomUUID().slice(0, 8);
const ward = `QA-${suffix}-W1`;
const outsideWard = `QA-${suffix}-W2`;
const region = `QA-${suffix}-SC`;
const p = (role, wardCode = ward) => ({ sub: randomUUID(), role, wardCode, regionCodes: [region], permissions: [...permissionsForRole(role)] });
const member = p(Role.MEMBER);
const councilor = p(Role.WARD_COUNCILLOR);
const peer = p(Role.WARD_COUNCILLOR);
const outside = p(Role.WARD_COUNCILLOR, outsideWard);
const admin = p(Role.NATIONAL_ADMIN, null);
const coordinator = p(Role.LOCAL_COORDINATOR);
const superadmin = p(Role.SUPERADMIN, null);
const memberId = randomUUID();
const actor = { actorId: admin.sub, actorRole: admin.role, permissions: admin.permissions };
let report;
const apply = (input, principal = councilor) => applyReportAction(report.id, updateResidentReportSchema.parse(input), principal, ctx);
const photo = { captureMode: 'photo', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC' };

try {
  await client.query('BEGIN');
  await client.query("INSERT INTO regions(code,name,level) VALUES ($1,'Regression subcouncil','subcouncil')", [region]);
  await client.query("INSERT INTO regions(code,name,level,parent_code) VALUES ($1,'Ward QA1','ward',$3),($2,'Ward QA2','ward',$3)", [ward, outsideWard, region]);
  for (const principal of [member, councilor, peer, outside, admin, coordinator, superadmin]) {
    const sealed = await sealRecord(principal.sub, { email: `${principal.sub}@example.invalid`, fullName: 'Regression Councilor' });
    await client.query('INSERT INTO users(id,password_hash,role,ward_code,region_codes,sealed_pii) VALUES ($1,$2,$3,$4,$5,$6)',
      [principal.sub, 'not-a-login-hash', principal.role, principal.wardCode, principal.regionCodes, JSON.stringify(sealed)]);
  }
  await client.query("INSERT INTO members(id,ward,status,tier) VALUES ($1,$2,'active','staff')", [memberId, ward]);
  await client.query('UPDATE users SET member_id=$2 WHERE id=$1', [councilor.sub, memberId]);
  await client.query('UPDATE media_capture_policy SET photo=true,video=true,voice=true WHERE singleton');

  const OPS_TRIO = [Permission.PLATFORM_READ, Permission.ANALYTICS_READ, Permission.CONTENT_MANAGE];
  await test('superadmin is a strict superset of national_admin and owns the ops trio', () => {
    const nat = new Set(permissionsForRole(Role.NATIONAL_ADMIN));
    const sup = new Set(permissionsForRole(Role.SUPERADMIN));
    for (const perm of nat) assert.ok(sup.has(perm), `superadmin must retain national_admin permission ${perm}`);
    for (const perm of OPS_TRIO) {
      assert.ok(sup.has(perm), `superadmin must hold ${perm}`);
      assert.ok(!nat.has(perm), `national_admin must NOT hold ${perm} (ops surface stays separate)`);
      assert.equal(PERMISSION_MODULE.get(perm), ModuleKey.SUPERADMIN, `${perm} must be owned by the superadmin module`);
    }
  });
  await test('superadmin module applies only to superadmin and its toggle strips the trio', () => {
    assert.ok(modulesForRole(Role.SUPERADMIN).includes(ModuleKey.SUPERADMIN));
    assert.ok(!modulesForRole(Role.NATIONAL_ADMIN).includes(ModuleKey.SUPERADMIN));
    for (const perm of OPS_TRIO) assert.ok(new Set(effectivePermissions(Role.SUPERADMIN)).has(perm));
    const disabled = new Set(effectivePermissions(Role.SUPERADMIN, null, null, [ModuleKey.SUPERADMIN]));
    for (const perm of OPS_TRIO) assert.ok(!disabled.has(perm), `disabling the superadmin module must strip ${perm}`);
    assert.ok(disabled.has(Permission.MEMBER_READ), 'a disabled ops module must not strip unrelated permissions');
  });

  // ── CMS: South-Africa report gate + pages/blocks model ───────────────────
  await test('resident-report schema rejects out-of-country points but keeps the lat/lng pair rule', () => {
    // Rio de Janeiro is a valid coordinate but outside South Africa.
    assert.throws(() => createResidentReportSchema.parse(
      { category: 'pothole', message: 'rio', lat: -22.9068, lng: -43.1729 }), /South Africa/);
    // A Cape Town point passes the bounds gate.
    assert.doesNotThrow(() => createResidentReportSchema.parse(
      { category: 'pothole', message: 'cpt', lat: -33.9249, lng: 18.4241 }));
    // No coordinates at all is still allowed (ward falls back to the profile).
    assert.doesNotThrow(() => createResidentReportSchema.parse(
      { category: 'pothole', message: 'no geo' }));
    // The pre-existing both-or-neither lat/lng rule is untouched.
    assert.throws(() => createResidentReportSchema.parse(
      { category: 'pothole', message: 'half geo', lat: -33.9 }), /latitude and longitude/i);
  });

  await test('CMS block create/publish carries kind and only publishes on demand', async () => {
    const key = `qa.${suffix}.slider`;
    const created = await content.createBlock({ key, site: 'app', title: 'QA slider', kind: 'slider', schema: {} }, superadmin);
    assert.equal(created.kind, 'slider', 'new block must round-trip its kind');
    assert.equal(created.version, 0, 'a fresh block starts unpublished at v0');
    assert.equal(created.published, null, 'a fresh block has no published payload');
    // Draft edits are invisible publicly until published.
    await content.saveDraft(key, { slides: [{ imageMediaId: '', title: 'A', text: 'a', durationSeconds: 5 }] }, superadmin);
    assert.equal((await content.getBlock(key)).published, null, 'saving a draft must not publish');
    const published = await content.publishBlock(key, superadmin);
    assert.equal(published.version, 1, 'publishing bumps to v1');
    assert.ok(published.published?.slides?.[0]?.title === 'A', 'published payload mirrors the draft');
  });

  await test('CMS page CRUD orders blocks, publishes only live sections, and rolls back', async () => {
    const slug = `qa-${suffix}`;
    const b1 = `qa.${suffix}.one`;
    const b2 = `qa.${suffix}.two`;
    await content.createBlock({ key: b1, site: 'marketing', title: 'One', kind: 'fields', schema: { heading: { label: 'H', type: 'text' } } }, superadmin);
    await content.createBlock({ key: b2, site: 'marketing', title: 'Two', kind: 'fields', schema: { heading: { label: 'H', type: 'text' } } }, superadmin);
    await content.saveDraft(b1, { heading: 'Hello' }, superadmin);
    await content.publishBlock(b1, superadmin);
    // b2 stays DRAFT-only — it must never surface on a published page.
    await content.saveDraft(b2, { heading: 'Secret draft' }, superadmin);

    const page = await content.createPage({ slug, site: 'marketing', title: 'QA page' }, superadmin);
    assert.equal(page.version, 0, 'a fresh page starts at v0');
    assert.equal(await content.getPublishedPage(slug), null, 'an unpublished page is not publicly readable');

    await content.updatePageSections(slug, [{ blockKey: b1 }, { blockKey: b2 }], superadmin);
    // The same block can never be referenced twice by one page.
    await rejects(() => content.updatePageSections(slug, [{ blockKey: b1 }, { blockKey: b1 }], superadmin), 400);
    assert.deepEqual((await content.getPage(slug)).sections.map((s) => s.blockKey), [b1, b2], 'a rejected section write must not persist');
    // A block referenced by a page cannot be deleted.
    await rejects(() => content.deleteBlock(b1, superadmin), 409);
    await content.publishPage(slug, superadmin);

    const view = await content.getPublishedPage(slug);
    assert.ok(view, 'published page is publicly readable');
    assert.equal(view.title, 'QA page');
    assert.deepEqual(view.sections.map((s) => s.key), [b1], 'only published blocks appear, in order');
    assert.equal(view.sections[0].data.heading, 'Hello');

    // Reorder to just b2 (still draft) then publish v2 and roll back to v1.
    await content.updatePageSections(slug, [{ blockKey: b2 }], superadmin);
    await content.publishPage(slug, superadmin);
    const rolled = await content.rollbackPage(slug, 1, superadmin);
    assert.equal(rolled.version, 3, 'rollback republishes v1 as a new version (v3)');
    assert.deepEqual(rolled.publishedSections.map((s) => s.blockKey), [b1, b2], 'rolled-back layout matches v1');
  });
  await test('query booleans parse "false" as false (CRM past-event + unread lists)', async () => {
    const { boolQuery } = await import('../src/http/query.ts');
    // z.coerce.boolean would read the string "false" as TRUE and trap the
    // events CRM in an upcoming-only list and alerts in an unread-only list.
    assert.equal(boolQuery(true).parse('false'), false);
    assert.equal(boolQuery(true).parse('true'), true);
    assert.equal(boolQuery(true).parse(undefined), true);
    assert.equal(boolQuery(false).parse('1'), true);
  });
  await test('analytics rollup aggregates one SAST day and is idempotent', async () => {
    const day = '2020-01-02';
    // 12:00 SAST (== 10:00Z) falls inside the day; three pageviews from two
    // visitors across two sessions, plus one non-pageview duration row that must
    // be excluded from the pageview count but added to the duration sum.
    await client.query(
      `INSERT INTO analytics_events (ts, site, event_type, path, visitor_hash, session_id, duration_ms)
       VALUES
         ('2020-01-02T10:00:00Z','app','pageview','/a','hashA','sessA',NULL),
         ('2020-01-02T10:00:00Z','app','pageview','/b','hashA','sessA',NULL),
         ('2020-01-02T10:00:00Z','app','pageview','/a','hashB','sessB',NULL),
         ('2020-01-02T10:00:00Z','app','duration','/a','hashB','sessB',5000)`,
    );
    // A pageview at 23:30 SAST of the PRIOR day must land on 2020-01-01, not here.
    await client.query(
      `INSERT INTO analytics_events (ts, site, event_type, path, visitor_hash, session_id)
       VALUES ('2020-01-01T21:30:00Z','app','pageview','/late','hashC','sessC')`,
    );
    await rollupAnalyticsDay(day);
    const total = (await client.query(
      `SELECT pageviews, visitors, sessions, duration_ms_sum FROM analytics_daily
        WHERE day=$1 AND site='app' AND metric='total' AND key='all'`,
      [day],
    )).rows[0];
    assert.equal(Number(total.pageviews), 3, 'duration event must not count as a pageview');
    assert.equal(Number(total.visitors), 2);
    assert.equal(Number(total.sessions), 2);
    assert.equal(Number(total.duration_ms_sum), 5000);
    // Recompute must overwrite, never duplicate or double-count.
    await rollupAnalyticsDay(day);
    const again = (await client.query(
      `SELECT count(*)::int AS n, max(pageviews)::int AS pv FROM analytics_daily
        WHERE day=$1 AND site='app' AND metric='total' AND key='all'`,
      [day],
    )).rows[0];
    assert.equal(again.n, 1, 'rollup must be idempotent (single row per key)');
    assert.equal(again.pv, 3, 'rollup must not accumulate on recompute');
  });
  await test('download rollup counts a SAST day once and is idempotent', async () => {
    const day = '2020-03-04';
    await client.query(
      `INSERT INTO app_downloads (ts, artifact, os, device_type, browser) VALUES
       ('2020-03-04T10:00:00Z','apk','Android','mobile','Chrome'),
       ('2020-03-04T11:00:00Z','apk','Android','mobile','Chrome'),
       ('2020-03-04T09:00:00Z','apk','iOS','mobile','Safari')`,
    );
    await client.query(
      `INSERT INTO app_downloads (ts, artifact, os, device_type, browser)
       VALUES ('2020-03-03T20:00:00Z','apk','Windows','desktop','Edge')`,
    );
    await rollupDownloadDay(day);
    const total = (await client.query(
      `SELECT downloads::int AS n FROM download_daily
        WHERE day=$1 AND artifact='apk' AND metric='total' AND key='all'`,
      [day],
    )).rows[0];
    assert.equal(total.n, 3, 'only the target SAST day counts');
    await rollupDownloadDay(day);
    const again = (await client.query(
      `SELECT count(*)::int AS rows, max(downloads)::int AS n FROM download_daily
        WHERE day=$1 AND artifact='apk' AND metric='total' AND key='all'`,
      [day],
    )).rows[0];
    assert.equal(again.rows, 1);
    assert.equal(again.n, 3);
  });

  await test('report create retries are idempotent', async () => {
    const input = createResidentReportSchema.parse({ category: 'Other', message: 'Regression report', requestId: randomUUID() });
    report = await reports.createResidentReport(input, member, ctx);
    assert.equal((await reports.createResidentReport(input, member, ctx)).id, report.id);
    assert.equal(report.wardCode, ward);
    assert.equal(report.routed, true);
    // Make assignment deterministic even if peer users share creation timestamps.
    await client.query('UPDATE resident_reports SET councillor_user_id=$2 WHERE id=$1', [report.id, councilor.sub]);
  });
  await test('unrelated member and out-of-ward staff cannot open report', async () => {
    await rejects(() => reports.getResidentReport(report.id, outside), 403);
    await rejects(() => reports.getResidentReport(report.id, p(Role.MEMBER)), 403);
  });
  await test('resolution requires acknowledgment', () => rejects(() => apply({ action: 'resolve', feedback: 'Done' }), 409));
  await test('acknowledgment is versioned and retry-safe', async () => {
    const input = { action: 'acknowledge', expectedVersion: 0, requestId: randomUUID() };
    await apply(input);
    await apply(input);
    assert.equal((await reportWorkflowView(report.id, councilor)).version, 1);
    await rejects(() => apply({ feedback: 'Stale', expectedVersion: 0 }), 409);
  });
  await test('contact requires method, target and outcome', async () => {
    await rejects(() => apply({ action: 'contact', feedback: 'Called' }), 400);
    await rejects(() => apply({ action: 'contact', contactMethod: 'other', contactTarget: 'Office', feedback: 'Called' }), 400);
    await apply({ action: 'contact', contactMethod: 'phone', contactTarget: 'Service office', feedback: 'Call logged', internalNote: 'Private staff note', externalReference: 'REF-PRIVATE-12345' });
  });
  await test('reference encrypted at rest and masked for unassigned peer', async () => {
    const row = (await client.query('SELECT sealed_reference FROM resident_reports WHERE id=$1', [report.id])).rows[0];
    assert.ok(!JSON.stringify(row.sealed_reference).includes('REF-PRIVATE-12345'));
    assert.equal((await reportWorkflowView(report.id, councilor)).externalReference, 'REF-PRIVATE-12345');
    assert.equal((await reportWorkflowView(report.id, member)).externalReference, 'REF-PRIVATE-12345');
    assert.notEqual((await reportWorkflowView(report.id, peer)).externalReference, 'REF-PRIVATE-12345');
    await rejects(() => apply({ externalReference: 'REPLACEMENT' }, peer), 403);
  });
  await test('member history excludes staff-only notes and contact targets', async () => {
    const view = await reportWorkflowView(report.id, member);
    assert.ok(view.events.every((e) => !e.internalNote && !e.contactTarget));
    await apply({ internalNote: 'Hidden standalone note' });
    assert.ok(!(await reportWorkflowView(report.id, member)).events.some((e) => e.action === 'internal_note'));
  });
  await test('follow-up validates future deadline', async () => {
    await rejects(() => apply({ action: 'follow_up', feedback: 'Waiting' }), 400);
    await rejects(() => apply({ action: 'follow_up', feedback: 'Waiting', followUpAt: '2020-01-01T00:00:00Z' }), 400);
    await apply({ action: 'follow_up', feedback: 'Waiting', followUpAt: new Date(Date.now() + 86400000).toISOString() });
  });
  await test('member confirmation and reopening preserve lifecycle', async () => {
    await apply({ action: 'resolve', feedback: 'Work completed' });
    await rejects(() => apply({ action: 'confirm' }, councilor), 403);
    await apply({ action: 'confirm' }, member);
    assert.ok((await reportWorkflowView(report.id, member)).confirmedAt);
    await apply({ action: 'request_follow_up', feedback: 'Still broken' }, member);
    const view = await reports.getResidentReport(report.id, member);
    assert.equal(view.status, 'in_progress');
    assert.equal(view.confirmedAt, null);
    assert.equal(view.resolvedAt, null);
  });
  await test('member actions reject staff fields and revoked writes', async () => {
    await rejects(() => apply({ action: 'request_follow_up', feedback: 'Check', internalNote: 'Not allowed' }, member), 400);
    await rejects(() => apply({ feedback: 'Not allowed' }, { ...councilor, permissions: [] }), 403);
  });
  await test('media parsing enforces format, base64, mode and size', async () => {
    assert.equal(parseCapturedMedia(photo.dataUrl, 'photo').kind, 'photo');
    assert.equal(parseCapturedMedia('data:audio/webm;codecs=opus;base64,AQID', 'voice_note').kind, 'voice');
    for (const [data, mode] of [['data:image/svg+xml;base64,AQID', 'photo'], [photo.dataUrl, 'video'], ['data:image/png;base64,A', 'photo'], ['x'.repeat(8 * 1024 * 1024 + 1), 'photo']]) {
      assert.throws(() => parseCapturedMedia(data, mode));
    }
    await rejects(() => validateMediaBatch(Array.from({ length: 3 }, () => ({ captureMode: 'photo', dataUrl: 'x'.repeat(8 * 1024 * 1024) }))), 400);
  });
  await test('disabled capture rejects attachments without creating a report', async () => {
    await setMediaPolicy({ photo: false, video: true, voice: true }, admin);
    const before = (await reports.listResidentReports(member)).total;
    await rejects(() => reports.createResidentReport(createResidentReportSchema.parse({ category: 'Other', message: 'Blocked photo', media: [photo] }), member, ctx), 403);
    assert.equal((await reports.listResidentReports(member)).total, before);
    await validateMediaBatch([]);
    await setMediaPolicy({ photo: true, video: true, voice: true }, admin);
    await rejects(() => setMediaPolicy({ photo: false, video: false, voice: false }, councilor), 403);
  });
  await test('dashboard totals exceed pagination and sum correctly', async () => {
    await client.query("INSERT INTO resident_reports(ref_no,user_id,ward_code,category,message) SELECT $1 || n,$2,$3,'Other','Aggregate fixture' FROM generate_series(1,205) n", [suffix, member.sub, ward]);
    const list = await reports.listResidentReports(councilor, { scope: 'inbox', limit: 1 });
    const { modules } = await getDashboardActivity(councilor);
    assert.equal(list.items.length, 1);
    assert.equal(modules.reports.total, list.total);
    assert.equal(modules.reports.total, modules.reports.byStatus.reduce((n, r) => n + r.value, 0));
    assert.equal(modules.reports.dailyCreated.length, 30);
    assert.equal((await getDashboardActivity({ ...councilor, permissions: [] })).modules.reports, null);
    assert.equal((await getDashboardActivity(outside)).modules.reports.total, 0);
  });
  await test('inactive councilor counts as unassigned', async () => {
    const before = (await getDashboardActivity(councilor)).modules.reports.unassigned;
    await client.query('UPDATE users SET is_active=false WHERE id=$1', [councilor.sub]);
    assert.equal((await reportWorkflowView(report.id, member)).assigned, false);
    const after = (await getDashboardActivity(councilor)).modules.reports.unassigned;
    await client.query('UPDATE users SET is_active=true WHERE id=$1', [councilor.sub]);
    assert.equal(after, before + 1);
  });
  await test('managed public profile retains linked member identity', async () => {
    await updateUser(councilor.sub, { bio: 'Regression biography' }, actor);
    const profile = await reports.councillorForWard(ward);
    assert.equal(profile.memberId, memberId);
    assert.equal(profile.bio, 'Regression biography');
    const summary = await getRegionSummary(regionSummarySchema.parse({ code: region }), { regions: [] });
    assert.equal(summary.children.find((r) => r.code === ward).councillor.memberId, memberId);
  });
  await test('ward moves retire old profile and publish the new ward', async () => {
    await updateUser(councilor.sub, { wardCode: outsideWard }, actor);
    assert.equal(await reports.councillorForWard(ward), null);
    assert.equal((await reports.councillorForWard(outsideWard)).bio, 'Regression biography');
    await updateUser(councilor.sub, { isActive: false }, actor);
    assert.equal(await reports.councillorForWard(outsideWard), null);
    await updateUser(councilor.sub, { isActive: true, wardCode: ward }, actor);
  });
  await test('patrol track retry, completion and stop follow-up', async () => {
    const patrol = await patrols.createPatrol({ mode: 'walk', wardCode: ward }, councilor, ctx);
    const point = { seq: 0, latitude: -34, longitude: 18.6, accuracyM: 5, recordedAt: new Date() };
    const first = await patrols.addTrackPoint(patrol.id, point, councilor);
    assert.equal((await patrols.addTrackPoint(patrol.id, point, councilor)).id, first.id);
    await rejects(() => patrols.addTrackPoint(patrol.id, { ...point, longitude: 18.7 }, councilor), 409);
    await patrols.addTrackPoint(patrol.id, { ...point, seq: 1, longitude: 18.6001, recordedAt: new Date(point.recordedAt.getTime() + 4000) }, councilor);
    assert.equal((await patrols.getPatrol(patrol.id, councilor)).nextTrackSeq, 2);
    const stopInput = addPatrolStopSchema.parse({ latitude: -34, longitude: 18.6, arrivedAt: new Date(), requestId: randomUUID(), title: 'Service visit' });
    const stop = await patrols.addStop(patrol.id, stopInput, councilor, ctx);
    assert.equal((await patrols.addStop(patrol.id, stopInput, councilor, ctx)).id, stop.id);
    await rejects(() => patrols.endPatrol(patrol.id, {}, outside, ctx), 403);
    const finish = { requestId: randomUUID(), summary: 'Walk completed' };
    const done = await patrols.endPatrol(patrol.id, finish, councilor, ctx);
    assert.equal(done.distanceSource, 'gps');
    assert.ok(done.distanceM > 0 && done.distanceM < 20);
    assert.equal((await patrols.endPatrol(patrol.id, finish, councilor, ctx)).id, patrol.id);
    await rejects(() => patrols.addTrackPoint(patrol.id, { ...point, seq: 2 }, councilor), 409);
    await rejects(() => patrols.updatePatrol(patrol.id, { status: 'active' }, councilor, ctx), 409);
    await rejects(() => patrols.updatePatrolStop(patrol.id, stop.id, { callStatus: 'completed' }, councilor, ctx), 400);
    const updated = await patrols.updatePatrolStop(patrol.id, stop.id, { callStatus: 'completed', note: 'Resolved on visit' }, councilor, ctx);
    assert.ok(updated.completedAt);
    assert.equal(updated.followUpAt, null);
    const stillCompleted = await patrols.updatePatrolStop(patrol.id, stop.id, { followUpAt: new Date(Date.now() + 86400000).toISOString() }, councilor, ctx);
    assert.equal(stillCompleted.followUpAt, null);
    const reopened = await patrols.updatePatrolStop(patrol.id, stop.id, { callStatus: 'in_progress', followUpAt: new Date(Date.now() + 86400000).toISOString() }, councilor, ctx);
    assert.ok(reopened.followUpAt);
    assert.equal(reopened.completedAt, null);
  });
  await test('patrol with no GPS retains unknown distance; manual zero is real', async () => {
    const first = await patrols.createPatrol({ mode: 'walk', wardCode: ward }, councilor, ctx);
    assert.equal((await patrols.endPatrol(first.id, {}, councilor, ctx)).distanceM, null);
    const second = await patrols.createPatrol({ mode: 'walk', wardCode: ward }, councilor, ctx);
    const zero = await patrols.endPatrol(second.id, { distanceM: 0 }, councilor, ctx);
    assert.equal(zero.distanceM, 0);
    assert.equal(zero.distanceSource, 'manual');
  });
  await test('planned patrol transitions and CRM completion measure saved GPS', async () => {
    const planned = await patrols.createPatrol({ mode: 'walk', wardCode: ward, plannedDate: new Date() }, councilor, ctx);
    assert.equal(planned.status, 'planned');
    assert.equal(planned.startedAt, null);
    await rejects(() => patrols.updatePatrol(planned.id, { status: 'completed' }, councilor, ctx), 409);
    await patrols.updatePatrol(planned.id, { status: 'active' }, councilor, ctx);
    const point = { latitude: -34, longitude: 18.6, accuracyM: 5, recordedAt: new Date(), seq: 0 };
    await patrols.addTrackPoint(planned.id, point, councilor);
    await patrols.addTrackPoint(planned.id, { ...point, seq: 1, longitude: 18.6001, recordedAt: new Date(point.recordedAt.getTime() + 4000) }, councilor);
    const done = await patrols.updatePatrol(planned.id, { status: 'completed' }, councilor, ctx);
    assert.ok(done.distanceM > 0);
    assert.equal(done.distanceSource, 'gps');
  });
  await test('patrol aggregates span pages and preserve visibility and null distances', async () => {
    await client.query("INSERT INTO patrols(ward_code,mode,status,purpose) SELECT $1,'walk','active','Pagination fixture ' || n FROM generate_series(1,205) n", [ward]);
    const list = await patrols.listPatrols(councilor, { limit: 1, offset: 0 });
    const { modules } = await getDashboardActivity(councilor, 'patrols');
    assert.equal(modules.patrols.total, list.total);
    assert.ok(list.total > 200);
    assert.equal(modules.patrols.unknownDistance30d, 1);
    assert.ok(modules.patrols.distanceM30d > 0);
    assert.equal((await getDashboardActivity(outside, 'patrols')).modules.patrols.total, 0);
    await client.query("UPDATE patrols SET visibility='private' WHERE ward_code=$1", [ward]);
    assert.equal((await getDashboardActivity({ ...member, permissions: [Permission.PATROL_READ] }, 'patrols')).modules.patrols.total, 0);
    await client.query("UPDATE patrols SET visibility='members' WHERE ward_code=$1", [ward]);
  });
  await test('patrol track resolves the GPS ward and persists a crossing into a neighbour', async () => {
    // Give the two QA wards real geometry far from any seeded ward (the Karoo),
    // so ST_Intersects cannot match a Cape Town polygon and skew the LIMIT 1.
    await client.query(`UPDATE regions SET geom=ST_SetSRID(ST_MakeEnvelope(22.9,-31.1,23.1,-30.9,4326),4326) WHERE code=$1`, [ward]);
    await client.query(`UPDATE regions SET geom=ST_SetSRID(ST_MakeEnvelope(23.2,-31.1,23.4,-30.9,4326),4326) WHERE code=$1`, [outsideWard]);
    const patrol = await patrols.createPatrol({ mode: 'walk', wardCode: ward }, councilor, ctx);
    const t0 = Date.now();
    const home = await patrols.addTrackPoint(patrol.id, { seq: 0, latitude: -31.0, longitude: 23.0, accuracyM: 5, recordedAt: new Date(t0) }, councilor);
    assert.equal(home.wardCode, ward, 'a fix inside the home ward echoes that ward');
    const away = await patrols.addTrackPoint(patrol.id, { seq: 1, latitude: -31.0, longitude: 23.3, accuracyM: 5, recordedAt: new Date(t0 + 5000) }, councilor);
    assert.equal(away.wardCode, outsideWard, 'a fix that moved over echoes the neighbouring ward');
    const entries = Object.fromEntries(((await patrols.getPatrol(patrol.id, councilor)).wardEntries ?? []).map((e) => [e.wardCode, e]));
    assert.ok(entries[ward] && entries[ward].crossing === false, 'own ward is recorded and not a crossing');
    assert.ok(entries[outsideWard] && entries[outsideWard].crossing === true, 'the neighbour is recorded as a crossing');
    assert.equal(entries[outsideWard].pointCount, 1);
    // A repeat fix in the neighbour aggregates into the same row (no duplicate).
    await patrols.addTrackPoint(patrol.id, { seq: 2, latitude: -31.0, longitude: 23.3, accuracyM: 5, recordedAt: new Date(t0 + 10000) }, councilor);
    const aggregated = ((await patrols.getPatrol(patrol.id, councilor)).wardEntries ?? []).find((e) => e.wardCode === outsideWard);
    assert.equal(aggregated?.pointCount, 2, 'repeat fixes aggregate into one ward row');
    // A fix outside every mapped ward records nothing but still saves the point.
    const nowhere = await patrols.addTrackPoint(patrol.id, { seq: 3, latitude: -30.0, longitude: 25.0, accuracyM: 5, recordedAt: new Date(t0 + 15000) }, councilor);
    assert.equal(nowhere.wardCode, null, 'an unmapped fix returns no ward');
    assert.equal((await patrols.getPatrol(patrol.id, councilor)).trackPointCount, 4, 'the unmapped point is still stored');
  });
  await test('report attachments enforce module permissions, ownership and territory', async () => {
    const mediaId = randomUUID();
    const storageKey = relative(process.cwd(), fileURLToPath(new URL('../../frontend/public/favicon.ico', import.meta.url)));
    await client.query('INSERT INTO media_assets(id,storage_key,content_type,hash,created_by) VALUES ($1,$2,$3,$4,$5)', [mediaId, storageKey, 'image/x-icon', '0'.repeat(64), member.sub]);
    await client.query('INSERT INTO resident_report_media(report_id,media_asset_id) VALUES ($1,$2)', [report.id, mediaId]);
    assert.ok((await reports.loadMediaForPrincipal(mediaId, member)).buffer.length);
    assert.ok((await reports.loadMediaForPrincipal(mediaId, councilor)).buffer.length);
    await rejects(() => reports.loadMediaForPrincipal(mediaId, outside), 403);
    await rejects(() => reports.loadMediaForPrincipal(mediaId, { ...member, permissions: [] }), 403);
    await rejects(() => reports.loadMediaForPrincipal(mediaId, { ...councilor, permissions: [] }), 403);
  });
  const managementTag = `Management-${suffix}`;
  let managedId;
  let taskId;
  const future = () => new Date(Date.now() + 86400000).toISOString();
  const taskCreate = (overrides = {}) => createReportTaskSchema.parse({ title: 'Inspect reported issue', dueAt: future(), requestId: randomUUID(), ...overrides });
  const taskUpdate = (overrides = {}) => updateReportTaskSchema.parse({ expectedVersion: 0, requestId: randomUUID(), ...overrides });
  await test('management pagination handles 0, 15, 16, and 31 rows with full-result counts', async () => {
    const filter = { search: managementTag, limit: 15 };
    assert.equal((await listManagedReports(councilor, filter)).total, 0);
    for (const [additional, total] of [[15,15],[1,16],[15,31]]) {
      await client.query(`INSERT INTO resident_reports(ref_no,user_id,ward_code,category,message,councillor_user_id)
        SELECT $1 || '-' || gen_random_uuid(),$2,$3,'Other',$1,$4 FROM generate_series(1,$5)`, [managementTag, member.sub, ward, councilor.sub, additional]);
      const first = await listManagedReports(councilor, filter);
      assert.equal(first.items.length, 15); assert.equal(first.total, total); assert.equal(first.stats.noAction, total);
      const rest = await listManagedReports(councilor, { ...filter, offset: 15 });
      assert.equal(rest.items.length, Math.min(15,total - 15));
      assert.ok(rest.items.every((r) => !first.items.some((a) => a.id === r.id)));
      assert.deepEqual((await listManagedReports(councilor, filter)).items.map((r) => r.id), first.items.map((r) => r.id));
      managedId = first.items[0].id;
    }
    const empty = await listManagedReports(councilor, { ...filter, offset: 999 });
    assert.equal(empty.total,31); assert.equal(empty.items.length,0); assert.equal(empty.stats.open,31);
    assert.equal((await listManagedReports(outside, filter)).total,0);
  });
  await test('management validation rejects invalid filters and sorts', async () => {
    for (const query of [{ limit: 0 },{ offset: -1 },{ sort: 'created_at; DROP' },{ councillor: 'invalid' },{ from: future(), to: '2020-01-01T00:00:00Z' }]) {
      assert.equal(reportListQuerySchema.safeParse(query).success, false);
    }
    await rejects(() => listManagedReports(member),403);
    await rejects(() => listManagedReports({ ...councilor, permissions: [] }),403);
  });
  await test('C3 assessment separates legacy references from C3 and records no plaintext number', async () => {
    const action = (input, p = councilor) => applyReportAction(managedId, updateResidentReportSchema.parse(input), p, ctx);
    await action({ externalReference: 'GENERIC-1234' });
    assert.equal((await reports.getResidentReport(managedId, councilor)).c3Requirement,'needs_assessment');
    await action({ c3Requirement: 'required' });
    assert.equal((await listManagedReports(councilor, { search: managementTag, c3: 'missing' })).total,1);
    await rejects(() => action({ c3Requirement: 'not_required' }),400);
    await rejects(() => action({ referenceKind: 'c3' },peer),403);
    await action({ referenceKind: 'c3', externalReference: 'C3-PRIVATE-7654321' });
    const view = await reports.getResidentReport(managedId,councilor);
    assert.equal(view.hasC3,true); assert.equal(view.referenceKind,'c3');
    const events = (await client.query('SELECT * FROM resident_report_events WHERE report_id=$1',[managedId])).rows;
    assert.ok(!JSON.stringify(events).includes('C3-PRIVATE-7654321'));
    const list = await listManagedReports(councilor, { search: managementTag, c3: 'recorded' });
    assert.equal(list.total,1); assert.ok(!JSON.stringify(list).includes('C3-PRIVATE-7654321'));
    await action({ c3Requirement: 'not_required', c3Reason: 'Community information only' });
    assert.equal((await listManagedReports(councilor,{ search:managementTag,c3:'not_required' })).total,1);
    await rejects(() => action({ action:'request_follow_up', feedback:'Check again', c3Requirement:'required' },member),400);
  });
  await test('acknowledgment is distinct from action and metadata edits', async () => {
    await applyReportAction(managedId,{ action:'acknowledge', requestId:randomUUID() },admin,ctx);
    const r = await reports.getResidentReport(managedId,councilor);
    assert.equal(r.acknowledgment,'yes'); assert.equal(r.acknowledgedBy,admin.sub);
    assert.equal(r.councillorAcknowledged,false); assert.equal(r.lastActionAt,null);
    const filtered = await listManagedReports(councilor, { search:managementTag,ward,category:'Other',acknowledged:'yes',actionTaken:'no' });
    assert.equal(filtered.total,1);
    await client.query("UPDATE resident_reports SET status='closed' WHERE message=$1 AND id<>$2",[managementTag,managedId]);
    assert.equal((await listManagedReports(councilor,{ search:managementTag,acknowledged:'unknown' })).total,30);
  });
  await test('detail preserves acknowledgment evidence and inactive assignment metadata', async () => {
    await client.query('UPDATE resident_reports SET acknowledged_at=NULL WHERE id=$1',[managedId]);
    const detail = await reports.getResidentReport(managedId,admin);
    assert.ok(detail.acknowledgedAt); assert.equal(detail.acknowledgment,'yes');
    await client.query("UPDATE users SET moderation_status='suspended' WHERE id=$1",[councilor.sub]);
    const inactive = await reports.getResidentReport(managedId,admin);
    assert.equal(inactive.assigned,false); assert.equal(inactive.assignmentState,'inactive');
    await client.query("UPDATE users SET moderation_status='active' WHERE id=$1",[councilor.sub]);
  });
  await test('C3 reasons can be cleared except when assessment requires one', async () => {
    await rejects(() => applyReportAction(managedId,{c3Reason:null},councilor,ctx),400);
    await applyReportAction(managedId,{c3Requirement:'required',c3Reason:null},councilor,ctx);
    assert.equal((await reports.getResidentReport(managedId,councilor)).c3Reason,null);
    await applyReportAction(managedId,{c3Requirement:'not_required',c3Reason:'Community information only'},councilor,ctx);
  });
  await test('tasks enforce actor-bound creation retries and parent authorization', async () => {
    const input = taskCreate({ instructions:'Staff-only inspection instructions', assigneeId:councilor.sub });
    const task = await saveReportTask(managedId,null,input,councilor); taskId=task.id;
    assert.equal((await saveReportTask(managedId,null,input,councilor)).id,taskId);
    await rejects(() => saveReportTask(managedId,null,input,admin),409);
    await rejects(() => saveReportTask(managedId,null,taskCreate(),member),403);
    await rejects(() => saveReportTask(managedId,null,taskCreate(),outside),403);
    assert.equal((await listReportTasks(councilor,{reportId:managedId})).total,1);
    assert.equal((await listReportTasks(outside)).total,0);
    await rejects(() => listReportTasks(member),403);
    await rejects(() => listReportTasks(outside,{reportId:managedId}),403);
    await rejects(() => saveReportTask(report.id,taskId,taskUpdate({title:'Wrong parent'}),councilor),404);
  });
  await test('assignees exclude out-of-ward, revoked, disabled, and inactive staff', async () => {
    let people = (await reportAssignees(managedId,councilor)).items;
    assert.ok(people.some((p)=>p.id===councilor.sub)); assert.ok(!people.some((p)=>p.id===outside.sub || p.id===member.sub));
    assert.ok(people.every((p)=>!('email' in p) && !('sealed_pii' in p)));
    await rejects(() => saveReportTask(managedId,null,taskCreate({assigneeId:outside.sub}),councilor),400);
    await client.query('UPDATE users SET permission_revokes=$2 WHERE id=$1',[peer.sub,[Permission.REPORT_WRITE]]);
    await rejects(() => saveReportTask(managedId,null,taskCreate({assigneeId:peer.sub}),councilor),400);
    await client.query('UPDATE users SET permission_revokes=$2,is_active=false WHERE id=$1',[peer.sub,[]]);
    await rejects(() => saveReportTask(managedId,null,taskCreate({assigneeId:peer.sub}),councilor),400);
    await client.query('UPDATE users SET is_active=true WHERE id=$1',[peer.sub]);
    await client.query("UPDATE role_module_gates SET enabled=false WHERE role='ward_councillor' AND module_key='reports'");
    await rejects(() => saveReportTask(managedId,null,taskCreate({assigneeId:peer.sub}),admin),400);
    await client.query("UPDATE role_module_gates SET enabled=true WHERE role='ward_councillor' AND module_key='reports'");
  });
  await test('tasks reject stale edits, require outcomes, and never auto-transition reports', async () => {
    const input=taskUpdate({status:'in_progress'});
    await saveReportTask(managedId,taskId,input,councilor); await saveReportTask(managedId,taskId,input,councilor);
    await rejects(() => saveReportTask(managedId,taskId,taskUpdate({title:'Stale'}),councilor),409);
    await rejects(() => saveReportTask(managedId,taskId,taskUpdate({status:'done',expectedVersion:1}),councilor),400);
    await saveReportTask(managedId,taskId,taskUpdate({status:'done',expectedVersion:1,outcome:'Inspection completed; staff-only result'}),councilor);
    const view = await reports.getResidentReport(managedId,councilor);
    assert.equal(view.status,'acknowledged'); assert.ok(view.lastActionAt); assert.ok(view.councillorActionAt);
    const memberView=await reports.getResidentReport(managedId,member);
    assert.ok(!JSON.stringify(memberView).includes('staff-only result'));
    assert.ok(!JSON.stringify(memberView).includes('Staff-only inspection instructions'));
    assert.ok(memberView.events.every((e)=>!e.actorName && !e.actorId));
    await rejects(() => saveReportTask(managedId,taskId,taskUpdate({status:'todo',dueAt:'2020-01-01T00:00:00Z',expectedVersion:2}),councilor),400);
    await saveReportTask(managedId,taskId,taskUpdate({status:'todo',dueAt:future(),expectedVersion:2}),councilor);
    assert.equal((await listReportTasks(councilor,{reportId:managedId})).items[0].completedAt,null);
  });
  await test('inactive task assignee is flagged and must be reassigned before update', async () => {
    await client.query('UPDATE users SET is_active=false WHERE id=$1',[councilor.sub]);
    assert.equal((await listReportTasks(admin,{reportId:managedId})).items[0].assigneeEligible,false);
    await rejects(() => saveReportTask(managedId,taskId,taskUpdate({title:'Still assigned',expectedVersion:3}),admin),400);
    await saveReportTask(managedId,taskId,taskUpdate({assigneeId:admin.sub,expectedVersion:3}),admin);
    await client.query('UPDATE users SET is_active=true WHERE id=$1',[councilor.sub]);
  });
  await test('overdue tasks, assignee filters, and accountability span pages', async () => {
    await client.query("UPDATE resident_report_tasks SET due_at=now()-interval '1 day' WHERE id=$1",[taskId]);
    const f={search:managementTag,overdue:'yes',assignee:admin.sub};
    const list=await listManagedReports(councilor,f);
    assert.equal(list.total,1); assert.equal(list.stats.overdue,1);
    assert.equal((await reportAccountability(councilor,f)).items[0].overdue,1);
    assert.equal((await reportAccountability(outside,f)).total,0);
    const empty=await reportAccountability(councilor,{...f,offset:999}); assert.equal(empty.total,1); assert.equal(empty.items.length,0);
    const options=await reportFilterOptions(councilor);
    assert.ok(options.taskAssignees.some((p)=>p.id===admin.sub));
    assert.equal((await listReportTasks(admin,{reportId:managedId,assignee:'me',overdue:'yes'})).total,1);
  });
  await test('closed reports retain tasks but reject creation; cancelling requires a reason', async () => {
    await applyReportAction(managedId,{action:'close',feedback:'Administrative closure'},councilor,ctx);
    await rejects(() => saveReportTask(managedId,null,taskCreate(),councilor),409);
    await rejects(() => saveReportTask(managedId,taskId,taskUpdate({status:'cancelled',expectedVersion:4}),admin),400);
    await saveReportTask(managedId,taskId,taskUpdate({status:'cancelled',expectedVersion:4,outcome:'No further inspection required'}),admin);
    assert.equal((await listReportTasks(councilor,{reportId:managedId})).total,1);
    assert.equal((await listManagedReports(councilor,{search:managementTag,overdue:'yes'})).total,0);
  });
  await test('live ward moves revoke old report-task access even with stale principal claims', async () => {
    await client.query('UPDATE users SET ward_code=$2 WHERE id=$1',[peer.sub,outsideWard]);
    await rejects(() => reportAssignees(managedId,peer),403);
    await rejects(() => saveReportTask(managedId,taskId,taskUpdate({title:'Wrong ward',expectedVersion:5}),peer),403);
    await client.query('UPDATE users SET ward_code=$2 WHERE id=$1',[peer.sub,ward]);
  });
  await test('staff reopen closed reports with a reason before adding tasks', async () => {
    await rejects(() => applyReportAction(managedId,{action:'reopen'},councilor,ctx),400);
    await rejects(() => applyReportAction(managedId,{action:'reopen',feedback:'New work'},member,ctx),403);
    await applyReportAction(managedId,{action:'reopen',feedback:'Further inspection needed'},councilor,ctx);
    const reopened = await reports.getResidentReport(managedId,councilor);
    assert.equal(reopened.status,'in_progress'); assert.equal(reopened.resolvedAt,null); assert.equal(reopened.confirmedAt,null);
    await saveReportTask(managedId,null,taskCreate({assigneeId:coordinator.sub}),councilor);
    assert.equal((await listReportTasks(coordinator,{reportId:managedId,assignee:'me'})).total,1);
  });
  await test('newly in-scope staff can open details with stale ward claims', async () => {
    await client.query('UPDATE users SET ward_code=$2 WHERE id=$1',[outside.sub,ward]);
    assert.equal((await reports.getResidentReport(managedId,outside)).id,managedId);
    await client.query('UPDATE users SET ward_code=$2 WHERE id=$1',[outside.sub,outsideWard]);
  });
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await test('patrol stats route uses authentication and patrol read permission', async () => {
      assert.equal((await fetch(`${base}/api/patrols/stats`)).status, 401);
      const response = await fetch(`${base}/api/patrols/stats`, { headers: { Authorization: `Bearer ${signAccessToken(councilor)}` } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).total, (await getDashboardActivity(councilor, 'patrols')).modules.patrols.total);
      await client.query('UPDATE users SET permission_revokes=$2 WHERE id=$1', [councilor.sub, [Permission.PATROL_READ]]);
      assert.equal((await fetch(`${base}/api/patrols/stats`, { headers: { Authorization: `Bearer ${signAccessToken(councilor)}` } })).status, 403);
      await client.query('UPDATE users SET permission_revokes=$2 WHERE id=$1', [councilor.sub, []]);
    });
    await test('report management HTTP endpoints enforce permissions and query validation', async () => {
      assert.equal((await fetch(`${base}/api/transparency/report-tasks`)).status,401);
      const headers={Authorization:`Bearer ${signAccessToken(councilor)}`};
      const response=await fetch(`${base}/api/transparency/reports?scope=inbox&limit=15&search=${managementTag}`,{headers});
      assert.equal(response.status,200); assert.equal((await response.json()).items.length,15);
      assert.equal((await fetch(`${base}/api/transparency/reports?scope=inbox&sort=invalid`,{headers})).status,400);
      assert.equal((await fetch(`${base}/api/transparency/report-tasks`,{headers:{Authorization:`Bearer ${signAccessToken(member)}`}})).status,403);
      assert.equal((await fetch(`${base}/api/transparency/reports/${managedId}/assignees`,{headers:{Authorization:`Bearer ${signAccessToken(outside)}`}})).status,403);
    });
    await test('media policy supports cross-origin PUT preflight', async () => {
      const response = await fetch(`${base}/api/transparency/media-policy`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'PUT' } });
      assert.ok(response.headers.get('access-control-allow-methods')?.split(',').includes('PUT'));
    });
    await test('notification bell lists unread-only and the archive keeps read messages', async () => {
      const headers = { Authorization: `Bearer ${signAccessToken(councilor)}` };
      const mk = (title) => client
        .query(`INSERT INTO notifications (user_id, kind, title, audience) VALUES ($1,'alert',$2,'staff') RETURNING id`, [councilor.sub, title])
        .then((r) => r.rows[0].id);
      const [a, b] = [await mk('QA bell A'), await mk('QA bell B')];
      assert.equal((await fetch(`${base}/api/notifications/${a}/read`, { method: 'POST', headers })).status, 200);
      // The route must map ?unread=true onto service.list's unreadOnly, or the
      // bell keeps surfacing messages the user has already read.
      const unread = await (await fetch(`${base}/api/notifications?unread=true`, { headers })).json();
      assert.ok(unread.items.some((n) => n.id === b), 'an unread message must stay in the bell');
      assert.ok(!unread.items.some((n) => n.id === a), 'a read message must clear from the bell');
      assert.ok(unread.items.every((n) => n.read === false), 'unread=true must return only unread items');
      // The archive (no filter) still carries the read message, read-flagged.
      const all = await (await fetch(`${base}/api/notifications`, { headers })).json();
      assert.ok(all.items.some((n) => n.id === a && n.read === true), 'the archive keeps read messages');
    });
    await test('superadmin ops routes are auth-gated, 403 for lower roles, and stripped by the module toggle', async () => {
      const opsRoutes = ['/api/analytics/overview', '/api/crm/superadmin/server', '/api/crm/superadmin/content'];
      const su = { Authorization: `Bearer ${signAccessToken(superadmin)}` };
      const na = { Authorization: `Bearer ${signAccessToken(admin)}` };
      const cu = { Authorization: `Bearer ${signAccessToken(councilor)}` };
      for (const path of opsRoutes) assert.equal((await fetch(`${base}${path}`)).status, 401, `${path} must require authentication`);
      for (const path of opsRoutes) {
        assert.equal((await fetch(`${base}${path}`, { headers: na })).status, 403, `national_admin must be denied ${path}`);
        assert.equal((await fetch(`${base}${path}`, { headers: cu })).status, 403, `ward_councillor must be denied ${path}`);
      }
      for (const path of opsRoutes) {
        const status = (await fetch(`${base}${path}`, { headers: su })).status;
        assert.ok(status >= 200 && status < 300, `superadmin must reach ${path}, got ${status}`);
      }
      // Disabling the superadmin module for the role strips all three surfaces live,
      // even for an entitled superadmin whose token still names the role.
      await client.query("INSERT INTO role_module_gates(role,module_key,enabled) VALUES ('superadmin','superadmin',false) ON CONFLICT (role,module_key) DO UPDATE SET enabled=false");
      for (const path of opsRoutes) assert.equal((await fetch(`${base}${path}`, { headers: su })).status, 403, `disabling the superadmin module must deny ${path}`);
      await client.query("UPDATE role_module_gates SET enabled=true WHERE role='superadmin' AND module_key='superadmin'");
      assert.equal((await fetch(`${base}/api/analytics/overview`, { headers: su })).status, 200, 're-enabling the module must restore access');
    });
  } finally { await new Promise((resolve) => server.close(resolve)); }

  if (process.argv.includes('--browser') && !failed) {
    const harness = express();
    let queue = Promise.resolve();
    harness.use((_req, res, next) => {
      const previous = queue;
      queue = new Promise((resolve) => res.once('finish', resolve));
      void previous.then(next);
    });
    harness.get('/api/qa-session', (req, res) => {
      const principal = req.query.role === 'member' ? member : req.query.role === 'councilor' ? councilor : req.query.role === 'coordinator' ? coordinator : admin;
      res.json({ accessToken: signAccessToken(principal), permissions: principal.permissions, enabledModules: modulesForRole(principal.role), ward, reportId: report.id, reportRef: report.refNo, managementTag });
    });
    harness.use(app);
    const port = Number(process.env.WORKFLOW_BROWSER_PORT ?? 4000);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local browser port');
    const browserServer = harness.listen(port, '127.0.0.1');
    await new Promise((resolve, reject) => { browserServer.once('listening', resolve); browserServer.once('error', reject); });
    console.log(`Rollback-only browser API ready on http://127.0.0.1:${port}; fixtures expire in 15 minutes.`);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 15 * 60 * 1000);
      process.once('SIGTERM', () => { clearTimeout(timer); resolve(); });
      process.once('SIGINT', () => { clearTimeout(timer); resolve(); });
    });
    await new Promise((resolve) => browserServer.close(resolve));
  }
} finally {
  await client.query('ROLLBACK');
  pool.query = originalQuery;
  pool.connect = originalConnect;
  client.release();
  await pool.end();
}
console.log(`Workflow regression: ${passed} passed, ${failed} failed. All fixtures rolled back.`);
if (failed) process.exitCode = 1;
