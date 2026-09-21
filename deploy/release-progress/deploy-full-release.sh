#!/usr/bin/env bash
# Backup-first application cutover. Mail policy and APK publication are separate
# acceptance gates; this script never resets data or changes nginx/mail services.
set -Eeuo pipefail
umask 077

: "${RELEASE:?Set a unique release ID after the approved source commit}"
[[ "$RELEASE" =~ ^udf-[A-Za-z0-9-]+$ ]] || exit 1
[[ $EUID == 0 ]] || { echo 'Run on the production host as root.' >&2; exit 1; }
ART="/root/udf-releases/$RELEASE"
BACKUP="/var/backups/udf/$RELEASE"
NEXT_API="/opt/udf/releases/$RELEASE/backend"
NEXT_WEB="/var/www/udf/releases/$RELEASE/frontend"
NEXT_SITE="/var/www/udf/releases/$RELEASE/manifesto"
OLD_API="/opt/udf/backend.previous-$RELEASE"
OLD_WEB="/var/www/udf/frontend.previous-$RELEASE"
OLD_SITE="/var/www/udf/manifesto.previous-$RELEASE"
API_STOPPED=0
FINISHED=0
exec 9>/run/lock/udf-release.lock
flock -n 9 || { echo 'Another release holds the deployment lock.' >&2; exit 1; }

recover() {
  local status=$?
  trap - ERR INT TERM
  set +e
  if [[ $FINISHED == 0 && $API_STOPPED == 1 ]]; then
    systemctl stop udf-api
    if [[ -d "$OLD_API" ]]; then
      if [[ -d /opt/udf/backend ]]; then
        if [[ -d /opt/udf/backend/uploads ]]; then
          cp -a /opt/udf/backend/uploads/. "$OLD_API/uploads/"
        fi
        mv /opt/udf/backend "/opt/udf/backend.failed-$RELEASE"
      fi
      mv "$OLD_API" /opt/udf/backend
    fi
    if [[ -d "$OLD_WEB" ]]; then
      [[ ! -d /var/www/udf/frontend ]] || mv /var/www/udf/frontend "/var/www/udf/frontend.failed-$RELEASE"
      mv "$OLD_WEB" /var/www/udf/frontend
    fi
    if [[ -d "$OLD_SITE" ]]; then
      [[ ! -d /var/www/udf/manifesto ]] || mv /var/www/udf/manifesto "/var/www/udf/manifesto.failed-$RELEASE"
      mv "$OLD_SITE" /var/www/udf/manifesto
    fi
    systemctl start udf-api
    echo 'Previous application paths restored; database/uploads retained.' >&2
  fi
  echo "Release stopped (status $status); backups and staging retained for inspection." >&2
  exit 1
}
trap recover ERR INT TERM
for path in /opt/udf/backend /opt/udf/backend/uploads /var/www/udf/frontend /var/www/udf/manifesto; do
  [[ -d "$path" && ! -L "$path" ]] || { echo "Unexpected live layout: $path" >&2; exit 1; }
done
for path in "$BACKUP" "$NEXT_API" "$NEXT_WEB" "$NEXT_SITE" "$OLD_API" "$OLD_WEB" "$OLD_SITE" "$ART/WEB_DEPLOYED"; do
  [[ ! -e "$path" ]] || { echo "Refusing to overwrite release path: $path" >&2; exit 1; }
done
[[ -f "$ART/website/index.html" && -f "$ART/website/mobile.html" ]]
for svc in udf-api nginx php8.1-fpm postfix dovecot opendkim; do
  systemctl is-active --quiet "$svc"
done
nginx -t
cd "$ART"
printf '%s\n' \
  '4b0cbd7872e45f97d3e55c8904e5ab5b916f9c80f0112da34d1f232f82317636  udf-backend.tar.gz' \
  '40d07c56b2b51f97a11d1eb8eec20e4e3cb387d4b79b48006a165d15e4db6e11  udf-frontend.tar.gz' | sha256sum -c -

install -d -m 755 "$(dirname "$NEXT_API")" "$NEXT_WEB" "$NEXT_SITE"
tar --no-same-owner -xzf "$ART/udf-backend.tar.gz" -C "$(dirname "$NEXT_API")"
tar --no-same-owner -xzf "$ART/udf-frontend.tar.gz" -C "$NEXT_WEB"
# Preserve existing marketing files, then overlay the approved release source.
cp -a /var/www/udf/manifesto/. "$NEXT_SITE/"
cp -a "$ART/website/." "$NEXT_SITE/"
# Existing browser tabs may still request previous content-addressed assets.
if [[ -d /var/www/udf/frontend/_next/static ]]; then
  install -d "$NEXT_WEB/_next/static"
  cp -an /var/www/udf/frontend/_next/static/. "$NEXT_WEB/_next/static/"
fi
chown -R root:udf "$NEXT_WEB" "$NEXT_SITE"
chmod -R u=rwX,go=rX "$NEXT_WEB" "$NEXT_SITE"
cd "$NEXT_API"
npm ci --omit=dev --no-fund
npm audit --omit=dev --audit-level=high
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
  if (files.length !== 51 || files.at(-1) !== '051_leader_multi_ward.sql'
      || files.some(file => !done.has(file)) || done.size !== files.length) {
    throw new Error('Migration set changed; this release applies no migrations');
  }
  console.log('Native dependency, database and migration preflight passed.');
} finally { await pool.end(); }
NODE

install -d -m 700 "$BACKUP"
systemctl is-active nginx php8.1-fpm postfix dovecot opendkim > "$BACKUP/services-before.txt"
API_STOPPED=1
systemctl stop udf-api
runuser -u postgres -- pg_dump -Fc udf > "$BACKUP/database.dump"
pg_restore --list "$BACKUP/database.dump" >/dev/null
tar -czf "$BACKUP/backend.tar.gz" -C /opt/udf backend
tar -czf "$BACKUP/frontend.tar.gz" -C /var/www/udf frontend
tar -czf "$BACKUP/manifesto.tar.gz" -C /var/www/udf manifesto
tar -czf "$BACKUP/config.tar.gz" -C / etc/udf etc/nginx etc/systemd/system/udf-api.service
cp -a /opt/udf/backend/uploads "$NEXT_API/uploads"
chown -R udf:udf "$NEXT_API"
chmod 755 "$NEXT_API"

mv /opt/udf/backend "$OLD_API"
mv "$NEXT_API" /opt/udf/backend
mv /var/www/udf/frontend "$OLD_WEB"
mv "$NEXT_WEB" /var/www/udf/frontend
mv /var/www/udf/manifesto "$OLD_SITE"
mv "$NEXT_SITE" /var/www/udf/manifesto
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
if (!healthy) throw new Error('API did not recover within the verification window');
const health = await fetch('https://crm.udf-party.co.za/healthz', { signal: AbortSignal.timeout(15000) });
if (!health.ok || !(await health.json()).db) throw new Error('Public API health failed');
for (const [origin, route, path] of [
  ['https://crm.udf-party.co.za', '/crm/', '/var/www/udf/frontend/crm/index.html'],
  ['https://crm.udf-party.co.za', '/crm/wards/', '/var/www/udf/frontend/crm/wards/index.html'],
  ['https://udf-party.co.za', '/', '/var/www/udf/manifesto/index.html'],
  ['https://udf-party.co.za', '/mobile', '/var/www/udf/manifesto/mobile.html'],
]) {
  const response = await fetch(origin + route, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (response.status !== 200 || hash(Buffer.from(await response.arrayBuffer())) !== hash(await readFile(path))) {
    throw new Error(`Public static content mismatch: ${origin}${route}`);
  }
  console.log(`PASS public content ${origin}${route}`);
}
NODE
systemctl is-active --quiet udf-api
systemctl is-active nginx php8.1-fpm postfix dovecot opendkim > "$BACKUP/services-after.txt"
cmp "$BACKUP/services-before.txt" "$BACKUP/services-after.txt"
printf '%s\n' "$RELEASE" > "$ART/WEB_DEPLOYED"
FINISHED=1
trap - ERR INT TERM
printf 'WEB_DEPLOYED %s\nBACKUP %s\n' "$RELEASE" "$BACKUP"
echo 'Councillor linking, mail deployment, authenticated acceptance and APK publication remain separate gates.'
