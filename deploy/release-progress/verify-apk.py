#!/usr/bin/env python3
"""Record the old APK identity, then verify an updated local debug APK."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
RECORD = Path(__file__).resolve().parent
APK = ROOT / 'frontend/android/app/build/outputs/apk/debug/app-debug.apk'
TOOLS = Path('/Users/why/Library/Android/sdk/build-tools/35.0.0')
ENV = dict(os.environ, JAVA_HOME='/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home')
BASELINE = RECORD / 'apk-baseline.json'
API = b'https://crm.udf-party.co.za/api'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def command(*args):
    result = subprocess.run(args, env=ENV, capture_output=True, text=True, check=True)
    return result.stdout + result.stderr


def inspect():
    signature = command(str(TOOLS / 'apksigner'), 'verify', '--verbose', '--print-certs', str(APK))
    signers = re.findall(r'Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)', signature)
    if not signers or 'Verified using v2 scheme (APK Signature Scheme v2): true' not in signature:
        raise RuntimeError('APK signing verification did not establish a v2 signature')
    badging = command(str(TOOLS / 'aapt'), 'dump', 'badging', str(APK))
    package = re.search(r"package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging)
    if package is None:
        raise RuntimeError('Unable to read APK package identity')
    return {
        'apk': str(APK),
        'sha256': sha(APK.read_bytes()),
        'bytes': APK.stat().st_size,
        'applicationId': package[1],
        'versionCode': int(package[2]),
        'versionName': package[3],
        'debuggable': 'application-debuggable' in badging,
        'signerCertificateSha256': signers,
        'v2SignatureVerified': True,
        'signatureWarnings': [line for line in signature.splitlines() if line.startswith('WARNING:')],
    }


def verify_release(update_release=False):
    """Keep historical 1.0.2 verification; updates independently checks 1.0.8."""
    code, version = (9, '1.0.8') if update_release else (3, '1.0.2')
    info = inspect()
    if (info['applicationId'], info['versionCode'], info['versionName'], info['debuggable']) != (
            'com.udf.party', code, version, False):
        raise RuntimeError(f'Expected non-debuggable release com.udf.party {version} ({code})')
    badging = command(str(TOOLS / 'aapt'), 'dump', 'badging', str(APK))
    if "targetSdkVersion:'36'" not in badging:
        raise RuntimeError('Release must target API 36')
    forbidden = ('READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_MEDIA_AUDIO',
                 'MANAGE_EXTERNAL_STORAGE', 'ACCESS_BACKGROUND_LOCATION')
    if any(f'android.permission.{permission}' in badging for permission in forbidden):
        raise RuntimeError('Unexpected broad media or background permission')
    expected = command('openssl', 'x509', '-in', str(ROOT / 'secrets/android/udf-upload-certificate.pem'),
                       '-noout', '-fingerprint', '-sha256').strip().split('=')[-1].replace(':', '').lower()
    if info['signerCertificateSha256'] != [expected]:
        raise RuntimeError('APK signer differs from the approved upload certificate')
    if update_release:
        baseline_hash = '127f9b07b03831e8854e1819f2cb97091e9e5c00c30988634b8cfb77226c52b1'
        incumbent = ROOT / '.tmp-verify/app-update-baseline' / f'udf-6-{baseline_hash}.apk'
        if sha(incumbent.read_bytes()) != baseline_hash:
            raise RuntimeError('Approved incumbent APK not preserved')
        old_badging = command(str(TOOLS / 'aapt'), 'dump', 'badging', str(incumbent))
        old_signing = command(str(TOOLS / 'apksigner'), 'verify', '--print-certs', str(incumbent))
        if re.findall(r'Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)', old_signing) != [expected]:
            raise RuntimeError('Upgrade signer differs from incumbent')
        permissions = set(re.findall(r"uses-permission: name='([^']+)'", badging))
        if permissions != set(re.findall(r"uses-permission: name='([^']+)'", old_badging)):
            raise RuntimeError('Update must not add native permissions')
        apk_manifest = command(str(TOOLS / 'aapt'), 'dump', 'xmltree', str(APK), 'AndroidManifest.xml')
        if not re.search(r'android:allowBackup[^\n]*=\(type 0x12\)0x0', apk_manifest):
            raise RuntimeError('APK must explicitly disable backup')
        info.update(previousApprovedApk=str(incumbent), previousApprovedSha256=baseline_hash,
                    sameSignerAsPreviousApprovedApk=True, nativePermissionsUnchanged=True)
    previous = json.loads((RECORD / 'apk-build.json').read_text())
    if info['signerCertificateSha256'] == previous['signerCertificateSha256']:
        raise RuntimeError('Release unexpectedly uses the debug signer')
    if sha(Path(previous['apk']).read_bytes()) != previous['sha256']:
        raise RuntimeError('Previous debug APK was not preserved')
    command(str(TOOLS / 'zipalign'), '-c', '-P', '16', '4', str(APK))
    aab = ROOT / 'frontend/android/app/build/outputs/bundle/release/app-release.aab'
    java_bin = Path(ENV['JAVA_HOME']) / 'bin'
    jar_verification = command(str(java_bin / 'jarsigner'), '-verify', str(aab))
    if 'jar verified.' not in jar_verification or 'unsigned entries' in jar_verification.lower():
        raise RuntimeError('AAB signature verification failed or contains unsigned entries')
    aab_certificate = command(str(java_bin / 'keytool'), '-printcert', '-jarfile', str(aab))
    aab_fingerprints = re.findall(r'SHA256:\s*([0-9A-F:]+)', aab_certificate)
    if [value.replace(':', '').lower() for value in aab_fingerprints] != [expected]:
        raise RuntimeError('AAB and APK do not share the approved upload signer')
    manifest_path = aab.parent / 'AndroidManifest.xml'
    manifest = ET.parse(manifest_path).getroot()
    android = '{http://schemas.android.com/apk/res/android}'
    if (manifest.get('package'), manifest.get(android + 'versionCode'),
            manifest.get(android + 'versionName')) != ('com.udf.party', str(code), version):
        raise RuntimeError('AAB manifest identity mismatch')
    if manifest.find('uses-sdk').get(android + 'targetSdkVersion') != '36':
        raise RuntimeError('AAB target SDK mismatch')
    application = manifest.find('application')
    if application.get(android + 'debuggable', 'false') != 'false':
        raise RuntimeError('AAB is debuggable')
    if application.get(android + 'allowBackup') != 'false':
        raise RuntimeError('AAB unexpectedly permits backup')
    if any(item.get(android + 'name', '').split('.')[-1] in forbidden
           for item in manifest.findall('uses-permission')):
        raise RuntimeError('AAB contains a prohibited permission')
    export = ROOT / 'frontend/out'
    synced = ROOT / 'frontend/android/app/src/main/assets/public'
    assets_checked = {}
    for path, prefix in ((APK, 'assets/'), (aab, 'base/assets/')):
        with zipfile.ZipFile(path) as archive:
            if archive.testzip():
                raise RuntimeError(f'Corrupt archive: {path.name}')
            names = archive.namelist()
            if any(name.endswith(('.jks', '.keystore', '.p12', '.key', '.so')) or
                   name.endswith('keystore.properties') or '/.env' in name for name in names):
                raise RuntimeError('Unexpected secret or native library; inspect before shipping')
            config = json.loads(archive.read(prefix + 'capacitor.config.json'))
            if config.get('appId') != 'com.udf.party' or config.get('server', {}).get('url'):
                raise RuntimeError('Unexpected Capacitor identity or remote content URL')
            if config.get('android', {}).get('webContentsDebuggingEnabled') is True:
                raise RuntimeError('WebView debugging must not be enabled')
            checked = 0
            for source in sorted(export.rglob('*')):
                relative = source.relative_to(export)
                if not source.is_file() or any(part.startswith('.') for part in relative.parts):
                    continue
                data = source.read_bytes()
                if synced.joinpath(relative).read_bytes() != data or archive.read(
                        prefix + 'public/' + relative.as_posix()) != data:
                    raise RuntimeError(f'Export/sync/package asset mismatch: {relative}')
                checked += 1
            if not checked:
                raise RuntimeError('No web assets verified')
            scripts = [archive.read(name) for name in names
                       if name.startswith(prefix + 'public/_next/') and name.endswith('.js')]
            if not any(API in script for script in scripts):
                raise RuntimeError('Production API target missing')
            if any(b'http://localhost:4000' in script or b'https://102.68.98.129/api' in script
                   for script in scripts):
                raise RuntimeError('Local/legacy API target packaged')
            if update_release:
                bundled = b'\n'.join(scripts)
                for marker in (b'View data below', b'Back to map', b'Check for updates', b'udf.update.later.',
                               b'/public/app-update', b'Send update notice', b'ward changes remaining',
                               b'maximum of 3 times', b'following your location', b'CPT-W079', b'udf-map-svg',
                               b'Unable to load your registered ward right now.',
                               b'We could not confirm your ward change.',
                               b'This service or item is currently unavailable.', b'ward_change_stale'):
                    if marker not in bundled:
                        raise RuntimeError(f'Update/map/ward marker missing: {marker!r}')
                if any(marker in bundled.lower() for marker in (b'maplibre', b'mapbox', b'tile.openstreetmap')):
                    raise RuntimeError('Unexpected tile-map runtime or provider')
                styles = b'\n'.join(archive.read(name) for name in names
                                    if name.startswith(prefix + 'public/_next/') and name.endswith('.css'))
                for marker in (b'.udf-map-scroll-footer', b'--map-scroll-height', b'.app-update-dialog'):
                    if marker not in styles:
                        raise RuntimeError(f'Update/map stylesheet missing: {marker!r}')
                plugins = {p['pkg']: p['classpath'] for p in json.loads(archive.read(prefix + 'capacitor.plugins.json'))}
                for package, classpath in (
                        ('@capacitor/app', 'com.capacitorjs.plugins.app.AppPlugin'),
                        ('@capacitor/app-launcher', 'com.capacitorjs.plugins.applauncher.AppLauncherPlugin'),
                        ('@capacitor/preferences', 'com.capacitorjs.plugins.preferences.PreferencesPlugin')):
                    if plugins.get(package) != classpath:
                        raise RuntimeError(f'Native update plugin not registered: {package}')
                info['updatePluginsRegistered'] = True
                info['updateMapWardMarkersVerified'] = True
                info['tileFreeBundleScreeningPassed'] = True
            assets_checked[path.suffix] = checked
    mapping = ROOT / 'frontend/android/app/build/outputs/mapping/release/mapping.txt'
    if not mapping.is_file() or not mapping.stat().st_size:
        raise RuntimeError('R8 mapping missing')
    info.update({
        'targetSdk': 36,
        'aab': str(aab), 'aabSha256': sha(aab.read_bytes()), 'aabBytes': aab.stat().st_size,
        'aabJarSignatureVerified': True, 'aabManifestVerified': True,
        'aabSignatureNotes': jar_verification.strip(),
        'webAssetsVerified': assets_checked, 'apiBase': API.decode(),
        'packagedNativeLibraries': 0, 'apkZipAlignmentVerified': True,
        'sameSignerAsPreviousDebugApk': False, 'previousDebugApkPreserved': True,
        'r8Mapping': str(mapping), 'r8MappingSha256': sha(mapping.read_bytes()),
        'installedOrDeviceTested': False, 'uploadedToPlay': False,
    })
    receipt = RECORD / (f'app-update-build-{code}-{info["sha256"]}.json' if update_release else 'play-release-build.json')
    receipt.write_text(json.dumps(info, indent=2) + '\n')
    print(f'PASS release APK/AAB {version} ({code}), API 36, approved upload signer, non-debuggable')
    print(f'PASS web assets {assets_checked}, production API, no bundled native libraries, APK alignment')
    print(f'APK {APK}\nAAB {aab}\nRECEIPT {receipt}')
    print('Device/runtime testing and Play Console upload were not performed.')


def verify_current(apks_only=False, mail_only=False):
    """Verify current APKs, with independent APK-only and Mail-only modes."""
    global APK, TOOLS
    import tarfile
    TOOLS = Path('/Users/why/Library/Android/sdk/build-tools/36.0.0')
    signer = '0744136ba322327792b70495877024a9238e08e218418ea939577a4adb66d797'
    for directory, app_id, code, version in (
            ('frontend', 'com.udf.party', 6, '1.0.5'),
            ('mailapp', 'com.udf.mail', 1, '1.0.0')):
        if mail_only and directory != 'mailapp':
            continue
        APK = ROOT / directory / 'android/app/build/outputs/apk/release/app-release.apk'
        info = inspect()
        if (info['applicationId'], info['versionCode'], info['versionName'], info['debuggable']) != (
                app_id, code, version, False):
            raise RuntimeError('Unexpected release identity')
        if info['signerCertificateSha256'] != [signer]:
            raise RuntimeError('Unexpected release signer')
        badging = command(str(TOOLS / 'aapt'), 'dump', 'badging', str(APK))
        if "targetSdkVersion:'36'" not in badging:
            raise RuntimeError('Unexpected target SDK')
        manifest = command(str(TOOLS / 'aapt'), 'dump', 'xmltree', str(APK), 'AndroidManifest.xml')
        if not re.search(r'android:allowBackup[^\n]*=\(type 0x12\)0x0', manifest):
            raise RuntimeError('Backup must be explicitly disabled')
        command(str(TOOLS / 'zipalign'), '-c', '-P', '16', '4', str(APK))
        with zipfile.ZipFile(APK) as archive:
            if archive.testzip():
                raise RuntimeError('Corrupt APK')
            names = archive.namelist()
            if any(name.endswith(('.key', '.p12', '.jks', '.keystore', 'keystore.properties'))
                   or '/.env' in name for name in names):
                raise RuntimeError('Unexpected secret-like packaged file')
            config = json.loads(archive.read('assets/capacitor.config.json'))
            if config.get('appId') != app_id or config.get('android', {}).get('webContentsDebuggingEnabled'):
                raise RuntimeError('Unexpected WebView configuration')
            if directory == 'mailapp':
                if not re.search(r'android:usesCleartextTraffic[^\n]*=\(type 0x12\)0x0', manifest):
                    raise RuntimeError('Mail must explicitly prohibit cleartext traffic')
                if config.get('server') != {'url': 'https://mail.udf-party.co.za',
                                           'androidScheme': 'https', 'allowNavigation': []}:
                    raise RuntimeError('Mail remote URL/navigation mismatch')
                permissions = re.findall(r"uses-permission: name='([^']+)'", badging)
                if set(permissions) != {'android.permission.INTERNET',
                                       'com.udf.mail.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'}:
                    raise RuntimeError('Unexpected Mail permission')
            else:
                if config.get('server', {}).get('url'):
                    raise RuntimeError('Party app must bundle local assets')
                scripts = b'\n'.join(archive.read(name) for name in names
                                     if name.startswith('assets/public/_next/') and name.endswith('.js'))
                for marker in (API, b'following your location', b'No UDF candidate at LGE2026'):
                    if marker not in scripts:
                        raise RuntimeError('Party release content marker missing')
            if apks_only:
                export = ROOT / directory / ('out' if directory == 'frontend' else 'www')
                synced = ROOT / directory / 'android/app/src/main/assets/public'
                checked = 0
                for source in sorted(export.rglob('*')):
                    relative = source.relative_to(export)
                    if not source.is_file() or any(part.startswith('.') for part in relative.parts):
                        continue
                    data = source.read_bytes()
                    if synced.joinpath(relative).read_bytes() != data or archive.read(
                            'assets/public/' + relative.as_posix()) != data:
                        raise RuntimeError(f'Export/sync/APK mismatch: {directory}/{relative}')
                    checked += 1
                if not checked:
                    raise RuntimeError('No packaged web assets verified')
                info['webAssetsVerified'] = checked
                if directory == 'frontend' and any(target in scripts for target in (
                        b'http://localhost:4000', b'https://102.68.98.129/api')):
                    raise RuntimeError('Local or legacy API target packaged')
                mapping = ROOT / directory / 'android/app/build/outputs/mapping/release/mapping.txt'
                if not mapping.is_file() or not mapping.stat().st_size:
                    raise RuntimeError('R8 mapping missing')
                info['r8MappingSha256'] = sha(mapping.read_bytes())
        info.pop('signatureWarnings')
        print(json.dumps(info, sort_keys=True))
    if mail_only:
        print('PASS signed Mail APK, production HTTPS configuration, packaged asset parity and R8 mapping.')
        print('Static checks only; device testing and publication were not performed.')
        return
    if apks_only:
        previous = json.loads((RECORD / 'apk-build.json').read_text())
        if sha(Path(previous['apk']).read_bytes()) != previous['sha256']:
            raise RuntimeError('Previous debug APK was not preserved')
        print('PASS both signed APKs, packaged asset parity, R8 mappings and preserved debug APK.')
        print('Static checks only; device testing and publication were not performed.')
        return
    for name in ('udf-backend.tar.gz', 'udf-frontend.tar.gz'):
        path = ROOT / 'deploy/.artifacts' / name
        with tarfile.open(path) as archive:
            entries = archive.getmembers()
            if any(entry.issym() or entry.islnk() or entry.name.startswith('/')
                   or '..' in Path(entry.name).parts or any(part.startswith('._')
                   for part in Path(entry.name).parts) for entry in entries):
                raise RuntimeError('Unexpected archive path or link')
            if name == 'udf-backend.tar.gz':
                lock = json.load(archive.extractfile('backend/package-lock.json'))
                versions = {key: item['version'] for key, item in lock['packages'].items()
                            if key.endswith(('/express', '/qs'))}
                print('Backend runtime dependency versions: ' + json.dumps(versions, sort_keys=True))
                migrations = [entry.name for entry in entries
                              if entry.name.startswith('backend/dist/db/migrations/') and entry.name.endswith('.sql')]
                if len(migrations) != 51:
                    raise RuntimeError('Expected exactly 51 packaged migrations')
            else:
                for entry in entries:
                    if entry.isfile() and archive.extractfile(entry).read() != (ROOT / 'frontend/out' / entry.name).read_bytes():
                        raise RuntimeError('Frontend archive differs from export')
        print(f'PASS {name}: sha256={sha(path.read_bytes())} bytes={path.stat().st_size}')
    print('Static checks only; device installation, HTTP and authenticated mail tests are separate.')


mode = sys.argv[1] if len(sys.argv) == 2 else ''
if mode not in ('baseline', 'verify', 'release', 'current', 'apks', 'mail', 'updates'):
    raise SystemExit('Usage: python3 deploy/release-progress/verify-apk.py baseline|verify|release|current|apks|mail|updates')
if mode in ('current', 'apks', 'mail'):
    verify_current(apks_only=mode != 'current', mail_only=mode == 'mail')
    raise SystemExit(0)
if mode in ('release', 'updates'):
    APK = ROOT / 'frontend/android/app/build/outputs/apk/release/app-release.apk'
    verify_release(update_release=mode == 'updates')
    raise SystemExit(0)

info = inspect()
if mode == 'baseline':
    if BASELINE.exists():
        raise SystemExit('Baseline already exists; preserve it and use verify after building')
    BASELINE.write_text(json.dumps(info, indent=2) + '\n')
    print(f"Recorded existing APK {info['versionName']} ({info['versionCode']}) signing identity.")
else:
    previous = json.loads(BASELINE.read_text())
    if info['applicationId'] != 'com.udf.party' or info['applicationId'] != previous['applicationId']:
        raise RuntimeError('Application identity changed')
    if (info['versionCode'], info['versionName']) != (2, '1.0.1') or not info['debuggable']:
        raise RuntimeError('Expected the user-approved debug APK 1.0.1 (2)')
    if info['versionCode'] <= previous['versionCode'] or info['sha256'] == previous['sha256']:
        raise RuntimeError('APK is not an updated artifact')
    if info['signerCertificateSha256'] != previous['signerCertificateSha256']:
        raise RuntimeError('Signing identity changed; this APK cannot update the previous local APK')
    export = ROOT / 'frontend/out'
    synced = ROOT / 'frontend/android/app/src/main/assets/public'
    checked = 0
    with zipfile.ZipFile(APK) as archive:
        corrupt = archive.testzip()
        if corrupt:
            raise RuntimeError(f'Corrupt APK entry: {corrupt}')
        config = json.loads(archive.read('assets/capacitor.config.json'))
        if config.get('appId') != 'com.udf.party' or config.get('server', {}).get('url'):
            raise RuntimeError('Unexpected Capacitor application identity or remote web content URL')
        for source in sorted(export.rglob('*')):
            relative = source.relative_to(export)
            if not source.is_file() or any(part.startswith('.') for part in relative.parts):
                continue
            expected = source.read_bytes()
            if synced.joinpath(relative).read_bytes() != expected:
                raise RuntimeError(f'Synced web asset differs: {relative}')
            if archive.read('assets/public/' + relative.as_posix()) != expected:
                raise RuntimeError(f'Packaged web asset differs: {relative}')
            checked += 1
        if not checked:
            raise RuntimeError('No exported web assets were checked')
        scripts = [archive.read(name) for name in archive.namelist()
                   if name.startswith('assets/public/_next/static/chunks/') and name.endswith('.js')]
        if not any(API in script for script in scripts):
            raise RuntimeError('Production API URL missing from packaged JavaScript')
        if any(b'http://localhost:4000' in script or b'https://102.68.98.129/api' in script for script in scripts):
            raise RuntimeError('Unexpected local or legacy API target in packaged JavaScript')
    info['webAssetsVerified'] = checked
    info['apiBase'] = API.decode()
    info['sameSignerAsPreviousApk'] = True
    info['installedOrDeviceTested'] = False
    receipt = RECORD / 'apk-build.json'
    receipt.write_text(json.dumps(info, indent=2) + '\n')
    print(f"PASS debug APK {info['versionName']} ({info['versionCode']}), original signer, v2 signature")
    print(f'PASS {checked} packaged web assets match export and Capacitor sync; production API target verified')
    print(f"SHA256 {info['sha256']}\nBYTES {info['bytes']}\nAPK {APK}\nRECEIPT {receipt}")
    print('Device installation/runtime testing was not performed.')
