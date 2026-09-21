import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pool } from '../src/db/pool.ts';
import { buildStarterPackEmail, buildOtpResendEmail } from '../src/modules/onboarding/starterPack.ts';
import { buildMessage } from '../src/security/mailer.ts';

// Read-only service stubs: no database connection, SMTP, OTP issuance or member writes.
const originalQuery = pool.query;
let fielded = false;
let councillor = false;
pool.query = async (sql) => {
  assert.match(sql, /^\s*SELECT\b/i);
  if (sql.includes('SELECT name FROM regions')) return { rows: [{ name: '61' }] };
  if (sql.includes('SELECT DISTINCT w.ward_code')) return { rows: fielded ? [{ ward_code: 'CPT-W061' }] : [] };
  if (sql.includes('SELECT l.member_id')) return { rows: councillor ? [{ full_name: 'Example Councillor', bio: 'Service record', photo_id: null, contact_public: {} }] : [] };
  if (sql.includes('p.name AS position')) return { rows: [] };
  throw new Error('Unexpected starter-pack query');
};
const member = { to: 'preview@example.invalid', fullName: '<Example> Member', membershipNo: 'PREVIEW-ONLY', publicCode: 'PREVIEW', wardCode: null };
const otp = '000000'; // Synthetic preview value, never issued or usable.
let checks = 0;
function pass(name) { checks++; console.log(`PASS ${name}`); }
const parseMime = (email, expected) => {
  const raw = buildMessage({ to: member.to, template: 'preview_only', ...email });
  const parsed = spawnSync('python3', ['-c', `
import sys, json, hashlib
from email import policy
from email.parser import BytesParser
msg = BytesParser(policy=policy.default).parsebytes(sys.stdin.buffer.read())
assert not any(part.defects for part in msg.walk())
parts = [{"type": p.get_content_type(), "disposition": p.get_content_disposition(), "cid": p.get('Content-ID'), "name": p.get_filename(), "sha256": hashlib.sha256(p.get_payload(decode=True)).hexdigest()} for p in msg.walk() if not p.is_multipart()]
print(json.dumps({"root": msg.get_content_type(), "types": [p.get_content_type() for p in msg.walk()], "parts": parts, "text": msg.get_body(preferencelist=('plain',)).get_content(), "html": msg.get_body(preferencelist=('html',)).get_content()}))
`], { input: raw, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(parsed.status, 0, parsed.stderr);
  const result = JSON.parse(parsed.stdout);
  assert.equal(result.root, expected);
  assert.equal(result.text, email.text);
  assert.equal(result.html, email.html);
  return { raw, result };
};
try {
  const email = await buildStarterPackEmail(member, otp);
  const image = email.attachments.find(a => a.cid === 'udf-president');
  const pdf = email.attachments.find(a => a.contentType === 'application/pdf');
  assert(image && pdf && !pdf.cid);
  assert.deepEqual(image.buffer, await readFile(new URL('../../resources/brand-src/president-poster.jpg', import.meta.url)));
  assert(pdf.buffer.includes(image.buffer), 'PDF embeds the exact original JPEG');
  assert.equal(pdf.buffer.subarray(0, 8).toString(), '%PDF-1.4');
  assert.match(pdf.buffer.toString('latin1'), /\/Count 1\b/);
  assert.match(email.html, /src="cid:udf-president"/);
  assert.match(email.html, /height:auto/);
  assert.match(email.text, /OUR PRESIDENT — Andhor Grey Marks/);
  assert(email.html.includes('&lt;Example&gt;') && !email.html.includes('<Example>'));
  assert(email.text.includes(otp) && email.html.includes(otp));
  assert(!email.html.includes('href=') && !email.text.includes('/manifesto'));
  pass('president inline image and printable PDF without a leader DB row; OTP and escaping preserved');

  const { raw, result } = parseMime(email, 'multipart/mixed');
  assert.deepEqual(result.types, ['multipart/mixed', 'multipart/related', 'multipart/alternative', 'text/plain', 'text/html', 'image/jpeg', 'application/pdf']);
  assert.equal(result.parts.find(p => p.type === 'image/jpeg').cid, '<udf-president>');
  assert.equal(result.parts.find(p => p.type === 'image/jpeg').disposition, 'inline');
  assert.equal(result.parts.find(p => p.type === 'application/pdf').disposition, 'attachment');
  assert.equal(result.parts.find(p => p.type === 'application/pdf').name, pdf.filename);
  pass('independent MIME parser verifies mixed/related/alternative nesting and downloadable PDF');

  parseMime({ ...email, attachments: [image] }, 'multipart/related');
  pass('existing inline-only image messages retain multipart/related');
  parseMime({ ...email, attachments: [pdf] }, 'multipart/mixed');
  pass('file-only messages retain text and HTML alternatives');
  const resend = buildOtpResendEmail(member, otp);
  assert.equal(resend.attachments.length, 0);
  parseMime(resend, 'multipart/alternative');
  pass('OTP-only email remains attachment-free');

  const unContested = await buildStarterPackEmail({ ...member, wardCode: 'CPT-W061' }, otp);
  assert.match(unContested.text, /did not field a candidate in Ward 61/);
  assert.equal(unContested.attachments.length, 2);
  pass('uncontested ward wording preserved alongside president attachments');
  fielded = true;
  const vacant = await buildStarterPackEmail({ ...member, wardCode: 'CPT-W061' }, otp);
  assert.match(vacant.text, /currently vacant/);
  pass('contested vacant ward wording preserved');
  councillor = true;
  const filled = await buildStarterPackEmail({ ...member, wardCode: 'CPT-W061' }, otp);
  assert.match(filled.text, /Your ward councillor: Example Councillor/);
  assert.match(filled.text, /Service record/);
  pass('existing councillor identity and bio retained');

  if (process.argv.includes('--preview')) {
    const dir = new URL('../../.tmp-verify/president-starter-pack/', import.meta.url);
    await mkdir(dir, { recursive: true });
    await writeFile(new URL('starter-pack.eml', dir), raw);
    await writeFile(new URL('starter-pack.html', dir), email.html.replace('cid:udf-president', `data:image/jpeg;base64,${image.buffer.toString('base64')}`));
    await writeFile(new URL('udf-president.pdf', dir), pdf.buffer);
    console.log('Synthetic, unsent preview: .tmp-verify/president-starter-pack/');
  }
} finally {
  pool.query = originalQuery;
  await pool.end();
}
console.log(`${checks} starter-pack checks passed; no email sent.`);
