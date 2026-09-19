#!/usr/bin/env bash
# Deploy only the frozen permission-label frontend; leave API, database, and mail untouched.
set -Eeuo pipefail
umask 077

RELEASE=udf-20260919T023411Z
ART=/root/udf-releases/$RELEASE
BACKUP=/var/backups/udf/$RELEASE
LIVE=/var/www/udf/frontend
NEXT=/var/www/udf/releases/$RELEASE/frontend
OLD=/var/www/udf/frontend.previous-$RELEASE
SWITCH_STARTED=0
FINISHED=0

[[ $EUID == 0 ]] || { printf '%s\n' 'Run on the production host as root.' >&2; exit 1; }
exec 9>/run/lock/udf-release.lock
flock -n 9 || { printf '%s\n' 'Another UDF release is in progress.' >&2; exit 1; }

recover() {
  local status=$?
  trap - ERR INT TERM
  set +e
  if [[ $FINISHED == 0 && $SWITCH_STARTED == 1 && -d $OLD ]]; then
    if [[ -d $LIVE ]]; then
      cp -an "$LIVE/_next/static/." "$OLD/_next/static/"
      mv "$LIVE" "/var/www/udf/frontend.failed-$RELEASE"
    fi
    mv "$OLD" "$LIVE"
    printf '%s\n' 'Previous frontend restored. API, database, and mail were not changed.' >&2
  fi
  printf 'Release stopped with status %s; inspect retained staging and backups before retrying.\n' "$status" >&2
  exit 1
}
trap recover ERR INT TERM

[[ -d $LIVE && ! -L $LIVE ]]
for path in "$BACKUP" "$NEXT" "$OLD" "$ART/DEPLOYED" "/var/www/udf/frontend.failed-$RELEASE"; do
  [[ ! -e $path && ! -L $path ]] || { printf 'Refusing existing release path: %s\n' "$path" >&2; exit 1; }
done
for service in udf-api nginx postfix dovecot opendkim; do systemctl is-active --quiet "$service"; done
cd "$ART"
printf '%s\n' '25a672ab3bba0dc417e60882bdece851b5524745fd4ce97ed7ee3e868ddf95d8  udf-frontend.tar.gz' | sha256sum -c -
printf '%s\n' \
  'e2c15eee06f25a05847cf31290c1654651eb2381629452307ec997e758aab045  /var/www/udf/frontend/crm/users/index.html' \
  'e4c30c7bab269f1b119b3425083ef322f565ba359f321b2857929d72ea3f91b2  /var/www/udf/frontend/crm/settings/index.html' | sha256sum -c -
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
const release = JSON.parse(await readFile('./release.json', 'utf8'));
if (release.id !== 'udf-20260919T023411Z' || release.scope !== 'frontend' ||
    release.sourceCommit !== '1e6974584f1d50101cab0ebe39f919d408156616' || release.apiBase !== '/api') {
  throw new Error('Unexpected release identity or scope');
}
const response = await fetch('https://crm.udf-party.co.za/healthz', { signal: AbortSignal.timeout(15000) });
const health = await response.json();
if (!response.ok || health.status !== 'ok' || health.db !== true) throw new Error('Preflight health failed');
console.log('PASS release identity and API/database health');
NODE

install -d -m 700 "$BACKUP"
systemctl show udf-api nginx postfix dovecot opendkim -p Id -p MainPID -p NRestarts -p ActiveState -p ActiveEnterTimestamp > "$BACKUP/services-before.txt"
sha256sum /opt/udf/backend/dist/index.js /opt/udf/backend/package.json > "$BACKUP/backend-before.sha256"
tar -czf "$BACKUP/frontend.tar.gz" -C /var/www/udf frontend
tar -tzf "$BACKUP/frontend.tar.gz" >/dev/null
install -d -m 755 "$NEXT"
tar --no-same-owner -xzf "$ART/udf-frontend.tar.gz" -C "$NEXT"
# Retain content-addressed assets for already-open browser tabs.
cp -an "$LIVE/_next/static/." "$NEXT/_next/static/"
chown -R root:udf "$NEXT"
chmod -R u=rwX,go=rX "$NEXT"
node --input-type=module <<'NODE'
import { readFile, readdir } from 'node:fs/promises';
const oldRoot = '/var/www/udf/frontend/_next/static';
const newRoot = '/var/www/udf/releases/udf-20260919T023411Z/frontend/_next/static';
async function compare(relative = '') {
  for (const entry of await readdir(`${oldRoot}/${relative}`, { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await compare(name);
    else if (entry.isFile()) {
      if (!(await readFile(`${oldRoot}/${name}`)).equals(await readFile(`${newRoot}/${name}`))) {
        throw new Error(`Previous static asset not preserved: ${name}`);
      }
    } else throw new Error('Unexpected nonregular static asset');
  }
}
await compare();
console.log('PASS all previous browser assets preserved');
NODE

SWITCH_STARTED=1
mv "$LIVE" "$OLD"
mv "$NEXT" "$LIVE"
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
const origin = 'https://crm.udf-party.co.za';
const root = '/var/www/udf/frontend';
const assets = new Set();
for (const route of ['/', '/crm/', '/crm/patrols/', '/crm/resident-reports/', '/crm/users/', '/crm/settings/']) {
  const response = await fetch(`${origin}${route}`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status !== 200 || !bytes.equals(await readFile(`${root}${route}index.html`))) {
    throw new Error(`Public HTML mismatch: ${route}`);
  }
  for (const match of bytes.toString('utf8').matchAll(/(?:src|href)="(\/_next\/[^"?#]+)"/g)) assets.add(match[1]);
  console.log(`PASS public HTTPS ${route}`);
}
let scripts = '';
for (const asset of assets) {
  const response = await fetch(`${origin}${asset}`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status !== 200 || !bytes.equals(await readFile(`${root}${asset}`))) {
    throw new Error(`Public asset mismatch: ${asset}`);
  }
  if (asset.endsWith('.js')) scripts += bytes.toString('utf8');
}
for (const label of ['View member records', 'Publish ward bulletins', 'Verify service-delivery repairs', 'View audit logs']) {
  if (!scripts.includes(label)) throw new Error(`Descriptive label absent from served scripts: ${label}`);
}
for (const path of ['/api/crm/users', '/api/crm/roles/member/permissions']) {
  const response = await fetch(`${origin}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (response.status !== 401) throw new Error(`Expected authentication boundary: ${path}`);
}
const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(15000) });
const health = await response.json();
if (!response.ok || health.status !== 'ok' || health.db !== true) throw new Error('Post-deploy health failed');
console.log(`PASS ${assets.size} public assets, descriptive labels, authentication boundaries, and API/database health`);
NODE
for service in udf-api nginx postfix dovecot opendkim; do systemctl is-active --quiet "$service"; done
systemctl show udf-api nginx postfix dovecot opendkim -p Id -p MainPID -p NRestarts -p ActiveState -p ActiveEnterTimestamp > "$BACKUP/services-after.txt"
cmp "$BACKUP/services-before.txt" "$BACKUP/services-after.txt"
sha256sum -c "$BACKUP/backend-before.sha256"
printf '%s\n' "$RELEASE" > "$ART/DEPLOYED"
FINISHED=1
trap - ERR INT TERM
printf 'DEPLOYED %s\nBACKUP %s\nPREVIOUS_FRONTEND %s\n' "$RELEASE" "$BACKUP" "$OLD"
