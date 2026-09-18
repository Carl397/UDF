# Android native hardening overrides

`frontend/android/` is a **generated** Capacitor project and is git-ignored
(see the root `.gitignore`). CI recreates it from scratch on every build with
`npx cap add android`, which produces a *bare* shell and wipes any direct
edits — including UDF's security hardening.

This directory is the **tracked source of truth** for those customizations.
`frontend/scripts/prepare-android-assets.mjs` copies each file below into the
generated project after `cap add` / `cap sync`, so debug **and** release builds
are always hardened.

| Override file | Applied to (inside `frontend/android/`) | Why |
| --- | --- | --- |
| `MainActivity.java` | `app/src/main/java/com/udf/party/MainActivity.java` | `FLAG_SECURE` — blocks screenshots / screen recording / casting / recent-apps thumbnail so member PII can't be captured. |
| `AndroidManifest.xml` | `app/src/main/AndroidManifest.xml` | `allowBackup=false`, network-security-config ref, least-privilege runtime permissions (location/camera/audio/media) + optional hardware features. |
| `app-build.gradle` | `app/build.gradle` | Release: `debuggable false`, `minifyEnabled`, `shrinkResources`, keystore-based signing loaded from git-ignored `keystore.properties`. |
| `proguard-rules.pro` | `app/proguard-rules.pro` | Keep rules for the Capacitor WebView JS↔native bridge + FileProvider so R8 shrinking doesn't break the app. |
| `network_security_config.main.xml` | `app/src/main/res/xml/network_security_config.xml` | Debug/default: cleartext allowed for a local backend; HTTPS uses the Android system CA store. |
| `network_security_config.release.xml` | `app/src/release/res/xml/network_security_config.xml` | Release: HTTPS-only (`cleartextTrafficPermitted=false`) and Android system CA trust only. |
| `keystore.properties.example` | `keystore.properties.example` | Template for release signing config (the real `keystore.properties` stays git-ignored). |

## Rules

- **Never edit `frontend/android/` directly** — it is regenerated and your
  changes will be lost. Edit the override here; the prepare script re-applies it.
- The `MainActivity.java` destination assumes `appId: com.udf.party` (pinned in
  `frontend/capacitor.config.ts`). If the appId ever changes, update the path in
  `prepare-android-assets.mjs` and the `package` line in `MainActivity.java`.
- On a **Capacitor major upgrade**, run a fresh `npx cap add android` in a
  scratch copy and diff its `build.gradle` / `AndroidManifest.xml` against these
  overrides, so upstream template improvements aren't clobbered.
- Production APKs target `https://crm.udf-party.co.za/api` and trust the Android
  system CA store. The retained `udf_tls_ca.pem` documents the legacy IP build
  but is no longer copied into new APKs.
- Existing fielded APKs that target the IP keep using their already-bundled trust
  anchor while the server preserves the legacy IP vhost.
