import assert from 'node:assert/strict';
import { api, tokenStore } from '../src/lib/api.ts';
import { reportExportRows, safeReportCsvCell, c3Label } from '../src/lib/reportManagement.ts';
import { Perm, permissionLabel } from '../src/lib/caps.ts';

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
  await test('every permission has a distinct action-and-subject label', async () => {
    const labels = Object.values(Perm).map((permission) => {
      const label = permissionLabel(permission);
      assert.notEqual(label, permission, `${permission} needs a readable label`);
      assert.ok(label.trim().split(/\s+/).length >= 3, `${permission} must name its action and subject`);
      assert.doesNotMatch(label, /:/, `${permission} must not render a raw permission identifier`);
      return label;
    });
    assert.equal(new Set(labels).size, labels.length);
    assert.equal(permissionLabel(Perm.MEMBER_READ), 'View member records');
    assert.equal(permissionLabel(Perm.BULLETIN_WRITE), 'Publish ward bulletins');
    assert.equal(permissionLabel(Perm.VERIFY_WRITE), 'Verify service-delivery repairs');
    assert.equal(permissionLabel(Perm.AUDIT_READ), 'View audit logs');
  });
  await test('unknown permission labels preserve their full identifiers', async () => {
    for (const permission of ['future_feature:read', 'future_feature:write', 'toString', '__proto__', '']) {
      assert.equal(permissionLabel(permission), permission);
    }
  });
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
    await assert.rejects(() => api.transparencyMediaBlob('fixture'), (error) =>
      error.code === 'network_error' && error.message === 'Unable to connect. Please check your connection and try again.');
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
  await test('managed reports use 15-row pagination and serialize all filters', async () => {
    globalThis.fetch = async (url) => {
      const q = new URL(url,'http://localhost').searchParams;
      assert.equal(q.get('limit'),'15'); assert.equal(q.get('offset'),'30'); assert.equal(q.get('scope'),'inbox');
      assert.equal(q.get('search'),'water & street'); assert.equal(q.get('c3'),'missing'); assert.equal(q.get('direction'),'asc');
      assert.equal(q.has('category'),false);
      return json({items:[],total:0,stats:{}});
    };
    await api.managedReports({search:'water & street',c3:'missing',direction:'asc',category:undefined},15,30);
  });
  await test('filtered exports span bounded batches and omit private references', async () => {
    const offsets=[];
    globalThis.fetch = async (url) => {
      const q=new URL(url,'http://localhost').searchParams;
      assert.equal(q.get('limit'),'200'); assert.equal(q.get('ward'),'QA-W1');
      const offset=Number(q.get('offset')); offsets.push(offset);
      return json({ total:201,items:Array.from({length:offset===0?200:1},(_,n)=>({id:String(offset+n),refNo:'RR-'+(offset+n),
        message:'=HYPERLINK("bad")',externalReference:'PRIVATE-C3',c3Requirement:'required',hasC3:true})) });
    };
    const rows=await reportExportRows({ward:'QA-W1'});
    assert.equal(rows.length,201); assert.deepEqual(offsets,[0,200]);
    assert.ok(!JSON.stringify(rows).includes('PRIVATE-C3')); assert.ok(rows[0].some((cell)=>cell.startsWith("'=HYPERLINK")));
  });
  await test('changing export totals fail rather than silently exporting a partial result', async () => {
    let calls=0;
    globalThis.fetch=async()=>json(++calls===1?{total:2,items:[{id:'1'}]}:{total:1,items:[]});
    await assert.rejects(()=>reportExportRows({}),/changed during export/);
    for(const value of ['=SUM(1)', ' +SUM(1)', '@CMD', '-CMD', '\tCMD']) assert.ok(safeReportCsvCell(value).startsWith("'"));
    assert.equal(safeReportCsvCell('RR-123'),'RR-123');
    assert.equal(c3Label({c3Requirement:'required',hasC3:false}),'Required — number missing');
    assert.equal(c3Label({c3Requirement:'needs_assessment',externalReference:'GENERIC'}),'Needs assessment');
  });
  await test('task mutations preserve idempotency and version across token replay', async () => {
    const bodies=[];
    globalThis.fetch=async(url,init)=>{
      if(url.endsWith('/auth/refresh')) return json({accessToken:'fresh-access',refreshToken:'rotated'});
      bodies.push(JSON.parse(init.body));
      assert.ok(url.endsWith('/transparency/reports/report/tasks/task'));
      return new Headers(init.headers).get('Authorization')==='Bearer fresh-access'?json({id:'task'}):json({},401);
    };
    const payload={status:'done',outcome:'Finished',expectedVersion:3,requestId:'00000000-0000-4000-8000-000000000002'};
    await api.updateReportTask('report','task',payload); assert.deepEqual(bodies,[payload,payload]);
  });
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
console.log(`Client workflow regression: ${passed} passed.`);
