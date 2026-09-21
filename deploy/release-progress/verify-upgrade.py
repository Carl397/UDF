#!/usr/bin/env python3
"""Local-only signed instrumentation: retained synthetic preference + native bridges.

Refuses all devices except the existing isolated release AVD. Never uninstalls,
wipes, signs the Party app, logs in, or announces/downloads a real release. The
probe APK is a separate test package, not a distributable application. It uses
the existing signer because Android requires matching signatures to instrument
a non-debuggable release; the Party APK/security settings remain unchanged.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SDK = Path.home() / 'Library/Android/sdk'
TOOLS = SDK / 'build-tools/36.0.0'
JAVA = Path('/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home')
OUT = ROOT / '.tmp-verify/app-update-upgrade'
PACKAGE = 'com.udf.party.upgradeprobe'
COMPONENT = PACKAGE + '/com.udf.qa.UpgradeProbe'
OLD_HASH = '127f9b07b03831e8854e1819f2cb97091e9e5c00c30988634b8cfb77226c52b1'
OLD = ROOT / '.tmp-verify/app-update-baseline' / f'udf-6-{OLD_HASH}.apk'
NEW = ROOT / 'frontend/android/app/build/outputs/apk/release/app-release.apk'
SIGNER = '0744136ba322327792b70495877024a9238e08e218418ea939577a4adb66d797'
ENV = dict(os.environ, JAVA_HOME=str(JAVA))

SOURCE = r'''
package com.udf.qa;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

public class UpgradeProbe extends Instrumentation {
    private Bundle args;
    public void onCreate(Bundle arguments) { super.onCreate(arguments); args = arguments; start(); }
    private WebView find(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i=0; i<group.getChildCount(); i++) { WebView w = find(group.getChildAt(i)); if(w!=null) return w; }
        }
        return null;
    }
    private String evaluate(WebView web, String js) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        runOnMainSync(() -> web.evaluateJavascript(js, value -> { result.set(value); latch.countDown(); }));
        if (!latch.await(10, TimeUnit.SECONDS)) throw new Exception("WebView evaluation timeout");
        return result.get();
    }
    public void onStart() {
        Bundle result = new Bundle();
        try {
            Context context = getTargetContext();
            PackageInfo info = context.getPackageManager().getPackageInfo("com.udf.party", 0);
            boolean before = "before".equals(args.getString("phase"));
            if (info.getLongVersionCode() != (before ? 6 : 7)) throw new Exception("Unexpected target build");
            SharedPreferences prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
            String key = "udf.qa.upgrade.7", value = args.getString("value");
            if (value == null || !value.matches("[0-9a-f]{32}")) throw new Exception("Invalid synthetic marker");
            if (before && !prefs.edit().putString(key, value).commit()) throw new Exception("Preference commit failed");
            if (!value.equals(prefs.getString(key, null))) throw new Exception("Synthetic preference not retained");
            result.putString("preference", before ? "stored" : "retained");
            result.putString("build", Long.toString(info.getLongVersionCode()));
            result.putString("version", info.versionName);
            result.putString("uid", Integer.toString(context.getApplicationInfo().uid));
            if (!before) {
                try {
                    Intent launch = context.getPackageManager().getLaunchIntentForPackage("com.udf.party");
                    Activity activity = startActivitySync(launch);
                    result.putString("launch", "passed");
                    AtomicReference<WebView> found = new AtomicReference<>();
                    runOnMainSync(() -> found.set(find(activity.getWindow().getDecorView())));
                    WebView web = found.get();
                    if (web == null) throw new Exception("No WebView found");
                    for (int i=0; i<60; i++) {
                        if ("true".equals(evaluate(web, "Boolean(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App)"))) break;
                        Thread.sleep(500);
                    }
                    if ("prompt".equals(args.getString("phase"))) {
                        // Reset only this synthetic notice's deferral for a deliberate rerun.
                        prefs.edit().remove("udf.update.later.999999-" + new String(new char[64]).replace('\0','f')).commit();
                        // Intercept only anonymous update discovery inside this test process.
                        // No announcement/API/database mutation and no download click.
                        String setup = "window.__udfQaOriginalFetch=window.fetch;window.__udfQaChecks=0;" +
                          "window.__udfQaArtifact='999999-'+ 'f'.repeat(64);" +
                          "window.fetch=(input,init)=>{if(String(input).endsWith('/public/app-update')){window.__udfQaChecks++;" +
                          "return Promise.resolve(new Response(JSON.stringify({announcementId:'11111111-1111-4111-8111-111111111111'," +
                          "artifactId:window.__udfQaArtifact,packageId:'com.udf.party',versionCode:999999,versionName:'999.0.0'," +
                          "sha256:'f'.repeat(64),bytes:30000000,notes:'Synthetic local acceptance notice. No release is published.'," +
                          "publishedAt:'2026-09-21T00:00:00Z',downloadUrl:'https://crm.udf-party.co.za/api/public/download/app-release/'+window.__udfQaArtifact})," +
                          "{status:200,headers:{'Content-Type':'application/json'}}));}return window.__udfQaOriginalFetch(input,init);};";
                        evaluate(web, setup);
                        boolean shown = false;
                        for (int i=0; i<150; i++) {
                            shown = "true".equals(evaluate(web, "Boolean(document.querySelector('dialog.app-update-dialog[open]'))"));
                            if(shown) break;
                            Thread.sleep(500);
                        }
                        if(!shown) throw new Exception("Prompt not observed during 75-second active window");
                        String dom = evaluate(web, "(()=>{const d=document.querySelector('dialog.app-update-dialog[open]');" +
                          "return {modal:d.matches(':modal'),focusInside:d.contains(document.activeElement)," +
                          "notes:d.textContent.includes('Synthetic local acceptance notice.')," +
                          "buttons:[...d.querySelectorAll('button')].map(b=>b.textContent),checks:window.__udfQaChecks};})()");
                        result.putString("prompt", dom);
                        sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
                        Thread.sleep(1000);
                        result.putString("backDismissed", evaluate(web, "!document.querySelector('dialog.app-update-dialog[open]')"));
                        long deadline = Long.parseLong(prefs.getString("udf.update.later.999999-" + new String(new char[64]).replace('\0','f'), "0"));
                        result.putString("deferralHours", Long.toString(Math.round((deadline-System.currentTimeMillis())/3600000.0)));
                        evaluate(web, "window.fetch=window.__udfQaOriginalFetch;delete window.__udfQaOriginalFetch");
                        finish(Activity.RESULT_OK, result);
                        return;
                    }
                    String js = "window.__udfUpgradeProbe=null;(async()=>{try{const p=window.Capacitor.Plugins;" +
                      "const info=await p.App.getInfo();const pref=await p.Preferences.get({key:'udf.qa.upgrade.7'});" +
                      "if(info.id!=='com.udf.party'||info.build!=='7'||pref.value!==" + JSONObject.quote(value) + ")throw Error('Bridge identity/preference mismatch');" +
                      "const opened=await p.AppLauncher.openUrl({url:'https://crm.udf-party.co.za/mobile'});" +
                      "window.__udfUpgradeProbe={id:info.id,build:info.build,version:info.version,preference:true,handoff:opened.completed};" +
                      "}catch(e){window.__udfUpgradeProbe={error:String(e)}}})()";
                    evaluate(web, js);
                    String answer = "null";
                    for (int i=0; i<60; i++) {
                        answer = evaluate(web, "window.__udfUpgradeProbe");
                        if (!"null".equals(answer)) break;
                        Thread.sleep(500);
                    }
                    result.putString("bridges", answer);
                } catch (Exception e) { result.putString("bridgeError", e.getClass().getSimpleName() + ": " + e.getMessage()); }
            }
            finish(Activity.RESULT_OK, result);
        } catch (Exception e) {
            result.putString("error", e.getClass().getSimpleName() + ": " + e.getMessage());
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}
'''


def run(*args, env=ENV, timeout=180):
    result = subprocess.run([str(a) for a in args], env=env, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{Path(str(args[0])).name} failed: {result.stdout[-2000:]} {result.stderr[-2000:]}')
    return result.stdout + result.stderr


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_probe():
    OUT.mkdir(parents=True, exist_ok=True)
    source = OUT / 'UpgradeProbe.java'
    source.write_text(SOURCE)
    manifest = OUT / 'AndroidManifest.xml'
    manifest.write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{PACKAGE}">
      <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36"/>
      <application android:label="UDF local upgrade probe" android:allowBackup="false"/>
      <instrumentation android:name="com.udf.qa.UpgradeProbe" android:targetPackage="com.udf.party"/>
    </manifest>''')
    classes = OUT / 'classes'
    dex = OUT / 'dex'
    classes.mkdir(exist_ok=True)
    dex.mkdir(exist_ok=True)
    android = SDK / 'platforms/android-36/android.jar'
    run(JAVA / 'bin/javac', '-source', '8', '-target', '8', '-classpath', android, '-d', classes, source)
    run(TOOLS / 'd8', '--min-api', '26', '--lib', android, '--output', dex, *classes.rglob('*.class'))
    unsigned = OUT / 'probe-unsigned.apk'
    run(TOOLS / 'aapt', 'package', '-f', '-M', manifest, '-I', android, '-F', unsigned)
    with zipfile.ZipFile(unsigned, 'a') as archive:
        archive.write(dex / 'classes.dex', 'classes.dex')
    aligned = OUT / 'probe-aligned.apk'
    run(TOOLS / 'zipalign', '-f', '4', unsigned, aligned)
    # Passwords stay in child environment; never in command arguments or receipts.
    props_path = ROOT / 'frontend/android/keystore.properties'
    if not props_path.exists():
        props_path = ROOT / 'secrets/android/keystore.properties'
    props = dict(line.strip().split('=', 1) for line in props_path.read_text().splitlines()
                 if '=' in line and not line.lstrip().startswith('#'))
    key = ROOT / 'frontend/android' / props['storeFile']
    signed = OUT / 'upgrade-probe.apk'
    run(TOOLS / 'apksigner', 'sign', '--ks', key, '--ks-key-alias', props['keyAlias'],
        '--ks-pass', 'env:QA_STORE_PASS', '--key-pass', 'env:QA_KEY_PASS', '--out', signed, aligned,
        env=dict(ENV, QA_STORE_PASS=props['storePassword'], QA_KEY_PASS=props['keyPassword']))
    for apk in (signed, OLD, NEW):
        signature = run(TOOLS / 'apksigner', 'verify', '--print-certs', apk)
        if re.findall(r'Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)', signature) != [SIGNER]:
            raise RuntimeError('Unexpected signing identity')
    return signed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--execute', action='store_true', help='Run the approved isolated upgrade test')
    modes.add_argument('--check-prompt', action='store_true', help='Check synthetic native popup after a successful upgrade')
    args = parser.parse_args()
    if not args.execute and not args.check_prompt:
        parser.print_help()
        return
    adb = [SDK / 'platform-tools/adb', '-s', 'emulator-5554']
    if not run(*adb, 'emu', 'avd', 'name').startswith('UDF_Release_20260921\n'):
        raise RuntimeError('Refusing non-isolated emulator')
    if digest(OLD) != OLD_HASH:
        raise RuntimeError('Preserved baseline mismatch')
    state = run(*adb, 'shell', 'dumpsys', 'package', 'com.udf.party')
    if args.check_prompt:
        previous = json.loads((OUT / 'receipt.json').read_text())
        if 'versionCode=7 ' not in state or previous['apkSha256'] != digest(NEW):
            raise RuntimeError('Expected the previously verified upgrade')
        signed = build_probe()
        print(run(*adb, 'install', '-r', signed).strip())
        run(*adb, 'shell', 'pm', 'enable', '--user', '0', PACKAGE)
        output = run(*adb, 'shell', 'am', 'instrument', '-w', '-e', 'phase', 'prompt',
                     '-e', 'value', previous['syntheticValue'], COMPONENT)
        (OUT / 'prompt-receipt.json').write_text(json.dumps(dict(apkSha256=digest(NEW),
            syntheticDiscoveryOnly=True, realDownloadClicked=False, output=output), indent=2) + '\n')
        print(output.strip())
        for marker in ('"modal":true', '"focusInside":true', '"notes":true',
                       'INSTRUMENTATION_RESULT: backDismissed=true', 'INSTRUMENTATION_RESULT: deferralHours=24'):
            if marker not in output:
                raise RuntimeError('Native prompt assertion failed: ' + marker)
        print('PASS synthetic native modal, focus, notes, Android Back and 24-hour device deferral')
        return
    if 'versionCode=6 ' not in state:
        raise RuntimeError('Expected existing build 6; never downgrade/wipe/repeat an upgrade implicitly')
    signed = build_probe()
    print(run(*adb, 'install', '-r', OLD).strip())
    print(run(*adb, 'install', '-r', signed).strip())
    run(*adb, 'shell', 'pm', 'enable', '--user', '0', PACKAGE)
    marker = uuid.uuid4().hex
    receipt = dict(avd='UDF_Release_20260921', previousSha256=digest(OLD), apkSha256=digest(NEW),
                   syntheticKey='udf.qa.upgrade.7', syntheticValue=marker,
                   uninstalled=False, appDataCleared=False, authenticatedSessionTested=False,
                   actualReleaseDownloadTested=False)
    receipt_path = OUT / 'receipt.json'
    def save():
        receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    save()
    before = run(*adb, 'shell', 'am', 'instrument', '-w', '-e', 'phase', 'before', '-e', 'value', marker, COMPONENT)
    receipt['before'] = before
    save()
    if 'INSTRUMENTATION_RESULT: preference=stored' not in before or 'INSTRUMENTATION_CODE: -1' not in before:
        raise RuntimeError('Baseline preference probe failed; upgrade not attempted')
    receipt['upgrade'] = run(*adb, 'install', '-r', NEW)
    save()
    if 'Success' not in receipt['upgrade']:
        raise RuntimeError('In-place upgrade refused')
    after = run(*adb, 'shell', 'am', 'instrument', '-w', '-e', 'phase', 'after', '-e', 'value', marker, COMPONENT)
    receipt['after'] = after
    receipt['foreground'] = run(*adb, 'shell', 'dumpsys', 'activity', 'activities')
    # Keep only package-level foreground evidence, never activity extras/session data.
    receipt['foreground'] = '\n'.join(line.strip() for line in receipt['foreground'].splitlines()
                                      if 'mResumedActivity:' in line or 'topResumedActivity=' in line)
    save()
    if 'INSTRUMENTATION_RESULT: preference=retained' not in after or 'INSTRUMENTATION_CODE: -1' not in after:
        raise RuntimeError('Preference retention check failed')
    old_uid = re.search(r'INSTRUMENTATION_RESULT: uid=(\d+)', before)
    new_uid = re.search(r'INSTRUMENTATION_RESULT: uid=(\d+)', after)
    if not old_uid or not new_uid or old_uid[1] != new_uid[1]:
        raise RuntimeError('Package UID changed')
    print('PASS in-place 6 -> 7 upgrade, same UID, synthetic Capacitor preference retained')
    print(after.strip())
    print(receipt['foreground'])
    print('RECEIPT ' + str(receipt_path))


if __name__ == '__main__':
    import sys
    try:
        main()
    finally:
        if any(flag in sys.argv for flag in ('--execute', '--check-prompt')):
            adb = [SDK / 'platform-tools/adb', '-s', 'emulator-5554']
            try:
                if run(*adb, 'emu', 'avd', 'name', timeout=10).startswith('UDF_Release_20260921\n'):
                    run(*adb, 'shell', 'pm', 'disable-user', '--user', '0', PACKAGE, timeout=10)
            except Exception:
                print('Probe cleanup unavailable; confirm the isolated test package is disabled.')
