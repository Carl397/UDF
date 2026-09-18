#!/usr/bin/env node
/**
 * Copies UDF brand assets (app icon mipmaps + splash/notification drawables)
 * from resources/android into the generated Capacitor Android project.
 *
 * Run AFTER `npx cap add android` (or `cap sync`), before gradle build:
 *   node scripts/prepare-android-assets.mjs
 *
 * Safe to re-run; no-ops with a warning if the android project is missing.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const src = join(frontendRoot, 'resources', 'android');
const resDir = join(
  frontendRoot,
  'android',
  'app',
  'src',
  'main',
  'res',
);

if (!existsSync(resDir)) {
  console.warn(
    '[prepare-android-assets] android/ project not found. Run `npx cap add android` first.',
  );
  process.exit(0);
}

/** mipmap density bucket -> source file */
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
  const from = join(src, sourceFile);
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
  // The adaptive foreground is a DIFFERENT asset from the legacy icon: a 108dp
  // canvas with the art inset into the centre 72dp safe zone and a transparent
  // surround. Reusing the legacy icon here is what made the launcher icon look
  // cropped/zoomed, because the mask trims the outer third of full-bleed art.
  place(bucket, 'ic_launcher_foreground.png', file.replace('.png', '-foreground.png'));
}

// Splash: Capacitor SplashScreen plugin looks for res/drawable/splash.png
place('drawable', 'splash.png', 'drawable-splash.png');
// The template ships default splash art in orientation/density buckets that
// override res/drawable on devices — replace every one of them, and give each
// orientation the matching aspect ratio so neither one is stretched.
const splashByOrient = {
  port: 'drawable-splash.png',
  land: 'drawable-splash-land.png',
};
for (const [orient, source] of Object.entries(splashByOrient)) {
  for (const dpi of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    place(`drawable-${orient}-${dpi}`, 'splash.png', source);
  }
}
// Push-notification big picture (FCM image), referenced by native code/FCM payload.
place('drawable', 'notification_big_picture.png', 'drawable-notification.png');

// Brand the adaptive-icon (API 26+) background to UDF brand red.
writeFileSync(
  join(resDir, 'values', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#C8102E</color>\n</resources>\n`,
);
console.log('  ✓ values/ic_launcher_background.xml (#C8102E)');

// ── Native hardening overrides ──────────────────────────────────────────────
// `npx cap add android` regenerates the native project from scratch and wipes
// the UDF security customizations (FLAG_SECURE MainActivity, manifest
// permissions, debug/release network security configs, release signing/minify,
// ProGuard keeps). Those files are tracked in git under ../android-overrides
// and re-applied here so CI debug/release builds are always hardened.
// See android-overrides/README.md.
const androidRoot = join(frontendRoot, 'android');
const overridesRoot = join(frontendRoot, 'android-overrides');

/** override source file (in android-overrides/) -> dest inside android/. */
const overrides = [
  // NOTE: MainActivity dest assumes appId `com.udf.party` (pinned in
  // capacitor.config.ts). If the appId changes, update this path + the
  // `package` line in android-overrides/MainActivity.java.
  ['MainActivity.java', 'app/src/main/java/com/udf/party/MainActivity.java'],
  ['AndroidManifest.xml', 'app/src/main/AndroidManifest.xml'],
  ['app-build.gradle', 'app/build.gradle'],
  ['proguard-rules.pro', 'app/proguard-rules.pro'],
  [
    'network_security_config.main.xml',
    'app/src/main/res/xml/network_security_config.xml',
  ],
  [
    'network_security_config.release.xml',
    'app/src/release/res/xml/network_security_config.xml',
  ],
  ['keystore.properties.example', 'keystore.properties.example'],
];

if (existsSync(overridesRoot)) {
  console.log('[prepare-android-assets] applying native hardening overrides…');
  for (const [srcName, destRel] of overrides) {
    const from = join(overridesRoot, srcName);
    const to = join(androidRoot, destRel);
    if (!existsSync(from)) {
      console.warn(`  ! missing override source: ${srcName}`);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log(`  ✓ ${destRel}`);
  }
} else {
  console.warn(
    '[prepare-android-assets] android-overrides/ not found; native hardening NOT applied.',
  );
}

console.log('[prepare-android-assets] done.');
