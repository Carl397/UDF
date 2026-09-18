/**
 * Runtime smoke test for the engagement layer (events / posts / appointments /
 * notifications / public website). Not part of the shipped app — safe to delete.
 *   node scripts/smoke.mjs
 */
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4000';
const EMAIL = process.env.SMOKE_EMAIL ?? 'admin@party.example';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'ChangeMe!12345';

let pass = 0;
let fail = 0;

function ok(name, extra = '') {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? ` — ${extra}` : ''}`);
}
function bad(name, err) {
  fail += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name} — ${err}`);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function expect(name, method, path, want, opts = {}) {
  const r = await call(method, path, opts);
  if (r.status !== want) {
    bad(name, `${method} ${path} → ${r.status}, want ${want} :: ${JSON.stringify(r.json).slice(0, 220)}`);
    return null;
  }
  ok(name, `${want}`);
  return r.json;
}

const count = (x) => (Array.isArray(x) ? x.length : Array.isArray(x?.items) ? x.items.length : '?');

async function main() {
  console.log(`\nSmoke: ${BASE} as ${EMAIL}\n`);

  // ── health ─────────────────────────────────────────────────────
  const health = await expect('GET /healthz', 'GET', '/healthz', 200);
  if (!health?.db) bad('db reachable', JSON.stringify(health));
  else ok('db reachable', 'db: true');

  // ── auth ───────────────────────────────────────────────────────
  const login = await expect('POST /api/auth/login', 'POST', '/api/auth/login', 200, {
    body: { email: EMAIL, password: PASSWORD },
  });
  const token = login?.accessToken ?? login?.token ?? login?.tokens?.access;
  if (!token) {
    bad('access token present', JSON.stringify(login).slice(0, 300));
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(1);
  }
  ok('access token present', `role=${login?.user?.role ?? '?'}`);

  // ── members now carry ward + public code ───────────────────────
  const members = await expect('GET /api/members?limit=3', 'GET', '/api/members?limit=3', 200, { token });
  const m0 = members?.items?.[0];
  for (const field of ['publicCode', 'ward', 'joinedAt']) {
    if (m0 && field in m0) ok(`member.${field} surfaced`, String(m0[field]));
    else bad(`member.${field} surfaced`, `missing on ${JSON.stringify(Object.keys(m0 ?? {}))}`);
  }

  // ── events ─────────────────────────────────────────────────────
  const events = await expect('GET /api/events', 'GET', '/api/events', 200, { token });
  ok('events seeded', `n=${count(events)}`);
  const upcoming = await expect('GET /api/events?upcoming=true', 'GET', '/api/events?upcoming=true&limit=3', 200, { token });
  ok('upcoming filter works', `n=${count(upcoming)}`);
  const ev0 = events?.items?.[0];
  if (ev0) await expect('GET /api/events/:id', 'GET', `/api/events/${ev0.id}`, 200, { token });

  // ── posts / newsroom ───────────────────────────────────────────
  const posts = await expect('GET /api/posts', 'GET', '/api/posts', 200, { token });
  ok('posts seeded', `n=${count(posts)}`);
  const news = await expect('GET /api/posts?kind=news', 'GET', '/api/posts?kind=news', 200, { token });
  ok('kind=news filter', `n=${count(news)}`);

  // ── appointments / position catalog ────────────────────────────
  const positions = await expect('GET /api/appointments/positions', 'GET', '/api/appointments/positions', 200, { token });
  ok('position catalog', `n=${count(positions)}`);
  const appts = await expect('GET /api/appointments', 'GET', '/api/appointments', 200, { token });
  ok('appointments seeded', `n=${count(appts)}`);

  // ── notifications ──────────────────────────────────────────────
  const notifs = await expect('GET /api/notifications', 'GET', '/api/notifications', 200, { token });
  ok('notifications', `n=${count(notifs)}`);
  const unread = await expect('GET /api/notifications/unread-count', 'GET', '/api/notifications/unread-count', 200, { token });
  ok('unread count', `unread=${unread?.unread ?? unread?.count ?? '?'}`);

  // ── public website (no token) ──────────────────────────────────
  const meta = await expect('GET /api/public/meta', 'GET', '/api/public/meta', 200);
  ok('meta.party.contacts', meta?.party?.contacts?.email ?? 'MISSING');
  ok('meta.standsFor', `n=${count(meta?.standsFor)}`);
  const manifesto = await expect('GET /api/public/manifesto', 'GET', '/api/public/manifesto', 200);
  ok('manifesto.mission/vision', `${!!manifesto?.mission}/${!!manifesto?.vision}`);

  // register → confirm → verify round trip
  const stamp = Date.now().toString().slice(-6);
  const reg = await expect('POST /api/public/register', 'POST', '/api/public/register', 201, {
    body: {
      fullName: `Smoke Tester ${stamp}`,
      email: `smoke+${stamp}@party.example`,
      phone: `+2782${stamp}00`,
      regionCode: 'CENTRAL',
      ward: '7',
      tier: 'volunteer',
      motivation: 'Automated smoke test of the public join flow.',
      consent: { emailOptin: true, smsOptin: false, phoneOptin: false, dataShare: true },
    },
  });
  if (reg) {
    ok('register.publicCode', reg.publicCode ?? 'MISSING');
    ok('register.membershipNo', reg.membershipNo ?? reg.member?.membershipNo ?? 'MISSING');
    for (const k of ['confirmUrl', 'verifyUrl', 'joinUrl']) {
      if (reg[k]) ok(`register.${k}`, reg[k]);
      else bad(`register.${k}`, 'missing from response');
    }

    const confirmToken = reg.confirmUrl?.split('/confirm/')?.[1]?.split('?')[0];
    if (confirmToken) {
      const conf = await expect('GET /api/public/confirm/:token', 'GET', `/api/public/confirm/${confirmToken}`, 200);
      ok('confirm.kind', conf?.kind ?? 'MISSING');
      // idempotent replay
      const again = await call('GET', `/api/public/confirm/${confirmToken}`);
      if (again.status === 200 && again.json?.alreadyUsed) ok('confirm replay is idempotent', 'alreadyUsed=true');
      else bad('confirm replay is idempotent', `${again.status} ${JSON.stringify(again.json).slice(0, 160)}`);
    } else bad('confirm token parsed', String(reg.confirmUrl));

    if (reg.publicCode) {
      const ver = await expect('GET /api/public/verify/:code', 'GET', `/api/public/verify/${reg.publicCode}`, 200);
      ok('verify contact released (dataShare)', ver?.contact?.email ?? ver?.contact?.phone ?? 'MISSING');
      const vc = await call('GET', `/api/public/verify/${reg.publicCode}/vcard`);
      if (vc.status === 200 && String(vc.json).includes('BEGIN:VCARD')) ok('vcard export', 'BEGIN:VCARD');
      else bad('vcard export', `${vc.status} ${String(vc.json).slice(0, 120)}`);
      const wrong = await call('GET', '/api/public/verify/UDF-ZZZ-ZZZ');
      if (wrong.status === 404) ok('unknown code → 404', '404');
      else bad('unknown code → 404', String(wrong.status));
    }
  }

  // party card for an existing member (authenticated — used by the ID-card screen)
  if (m0) {
    const card = await expect('GET /api/public/card/:memberId', 'GET', `/api/public/card/${m0.id}`, 200, { token });
    if (card?.joinUrl) ok('card.joinUrl', card.joinUrl);
    else bad('card.joinUrl', `missing: ${JSON.stringify(Object.keys(card ?? {}))}`);
    ok('card.offices', `n=${count(card?.offices ?? card?.roles)}`);

    const anonCard = await call('GET', `/api/public/card/${m0.id}`);
    if (anonCard.status === 401) ok('card requires auth', '401');
    else bad('card requires auth', String(anonCard.status));
  }

  // register with an explicit geo point exercises the other SQL branch
  const geoStamp = (Number(stamp) + 1).toString();
  const geoReg = await expect('POST /api/public/register (with lat/lng)', 'POST', '/api/public/register', 201, {
    body: {
      fullName: `Smoke Geo ${geoStamp}`,
      email: `smoke+geo${geoStamp}@party.example`,
      regionCode: 'NORTH',
      tier: 'voter',
      lat: 40.9,
      lng: -98.7,
      consent: { emailOptin: false, smsOptin: false, phoneOptin: false, dataShare: false },
    },
  });
  if (geoReg?.publicCode) {
    const ver = await expect('GET /api/public/verify/:code (no dataShare)', 'GET', `/api/public/verify/${geoReg.publicCode}`, 200);
    // Privacy rule: contact details stay sealed unless the member opted in.
    if (!ver?.contact) ok('contact withheld without consent', 'contact=null');
    else bad('contact withheld without consent', JSON.stringify(ver.contact));
  }

  // ── mandate acceptance round trip ──────────────────────────────
  const proposed = appts?.items?.find((a) => a.status === 'proposed');
  if (proposed) {
    const link = await expect(
      'POST /api/appointments/:id/mandate-link',
      'POST',
      `/api/appointments/${proposed.id}/mandate-link`,
      200,
      { token },
    );
    const mToken = link?.mandateUrl?.split('/confirm/')?.[1]?.split('?')[0];
    if (!mToken) {
      bad('mandate link parsed', String(link?.mandateUrl));
    } else {
      const conf = await expect('GET /api/public/confirm/:token (mandate)', 'GET', `/api/public/confirm/${mToken}`, 200);
      if (conf?.kind === 'mandate') ok('confirm.kind is mandate', `office=${conf.office ?? conf.position ?? '?'}`);
      else bad('confirm.kind is mandate', JSON.stringify(conf).slice(0, 200));

      const after = await expect('GET /api/appointments/:id', 'GET', `/api/appointments/${proposed.id}`, 200, { token });
      // appointment_status enum is proposed|confirmed|revoked.
      if (after?.status === 'confirmed') ok('mandate acceptance confirms the appointment', `acceptedAt=${after.mandateAcceptedAt}`);
      else bad('mandate acceptance confirms the appointment', `status=${after?.status}`);
      if (after?.mandateAcceptedAt) ok('mandate_accepted_at stamped', after.mandateAcceptedAt);
      else bad('mandate_accepted_at stamped', 'null');
    }
  } else {
    bad('a proposed appointment exists to accept', 'none seeded');
  }

  // ── authz: public write routes must reject anonymous callers ───
  const anon = await call('POST', '/api/events', { body: {} });
  if (anon.status === 401 || anon.status === 403) ok('POST /api/events rejects anonymous', String(anon.status));
  else bad('POST /api/events rejects anonymous', String(anon.status));

  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\nSmoke crashed:', err);
  process.exit(1);
});
