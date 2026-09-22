#!/usr/bin/env bash
# Party build 8 cutover. No announcement, Mail change, account seed or Play upload.
set -Eeuo pipefail
umask 077
: "${RELEASE:?Unique release ID required}"
: "${MANIFEST_SHA:?Pinned SHA256SUMS digest required}"
[[ "$RELEASE" =~ ^udf-update-[A-Za-z0-9-]+$ && "$MANIFEST_SHA" =~ ^[a-f0-9]{64}$ && $EUID == 0 ]]
ART="/root/udf-releases/$RELEASE"
BACKUP="/var/backups/udf/$RELEASE"
NEXT="/opt/udf/releases/$RELEASE"
WEB="/var/www/udf/releases/$RELEASE"
CATALOG="/var/lib/udf-app-releases/$RELEASE"
: "${APK_SHA:?Verified APK digest required}"
: "${APK_BYTES:?Verified APK byte count required}"
[[ "$APK_SHA" =~ ^[a-f0-9]{64}$ && "$APK_BYTES" =~ ^[1-9][0-9]{0,8}$ ]]
OLD_SHA=127f9b07b03831e8854e1819f2cb97091e9e5c00c30988634b8cfb77226c52b1
MAIL_SHA=9d1e77b49fe62db4118bad835055a23b6abb46f16e809d34cb4d216916976cd1
SIGNER=0744136ba322327792b70495877024a9238e08e218418ea939577a4adb66d797
CANONICAL="udf-8-$APK_SHA.apk"
STOPPED=0
FINISHED=0
exec 9>/run/lock/udf-release.lock
flock -n 9
recover() {
  local status=$?
  trap - ERR INT TERM
  set +e
  if [[ $STOPPED == 1 && $FINISHED == 0 ]]; then
    systemctl stop udf-api
    for pair in "/opt/udf/backend:backend" "/var/www/udf/frontend:frontend" "/var/www/udf/manifesto:manifesto"; do
      live="${pair%:*}"
      if [[ -d "$live.previous-$RELEASE" ]]; then
        if [[ -d "$live" ]]; then
          if [[ "$live" == /opt/udf/backend && -d "$live/uploads" ]]; then
            cp -a "$live/uploads/." "$live.previous-$RELEASE/uploads/"
          fi
          mv "$live" "$live.failed-$RELEASE"
        fi
        mv "$live.previous-$RELEASE" "$live"
      fi
    done
    cp -a "$BACKUP/udf-api.env" /etc/udf/udf-api.env
    cp -a "$BACKUP/udf.apk" "/var/www/udf/downloads/udf.apk.rollback-$RELEASE"
    mv "/var/www/udf/downloads/udf.apk.rollback-$RELEASE" /var/www/udf/downloads/udf.apk
    if [[ -f "/var/www/udf/downloads/$CANONICAL" ]]; then
      mv "/var/www/udf/downloads/$CANONICAL" "$BACKUP/failed-canonical.apk"
    fi
    systemctl start udf-api
    echo 'Rollback attempted; additive migration 052, backups and staging retained.' >&2
  fi
  echo "Release stopped with status $status; inspect services and retained evidence." >&2
  exit 1
}
trap recover ERR INT TERM
for p in "$BACKUP" "$NEXT" "$WEB" "$CATALOG" "$ART/DEPLOYED" "/var/www/udf/downloads/$CANONICAL"; do
  [[ ! -e "$p" && ! -L "$p" ]]
done
for live in /opt/udf/backend /var/www/udf/frontend /var/www/udf/manifesto; do
  [[ -d "$live" && ! -L "$live" && ! -e "$live.previous-$RELEASE" && ! -e "$live.failed-$RELEASE" ]]
done
cd "$ART"
printf '%s  SHA256SUMS\n' "$MANIFEST_SHA" | sha256sum -c -
sha256sum -c SHA256SUMS
python3 - "$APK_SHA" "$APK_BYTES" "$SIGNER" <<'PY'
import json, sys
from pathlib import Path
release = json.loads(Path('release.json').read_text())
catalog = json.loads(Path('catalog.json').read_text())
if release['scope'] != 'full' or release['apiBase'] != '/api' or len(release['sourceCommit']) != 40:
    raise ValueError('Unexpected source release identity')
if catalog['baselineVersionCode'] != 6 or len(catalog['releases']) != 1:
    raise ValueError('Unexpected catalog baseline')
entry = catalog['releases'][0]
a = entry['artifact']
if (a['packageId'], a['versionCode'], a['versionName'], a['sha256'], a['bytes'], a['signerSha256'], entry['publicVerified']) != (
        'com.udf.party', 8, '1.0.7', sys.argv[1], int(sys.argv[2]), sys.argv[3], False):
    raise ValueError('Unexpected artifact identity')
if a['path'] != '/downloads/udf-8-' + sys.argv[1] + '.apk':
    raise ValueError('Unexpected canonical path')
print('Source, version and immutable catalog identity verified.')
PY
printf '%s  %s\n' "$OLD_SHA" /var/www/udf/downloads/udf.apk "$MAIL_SHA" /var/www/udf/downloads/udf-mail.apk "$APK_SHA" "$CANONICAL" | sha256sum -c -
for svc in udf-api nginx php8.1-fpm postfix dovecot opendkim; do systemctl is-active --quiet "$svc"; done
nginx -t
install -d -m 755 "$NEXT" "$WEB/frontend" "$WEB/manifesto" "$CATALOG"
# Extract only regular files/directories; never links, traversal or Apple sidecars.
python3 - "$ART" "$NEXT" "$WEB" <<'PY'
import sys, tarfile
from pathlib import Path
art, nxt, web = map(Path, sys.argv[1:])
for name, dest in [('udf-backend.tar.gz', nxt), ('udf-frontend.tar.gz', web/'frontend'), ('udf-website.tar.gz', web/'manifesto')]:
    with tarfile.open(art/name) as archive:
        for item in archive.getmembers():
            p = Path(item.name)
            if not (item.isfile() or item.isdir()) or p.is_absolute() or '..' in p.parts or any(x.startswith('._') for x in p.parts):
                raise ValueError('Unsafe archive entry')
        archive.extractall(dest)
PY
# Preserve content-addressed chunks requested by already-open tabs and site extras.
cp -an /var/www/udf/frontend/_next/static/. "$WEB/frontend/_next/static/"
cp -an /var/www/udf/manifesto/. "$WEB/manifesto/"
chown -R root:udf "$WEB"
chmod -R u=rwX,go=rX "$WEB"
cd "$NEXT/backend"
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
  const files = (await readdir('./dist/db/migrations')).filter(x => x.endsWith('.sql')).sort();
  const done = (await pool.query('SELECT id FROM schema_migrations ORDER BY id')).rows.map(x => x.id);
  if (files.length !== 52 || files.at(-1) !== '052_app_releases.sql' || JSON.stringify(done) !== JSON.stringify(files.slice(0, -1))) throw Error('Expected exactly migration 052 pending');
  if ((await pool.query("SELECT to_regclass('app_release_state') AS name")).rows[0].name !== null) throw Error('Unexpected existing release tables');
  console.log('Database preflight: exactly 051 applied, only additive 052 pending.');
} finally { await pool.end(); }
NODE
install -d -m 700 "$BACKUP"
cp -a /etc/udf/udf-api.env "$BACKUP/udf-api.env"
cp -a /var/www/udf/downloads/udf.apk "$BACKUP/udf.apk"
systemctl is-active nginx php8.1-fpm postfix dovecot opendkim > "$BACKUP/services-before.txt"
STOPPED=1
systemctl stop udf-api
runuser -u postgres -- pg_dump -Fc udf > "$BACKUP/database.dump"
pg_restore --list "$BACKUP/database.dump" >/dev/null
tar -czf "$BACKUP/backend.tar.gz" -C /opt/udf backend
tar -czf "$BACKUP/frontend.tar.gz" -C /var/www/udf frontend
tar -czf "$BACKUP/manifesto.tar.gz" -C /var/www/udf manifesto
cp -a /opt/udf/backend/uploads "$NEXT/backend/uploads"
# Record migration and DDL together; retain this additive schema on rollback.
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { pool } from './dist/db/pool.js';
const c = await pool.connect();
try {
  await c.query('BEGIN');
  await c.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
  const done = (await c.query('SELECT id FROM schema_migrations ORDER BY id')).rows;
  if (done.length !== 51 || done.at(-1).id !== '051_leader_multi_ward.sql') throw Error('Migration state changed');
  await c.query(await readFile('./dist/db/migrations/052_app_releases.sql', 'utf8'));
  await c.query('INSERT INTO schema_migrations(id) VALUES ($1)', ['052_app_releases.sql']);
  await c.query('COMMIT');
  console.log('Migration 052 committed; no announcement or member data written.');
} catch(e) { await c.query('ROLLBACK'); throw e; }
finally { c.release(); await pool.end(); }
NODE
install -m 644 "$ART/$CANONICAL" "$CATALOG/$CANONICAL"
install -m 644 "$ART/catalog.json" "$CATALOG/catalog.json"
install -m 644 "$ART/$CANONICAL" "/var/www/udf/downloads/$CANONICAL"
install -m 644 "$ART/$CANONICAL" "/var/www/udf/downloads/udf.apk.new-$RELEASE"
mv "/var/www/udf/downloads/udf.apk.new-$RELEASE" /var/www/udf/downloads/udf.apk
# Confirm public canonical bytes before trusting the catalog. No counted request.
python3 - "$CATALOG" "$CANONICAL" "$APK_SHA" "$APK_BYTES" <<'PY'
import hashlib, json, os, sys, urllib.request
from pathlib import Path
root, name, digest, size = Path(sys.argv[1]), sys.argv[2], sys.argv[3], int(sys.argv[4])
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): raise ValueError('Unexpected redirect')
with urllib.request.build_opener(NoRedirect()).open('https://crm.udf-party.co.za/downloads/'+name, timeout=90) as r:
    data = r.read(size + 1)
    if r.status != 200 or r.headers.get_content_type() != 'application/vnd.android.package-archive' or len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Public canonical APK mismatch')
p = root/'catalog.json'
catalog = json.loads(p.read_text())
a = catalog['releases'][0]['artifact']
if len(catalog['releases']) != 1 or a['sha256'] != digest or a['versionCode'] != 8 or a['bytes'] != size: raise ValueError('Catalog mismatch')
catalog['releases'][0]['publicVerified'] = True
t = root/'catalog.json.verified'
with t.open('x') as f: json.dump(catalog, f, indent=2); f.write('\n')
t.chmod(0o644); os.replace(t, p)
PY
python3 - "$CATALOG" "$SIGNER" <<'PY'
import os, re, sys
from pathlib import Path
p = Path('/etc/udf/udf-api.env'); st = p.stat()
text = re.sub(r'^(?:export\s+)?APP_RELEASE_(?:CATALOG_DIR|SIGNER_SHA256)=.*\n?', '', p.read_text(), flags=re.M)
text = text.rstrip()+'\nAPP_RELEASE_CATALOG_DIR='+sys.argv[1]+'\nAPP_RELEASE_SIGNER_SHA256='+sys.argv[2]+'\n'
t = p.with_suffix('.env.app-update-new')
with t.open('x') as f: f.write(text); f.flush(); os.fsync(f.fileno())
os.chown(t, st.st_uid, st.st_gid); t.chmod(st.st_mode & 0o777); os.replace(t, p)
PY
chown -R udf:udf "$NEXT/backend"
chmod -R u=rwX,go=rX "$NEXT/backend/dist"
chmod 755 "$NEXT/backend"
mv /opt/udf/backend "/opt/udf/backend.previous-$RELEASE"
mv "$NEXT/backend" /opt/udf/backend
mv /var/www/udf/frontend "/var/www/udf/frontend.previous-$RELEASE"
mv "$WEB/frontend" /var/www/udf/frontend
mv /var/www/udf/manifesto "/var/www/udf/manifesto.previous-$RELEASE"
mv "$WEB/manifesto" /var/www/udf/manifesto
cd /opt/udf/backend
export APP_RELEASE_CATALOG_DIR="$CATALOG" APP_RELEASE_SIGNER_SHA256="$SIGNER"
runuser -u udf --preserve-environment -- node --input-type=module <<'NODE'
import { readCatalog, verifiedArtifact } from './dist/modules/appReleases/catalog.js';
import { pool } from './dist/db/pool.js';
try {
  const c = await readCatalog();
  if (c.releases.length !== 1 || !(await verifiedArtifact(c.releases[0].artifact.id))) throw Error('Service-user catalog verification failed');
  const state = (await pool.query('SELECT active_id,highest_version FROM app_release_state')).rows[0];
  if (state.active_id !== null || state.highest_version !== 0) throw Error('Unexpected announcement');
  console.log('Service-user catalog access verified; announcements remain inactive.');
} finally { await pool.end(); }
NODE
systemctl start udf-api
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
let ok = false;
for (let i=0;i<30;i++) {
  try { const r = await fetch('http://127.0.0.1:4000/healthz', {signal:AbortSignal.timeout(2000)}); const b=await r.json(); if(r.ok && b.status==='ok' && b.db===true){ok=true;break;} } catch {}
  await sleep(1000);
}
if (!ok) throw Error('API health failed');
for (const [url, path] of [
  ['https://crm.udf-party.co.za/crm/downloads/', '/var/www/udf/frontend/crm/downloads/index.html'],
  ['https://crm.udf-party.co.za/', '/var/www/udf/frontend/index.html'],
  ['https://udf-party.co.za/mobile', '/var/www/udf/manifesto/mobile.html'],
]) {
  const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(20000)});
  if(r.status!==200 || !Buffer.from(await r.arrayBuffer()).equals(await readFile(path))) throw Error('Public static mismatch: '+url);
}
const r=await fetch('https://crm.udf-party.co.za/api/public/app-update',{signal:AbortSignal.timeout(20000)});
if(r.status!==200 || r.headers.get('cache-control')!=='no-store' || await r.json()!==null) throw Error('Inactive update discovery failed');
const missing=await fetch('https://crm.udf-party.co.za/api/release-ward-probe',{signal:AbortSignal.timeout(10000)});
const failure=await missing.json();
if(missing.status!==404 || failure.error?.message!=='This service or item is currently unavailable. Please try again later.' || 'details' in failure.error) throw Error('Safe public error verification failed');
console.log('Public web, API health, safe errors and inactive update discovery passed.');
NODE
printf '%s  %s\n' "$APK_SHA" /var/www/udf/downloads/udf.apk "$MAIL_SHA" /var/www/udf/downloads/udf-mail.apk | sha256sum -c -
systemctl is-active nginx php8.1-fpm postfix dovecot opendkim > "$BACKUP/services-after.txt"
cmp "$BACKUP/services-before.txt" "$BACKUP/services-after.txt"
printf '%s\n' "$RELEASE" > "$ART/DEPLOYED"
FINISHED=1
trap - ERR INT TERM
printf 'DEPLOYED %s\nBACKUP %s\n' "$RELEASE" "$BACKUP"
