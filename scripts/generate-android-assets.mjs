#!/usr/bin/env node
/**
 * Generates Android app icon mipmaps and splash screens from the UDF brand art.
 *
 * Sources (resources/brand-src/):
 *   udf-illustration.png  — square protest-art mark, used for app icons
 *   president-poster.jpg  — campaign poster, used for the splash screen
 *
 * Everything is scaled to FIT (contain), never cropped: the artwork is
 * full-bleed, so any cover/crop resize eats into the flag and faces and the
 * result reads as an arbitrary zoom rather than a logo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(resolve(fileURLToPath(import.meta.url)), '..');
const root = resolve(here, '..');
const brandSrc = join(root, 'resources', 'brand-src');
const iconSrc = join(brandSrc, 'udf-illustration.png');
const splashSrc = join(brandSrc, 'president-poster.jpg');

for (const [label, path] of [['icon', iconSrc], ['splash', splashSrc]]) {
  if (!existsSync(path)) {
    console.error(`Missing ${label} source:`, path);
    process.exit(1);
  }
}

const androidDir = join(root, 'frontend', 'resources', 'android');
mkdirSync(androidDir, { recursive: true });
// NOTE: output goes to frontend/resources/android because that is the ONLY
// directory frontend/scripts/prepare-android-assets.mjs reads when installing
// into the native project. A stale duplicate exists at <root>/resources/android;
// writing there silently ships the previous artwork.

const RED = '#C8102E'; // UDF brand red — legacy icon + adaptive background
const SPLASH_BG = 'black'; // poster corners are pure black, so bars blend in

/** Fit `src` inside WxH without cropping, padding with `bg`. */
function fit(src, w, h, bg, out, extra = []) {
  execFileSync(
    'magick',
    [src, '-resize', `${w}x${h}`, '-background', bg, '-gravity', 'center', '-extent', `${w}x${h}`, ...extra, out],
    { stdio: 'pipe' },
  );
}

// ── Legacy launcher icons (pre-API 26) ───────────────────────────────────────
// Square canvas, artwork inset to 80% so nothing touches the edge that the
// launcher's own shape mask may round off.
const legacySizes = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};

console.log('[generate-android-assets] legacy launcher icons (fit, 80% inset)…');
for (const [bucket, size] of Object.entries(legacySizes)) {
  const inner = Math.round(size * 0.8);
  const out = join(androidDir, `${bucket}.png`);
  // Resize to the inset size, then extent to the EXACT bucket size. Using
  // -border instead would round the padding up and yield 97px for a 96px
  // bucket, which Android treats as a mismatched density asset.
  execFileSync(
    'magick',
    [iconSrc, '-resize', `${inner}x${inner}`, '-background', RED, '-gravity', 'center', '-extent', `${size}x${size}`, out],
    { stdio: 'pipe' },
  );
  console.log(`  ✓ ${bucket}.png (${size}×${size}, art ${inner}px)`);
}

// ── Adaptive icon foreground (API 26+) ───────────────────────────────────────
// The adaptive canvas is 108dp but only the centre 72dp is guaranteed visible;
// launchers crop and parallax-zoom the rest. Art must therefore sit inside that
// 66% safe zone on a TRANSPARENT canvas, or it gets visibly cut off.
const foregroundSizes = {
  'mipmap-mdpi': 108,
  'mipmap-hdpi': 162,
  'mipmap-xhdpi': 216,
  'mipmap-xxhdpi': 324,
  'mipmap-xxxhdpi': 432,
};

console.log('[generate-android-assets] adaptive foregrounds (fit in 66% safe zone)…');
for (const [bucket, size] of Object.entries(foregroundSizes)) {
  const safe = Math.round(size * (72 / 108));
  const out = join(androidDir, `${bucket}-foreground.png`);
  execFileSync(
    'magick',
    [iconSrc, '-resize', `${safe}x${safe}`, '-background', 'none', '-gravity', 'center', '-extent', `${size}x${size}`, out],
    { stdio: 'pipe' },
  );
  console.log(`  ✓ ${bucket}-foreground.png (${size}×${size}, art ${safe}px)`);
}

// ── Splash screens (campaign poster, letterboxed) ────────────────────────────
// Pre-letterboxing to the exact target aspect means the launch-theme window
// background — which stretches its bitmap to fill and ignores scale type —
// still renders undistorted on a matching device.
console.log('[generate-android-assets] splash screens (fit, black bars)…');
const splashPort = join(androidDir, 'drawable-splash.png');
fit(splashSrc, 1080, 1920, SPLASH_BG, splashPort);
console.log('  ✓ drawable-splash.png (1080×1920 portrait)');

const splashLand = join(androidDir, 'drawable-splash-land.png');
fit(splashSrc, 1920, 1080, SPLASH_BG, splashLand);
console.log('  ✓ drawable-splash-land.png (1920×1080 landscape)');

// ── Notification big picture ─────────────────────────────────────────────────
const notifOut = join(androidDir, 'drawable-notification.png');
fit(iconSrc, 1200, 800, RED, notifOut);
console.log('  ✓ drawable-notification.png (1200×800)');

console.log('[generate-android-assets] done. Run `node frontend/scripts/prepare-android-assets.mjs` to install.');
