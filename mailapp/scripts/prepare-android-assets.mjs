#!/usr/bin/env node
/**
 * Prepare the UDF secure-mail Capacitor Android project:
 *   1. copy the shared UDF brand assets (launcher mipmaps + splash) into the
 *      generated android/ project (art is sourced from frontend/resources/android
 *      so both apps stay visually consistent without a second copy in the repo);
 *   2. re-apply the native hardening overrides tracked in android-overrides/
 *      (FLAG_SECURE MainActivity, INTERNET-only manifest, HTTPS-only network
 *      security configs, ProGuard keeps, release signing/minify) — `cap add`
 *      / `cap sync` regenerates a bare project and wipes them every time;
 *   3. pin the API-36-compatible toolchain (same AGP/Gradle as the member app).
 *
 * Run AFTER `npx cap add android` (or `cap sync`), before the gradle build:
 *   node scripts/prepare-android-assets.mjs
 *
 * Safe to re-run; no-ops with a warning if the android project is missing.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');                 // mailapp/
const brandSrc = resolve(appRoot, '..', 'frontend', 'resources', 'android'); // shared UDF art
const androidRoot = join(appRoot, 'android');
const resDir = join(androidRoot, 'app', 'src', 'main', 'res');

if (!existsSync(resDir)) {
  console.warn('[prepare-android-assets] android/ not found. Run `npx cap add android` first.');
  process.exit(0);
}
if (!existsSync(brandSrc)) {
  console.warn(`[prepare-android-assets] brand art source missing: ${brandSrc}`);
}

const mipmaps = {
  'mipmap-mdpi': 'mipmap-mdpi.png',
  'mipmap-hdpi': 'mipmap-hdpi.png',
  'mipmap-xhdpi': 'mipmap-xhdpi.png',
  'mipmap-xxhdpi': 'mipmap-xxhdpi.png',
  'mipmap-xxxhdpi': 'mipmap-xxxhdpi.png',
};

function place(bucketDir, targetName, sourceFile) {
  const dir = join(resDir, bucketDir);
  mkdirSync(dir, { recursive: true });
  const from = join(brandSrc, sourceFile);
  const to = join(dir, targetName);
  if (!existsSync(from)) {
    console.warn(`[prepare-android-assets] missing source: ${from}`);
    return;
  }
  copyFileSync(from, to);
  console.log(`  ✓ ${bucketDir}/${targetName}`);
}

console.log('[prepare-android-assets] installing UDF brand assets…');
for (const [bucket, file] of Object.entries(mipmaps)) {
  place(bucket, 'ic_launcher.png', file);
  place(bucket, 'ic_launcher_round.png', file);
  place(bucket, 'ic_launcher_foreground.png', file.replace('.png', '-foreground.png'));
}
place('drawable', 'splash.png', 'drawable-splash.png');
const splashByOrient = { port: 'drawable-splash.png', land: 'drawable-splash-land.png' };
for (const [orient, source] of Object.entries(splashByOrient)) {
  for (const dpi of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    place(`drawable-${orient}-${dpi}`, 'splash.png', source);
  }
}
place('drawable', 'notification_big_picture.png', 'drawable-notification.png');

writeFileSync(
  join(resDir, 'values', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#C8102E</color>\n</resources>\n`,
);
console.log('  ✓ values/ic_launcher_background.xml (#C8102E)');

// ── Native hardening overrides ──────────────────────────────────────────────
const overridesRoot = join(appRoot, 'android-overrides');
const overrides = [
  ['MainActivity.java', 'app/src/main/java/com/udf/mail/MainActivity.java'],
  ['AndroidManifest.xml', 'app/src/main/AndroidManifest.xml'],
  ['app-build.gradle', 'app/build.gradle'],
  ['proguard-rules.pro', 'app/proguard-rules.pro'],
  ['network_security_config.main.xml', 'app/src/main/res/xml/network_security_config.xml'],
  ['network_security_config.release.xml', 'app/src/release/res/xml/network_security_config.xml'],
  ['keystore.properties.example', 'keystore.properties.example'],
];
if (existsSync(overridesRoot)) {
  console.log('[prepare-android-assets] applying native hardening overrides…');
  for (const [srcName, destRel] of overrides) {
    const from = join(overridesRoot, srcName);
    const to = join(androidRoot, destRel);
    if (!existsSync(from)) { console.warn(`  ! missing override source: ${srcName}`); continue; }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log(`  ✓ ${destRel}`);
  }
} else {
  console.warn('[prepare-android-assets] android-overrides/ not found; hardening NOT applied.');
}

function updateAndroidConfig(relativePath, changes) {
  const path = join(androidRoot, relativePath);
  const original = readFileSync(path, 'utf8');
  let updated = original;
  for (const [pattern, replacement] of changes) {
    if ((updated.match(pattern) ?? []).length !== 1) {
      throw new Error(`Expected one toolchain setting in ${relativePath}: ${pattern}`);
    }
    updated = updated.replace(pattern, replacement);
  }
  if (updated !== original) writeFileSync(path, updated);
}
updateAndroidConfig('variables.gradle', [
  [/compileSdkVersion\s*=\s*\d+/g, 'compileSdkVersion = 36'],
  [/targetSdkVersion\s*=\s*\d+/g, 'targetSdkVersion = 36'],
]);
updateAndroidConfig('build.gradle', [
  [/com\.android\.tools\.build:gradle:[\d.]+/g, 'com.android.tools.build:gradle:8.10.1'],
]);
updateAndroidConfig('gradle/wrapper/gradle-wrapper.properties', [
  [/^distributionUrl=.+$/gm, 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.11.1-bin.zip'],
]);
const wrapperPath = join(androidRoot, 'gradle/wrapper/gradle-wrapper.properties');
const wrapper = readFileSync(wrapperPath, 'utf8');
const checksum = 'distributionSha256Sum=f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6';
writeFileSync(wrapperPath, /^distributionSha256Sum=/m.test(wrapper)
  ? wrapper.replace(/^distributionSha256Sum=.+$/m, checksum)
  : `${wrapper.trimEnd()}\n${checksum}\n`);
console.log('  ✓ API 36, Android Gradle Plugin 8.10.1, Gradle 8.11.1 (checksum pinned)');
console.log('[prepare-android-assets] done.');
