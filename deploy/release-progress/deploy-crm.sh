#!/usr/bin/env bash
# Apply the already-verified CRM release on the existing production server.
set -Eeuo pipefail
umask 077

RELEASE=udf-20260918T035445Z
ART=/root/udf-releases/$RELEASE
BACKUP=/var/backups/udf/$RELEASE
NEXT_API=/opt/udf/releases/$RELEASE/backend
NEXT_WEB=/var/www/udf/releases/$RELEASE/frontend
OLD_API=/opt/udf/backend.previous-$RELEASE
OLD_WEB=/var/www/udf/frontend.previous-$RELEASE
API_STOPPED=0
FINISHED=0

[[ $EUID == 0 ]] || { printf '%s\n' 'Run on the production host as root.' >&2; exit 1; }
exec 9>/run/lock/udf-release.lock
flock -n 9 || { printf '%s\n' 'Another UDF release is in progress.' >&2; exit 1; }

recover() {
  local status=$?
  trap - ERR INT TERM
  set +e
  if [[ $FINISHED == 0 && $API_STOPPED == 1 ]]; then
    printf '%s\n' 'Release failed; restoring the previous application directories.' >&2
    systemctl stop udf-api
    if [[ -d $OLD_API ]]; then
      if [[ -d /opt/udf/backend ]]; then
        if [[ -d /opt/udf/backend/uploads ]]; then
          cp -a /opt/udf/backend/uploads/. "$OLD_API/uploads/"
        fi
        mv /opt/udf/backend "/opt/udf/backend.failed-$RELEASE"
      fi
      mv "$OLD_API" /opt/udf/backend
    fi
    if [[ -d $OLD_WEB ]]; then
      [[ ! -d /var/www/udf/frontend ]] || mv /var/www/udf/frontend "/var/www/udf/frontend.failed-$RELEASE"
      mv "$OLD_WEB" /var/www/udf/frontend
    fi
    systemctl start udf-api
    printf '%s\n' 'Database was not restored automatically; committed additive migrations and all uploads are retained.' >&2
  fi
  printf 'Release stopped with status %s. Inspect retained staging and backups before retrying.\n' "$status" >&2
  exit 1
}
trap recover ERR INT TERM

[[ -d /opt/udf/backend && ! -L /opt/udf/backend ]]
[[ -d /var/www/udf/frontend && ! -L /var/www/udf/frontend ]]
[[ -d /opt/udf/backend/uploads && ! -L /opt/udf/backend/uploads ]]
for path in "$BACKUP" "$NEXT_API" "$NEXT_WEB" "$OLD_API" "$OLD_WEB" "$ART/DEPLOYED"; do
  [[ ! -e $path ]] || { printf 'Refusing to overwrite existing release path: %s\n' "$path" >&2; exit 1; }
done
systemctl is-active --quiet udf-api
nginx -t
cd "$ART"
printf '%s\n' \
  '8e7387c98e1d2646425e777bd5dbfb382d8787155551aa570365bf52a5d932a7  udf-backend.tar.gz' \
  'b77e9f6d45cfd6392ef5a51d3d03dcafb812442a55e6b201676c2d3c42ac2ff2  udf-frontend.tar.gz' | sha256sum -c -

printf '%s\n' 'Preparing new application directories while the current service stays online.'
install -d -m 755 "$(dirname "$NEXT_API")" "$NEXT_WEB"
tar --no-same-owner -xzf "$ART/udf-backend.tar.gz" -C "$(dirname "$NEXT_API")"
tar --no-same-owner -xzf "$ART/udf-frontend.tar.gz" -C "$NEXT_WEB"
cd "$NEXT_API"
npm ci --omit=dev --no-audit --no-fund
# Existing tabs can still request content-addressed assets from the previous build.
if [[ -d /var/www/udf/frontend/_next/static ]]; then
  install -d "$NEXT_WEB/_next/static"
  cp -an /var/www/udf/frontend/_next/static/. "$NEXT_WEB/_next/static/"
fi
chown -R root:udf "$NEXT_WEB"
chmod -R u=rwX,go=rX "$NEXT_WEB"

set -a
. /etc/udf/udf-api.env
. /etc/udf/secrets.env
set +a
export NODE_ENV=production
node --input-type=module <<'NODE'
import { readdir } from 'node:fs/promises';
import { pool } from './dist/db/pool.js';
await import('argon2');
try {
  const done = new Set((await pool.query('SELECT id FROM schema_migrations')).rows.map(row => row.id));
  const files = (await readdir('./dist/db/migrations')).filter(file => file.endsWith('.sql')).sort();
  const pending = files.filter(file => !done.has(file));
  const expected = ['027_report_workflow_media.sql', '028_councillor_profile_assignment.sql', '029_councillor_member_link.sql'];
  if (pending.join('|') !== expected.join('|')) throw new Error('Unexpected pending migration set; stop for inspection');
  const invalid = await pool.query("SELECT count(*)::int AS count FROM patrol_stops WHERE call_status NOT IN ('call_logged','in_progress','waiting_on_feedback','completed')");
  if (invalid.rows[0].count !== 0) throw new Error('Patrol call status compatibility check failed');
  console.log('Environment, native dependency and migration preflight passed.');
} finally { await pool.end(); }
NODE

install -d -m 700 "$BACKUP"
systemctl is-active nginx postfix dovecot opendkim > "$BACKUP/services-before.txt" || true
printf '%s\n' 'Stopping only the UDF API for a consistent backup and release switch.'
API_STOPPED=1
systemctl stop udf-api
runuser -u postgres -- pg_dump -Fc udf > "$BACKUP/database.dump"
pg_restore --list "$BACKUP/database.dump" >/dev/null
tar -czf "$BACKUP/backend.tar.gz" -C /opt/udf backend
tar -czf "$BACKUP/frontend.tar.gz" -C /var/www/udf frontend
tar -czf "$BACKUP/config.tar.gz" -C / etc/udf etc/nginx etc/systemd/system/udf-api.service
cp -a /opt/udf/backend/uploads "$NEXT_API/uploads"
chown -R udf:udf "$NEXT_API"
# The temporary build inherits a restrictive umask; the service needs traversal/read access.
chmod 755 "$NEXT_API"

printf '%s\n' 'Applying migrations and their ledger entries in one transaction.'
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { pool } from './dist/db/pool.js';
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query('SELECT pg_advisory_xact_lock(1430537779, 20260918)');
  const files = ['027_report_workflow_media.sql', '028_councillor_profile_assignment.sql', '029_councillor_member_link.sql'];
  for (const file of files) {
    const existing = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
    if (existing.rowCount) throw new Error('Migration state changed since preflight');
    await client.query(await readFile(`./dist/db/migrations/${file}`, 'utf8'));
    await client.query('INSERT INTO schema_migrations(id) VALUES ($1)', [file]);
    console.log(`Applied ${file}`);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
NODE

mv /opt/udf/backend "$OLD_API"
mv "$NEXT_API" /opt/udf/backend
mv /var/www/udf/frontend "$OLD_WEB"
mv "$NEXT_WEB" /var/www/udf/frontend
cd /opt/udf/backend
systemctl start udf-api

node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let healthy = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:4000/healthz', { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    if (response.ok && body.status === 'ok' && body.db === true) { healthy = true; break; }
  } catch {}
  await sleep(1000);
}
if (!healthy) throw new Error('API health did not recover within the verification window');
const publicHealth = await fetch('https://crm.udf-party.co.za/healthz', { signal: AbortSignal.timeout(15000) });
if (!publicHealth.ok || !(await publicHealth.json()).db) throw new Error('Public HTTPS health failed');
for (const route of ['/', '/crm/', '/crm/patrols/']) {
  const response = await fetch(`https://crm.udf-party.co.za${route}`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const actual = Buffer.from(await response.arrayBuffer());
  const expected = await readFile(`/var/www/udf/frontend${route}index.html`);
  if (response.status !== 200 || hash(actual) !== hash(expected)) throw new Error(`Public static mismatch: ${route}`);
  console.log(`PASS public HTTPS ${route}`);
}
console.log('PASS API/database health and public HTTPS release content');
NODE
systemctl is-active --quiet udf-api
systemctl is-active nginx postfix dovecot opendkim > "$BACKUP/services-after.txt" || true
cmp "$BACKUP/services-before.txt" "$BACKUP/services-after.txt"
printf '%s\n' "$RELEASE" > "$ART/DEPLOYED"
FINISHED=1
trap - ERR INT TERM
printf 'DEPLOYED %s\nBACKUP %s\nPREVIOUS_API %s\nPREVIOUS_FRONTEND %s\n' "$RELEASE" "$BACKUP" "$OLD_API" "$OLD_WEB"
