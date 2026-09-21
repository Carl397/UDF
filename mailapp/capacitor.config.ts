import type { CapacitorConfig } from '@capacitor/cli';

/**
 * UDF councillor secure-mail shell.
 *
 * Unlike the member app (com.udf.party), this is NOT a bundled web app: it is a
 * hardened WebView pointed straight at the already-deployed, already-branded
 * UDF webmail (Roundcube at https://mail.udf-party.co.za). `server.url` makes
 * Capacitor load that remote origin directly. The local `www` provides the
 * packaged loader; remote-page availability still requires network access.
 *
 * Native hardening is applied by scripts/prepare-android-assets.mjs:
 *   • FLAG_SECURE         — blocks normal Android screenshots, recording and
 *                           non-secure display capture; it does not protect
 *                           against a compromised device or external camera.
 *   • INTERNET-only       — the only Android platform permission requested;
 *                           AndroidX also adds a signature-level receiver guard.
 *                           The manifest grants no camera, microphone, location
 *                           or storage permission (least privilege for a mail
 *                           client; attachments use the OS picker, not a
 *                           granted permission).
 *   • HTTPS-only          — release network security config forbids cleartext and
 *                           trusts only the Android system CA store; webmail runs
 *                           on a public Let's Encrypt certificate.
 *   • non-debuggable +    — release build is minified, resource-shrunk and signed
 *     R8 + upload key       with the same CN=UDF Party Upload key as the member
 *                           app, but a distinct applicationId (com.udf.mail).
 *
 * HTTPS and the native network security config prohibit cleartext traffic.
 * Persistent server cookies are stored in the app-private WebView cookie jar;
 * MainActivity flushes them on pause. The fixed 30-day lifetime and revocation
 * are enforced by the server plugin installed by configure-mail-sessions.sh.
 * End-to-end persistence requires that server policy to be active and tested.
 */
const config: CapacitorConfig = {
  appId: 'com.udf.mail',
  appName: 'Mail - UDF Party (Secure)',
  webDir: 'www',
  server: {
    url: 'https://mail.udf-party.co.za',
    androidScheme: 'https',
    // Only the webmail origin is trusted for in-app navigation; anything else is
    // an external link. No allowlist of additional hosts.
    allowNavigation: [],
  },
  backgroundColor: '#000000',
  plugins: {
    SplashScreen: {
      launchShowDuration: 2500,
      backgroundColor: '#000000',
      androidSplashResourceName: 'splash',
      // FIT_CENTER, not CENTER_CROP: the poster must be shown whole.
      androidScaleType: 'FIT_CENTER',
      splashFullScreen: true,
      splashImmersive: true,
      showSpinner: true,
      spinnerColor: '#C8102E',
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#C8102E',
    },
  },
};

export default config;
