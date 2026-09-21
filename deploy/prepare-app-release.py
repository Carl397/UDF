#!/usr/bin/env python3
"""Operator-only APK catalog builder. Never deploys, signs, or sends a notice.

preserve: save the approved incumbent APK before a build overwrites its output.
prepare: verify the new APK against the incumbent and create an inactive catalog.
verify-public: after separately authorized publication, verify canonical HTTPS
bytes, then mark the catalog entry ready. Install catalog.json and immutable APKs
in the same root-owned directory (0755 directories, 0644 files), outside uploads;
configure APP_RELEASE_CATALOG_DIR and APP_RELEASE_SIGNER_SHA256 for the API.
The API service must not run as root or have write access to that directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

ORIGIN = 'https://crm.udf-party.co.za'
ROOT = Path(__file__).resolve().parents[1]


def run(*args):
    result = subprocess.run([str(a) for a in args], check=True, text=True, capture_output=True)
    return result.stdout + result.stderr


def inspect(apk, tools, certificate):
    data = apk.read_bytes()
    signature = run(tools / 'apksigner', 'verify', '--verbose', '--print-certs', apk)
    expected = run('openssl', 'x509', '-in', certificate, '-noout', '-fingerprint', '-sha256').strip().split('=')[-1].replace(':', '').lower()
    signers = re.findall(r'Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)', signature)
    if signers != [expected] or 'Verified using v2 scheme (APK Signature Scheme v2): true' not in signature:
        raise ValueError('APK does not have the approved release signature')
    badging = run(tools / 'aapt', 'dump', 'badging', apk)
    package = re.search(r"package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging)
    if not package or package[1] != 'com.udf.party' or 'application-debuggable' in badging:
        raise ValueError('Wrong package or debuggable APK')
    code = int(package[2])
    if not 0 < code <= 2100000000 or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?', package[3]):
        raise ValueError('Invalid release version')
    digest = hashlib.sha256(data).hexdigest()
    artifact_id = f'{code}-{digest}'
    return dict(id=artifact_id, packageId=package[1], versionCode=code, versionName=package[3],
                sha256=digest, bytes=len(data), signerSha256=expected, path=f'/downloads/udf-{artifact_id}.apk'), data


def immutable_copy(path, data):
    if path.exists():
        if path.is_symlink() or path.read_bytes() != data:
            raise ValueError(f'Refusing to overwrite different artifact: {path.name}')
        return
    with path.open('xb') as handle:
        handle.write(data)
    path.chmod(0o644)


def write_catalog(path, catalog):
    # Exclusive lock below serializes operators; replace only the catalog, never APKs.
    temp = path.with_suffix('.json.new')
    with temp.open('x') as handle:
        json.dump(catalog, handle, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    temp.chmod(0o644)
    os.replace(temp, path)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode', choices=['preserve', 'prepare', 'verify-public'])
    p.add_argument('--apk', type=Path, required=True)
    p.add_argument('--previous', type=Path)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--tools', type=Path, default=Path.home() / 'Library/Android/sdk/build-tools/35.0.0')
    p.add_argument('--certificate', type=Path, default=ROOT / 'secrets/android/udf-upload-certificate.pem')
    args = p.parse_args()
    artifact, data = inspect(args.apk, args.tools, args.certificate)
    args.output.mkdir(parents=True, exist_ok=True)
    if args.output.is_symlink():
        raise ValueError('Symlink output rejected')
    import fcntl
    with (args.output / '.catalog.lock').open('a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        if args.mode == 'preserve':
            dest = args.output / f'udf-{artifact["id"]}.apk'
            immutable_copy(dest, data)
            immutable_copy(args.output / f'{artifact["id"]}.json', (json.dumps(artifact, indent=2) + '\n').encode())
            print(json.dumps(dict(preserved=str(dest), **artifact), indent=2))
            return
        catalog_path = args.output / 'catalog.json'
        if catalog_path.is_symlink():
            raise ValueError('Symlink catalog rejected')
        if args.mode == 'prepare':
            if args.previous is None:
                p.error('--previous approved APK is required')
            previous, _ = inspect(args.previous, args.tools, args.certificate)
            if artifact['versionCode'] <= previous['versionCode']:
                raise ValueError('Build must be newer than the approved incumbent')
            catalog = json.loads(catalog_path.read_text()) if catalog_path.exists() else dict(schema=1, baselineVersionCode=previous['versionCode'], releases=[])
            same = next((r for r in catalog['releases'] if r['artifact']['versionCode'] == artifact['versionCode']), None)
            if same and same['artifact'] != artifact:
                raise ValueError('Version already names different immutable bytes')
            if not same:
                if any(r['artifact']['versionCode'] >= artifact['versionCode'] for r in catalog['releases']):
                    raise ValueError('Catalog already has an equal or newer release')
                catalog['releases'].append(dict(artifact=artifact, publicVerified=False))
            immutable_copy(args.output / Path(artifact['path']).name, data)
            write_catalog(catalog_path, catalog)
            print('PREPARED, NOT PUBLICLY VERIFIED: ' + artifact['id'])
        else:
            catalog = json.loads(catalog_path.read_text())
            entry = next(r for r in catalog['releases'] if r['artifact'] == artifact)
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, req, fp, code, msg, headers, newurl):
                    raise ValueError('Canonical APK must not redirect')
            opener = urllib.request.build_opener(NoRedirect())
            with opener.open(ORIGIN + artifact['path'], timeout=60) as response:
                if response.status != 200 or response.headers.get_content_type() != 'application/vnd.android.package-archive':
                    raise ValueError('Unexpected public APK response')
                public = response.read(artifact['bytes'] + 1)
            if public != data:
                raise ValueError('Public APK is not identical to the verified artifact')
            entry['publicVerified'] = True
            write_catalog(catalog_path, catalog)
            print('PUBLIC BYTES VERIFIED; no announcement sent: ' + artifact['id'])


if __name__ == '__main__':
    main()
