# UDF production release progress

Last updated: 2026-09-19. Overall status: PERMISSION LABEL FRONTEND DEPLOYMENT COMPLETE. Frontend release `udf-20260919T023411Z`, source commit `1e6974584f1d50101cab0ebe39f919d408156616`, is live at `https://crm.udf-party.co.za/crm/users/` and `/crm/settings/`. Public artifact/source/HTML/JS/CSS verification passed 597 checks with 0 failures. Backend remains on Resident Reports release `udf-20260919T021239Z` with migration 030; API/database, mail services, and Android/Play were not changed. Signed-in browser acceptance remains blocked by login.

## Permission label frontend deployment (2026-09-19)
- User requested deployment of descriptive permission labels. Existing commit `1e6974584f1d50101cab0ebe39f919d408156616` contains the four source/test changes; working tree was clean. No new application commit or Git push was made. Labels change presentation only; permission identifiers and grants/revocations are unchanged.
- Candidate `udf-20260919T023411Z` built from the exact commit with same-origin `/api`. The release helper now supports frontend-only builds; no backend archive, Android sync/build, or migration was run. Static export generated 40 pages; type/lint/capability checks passed with the same six existing lint warnings. The unchanged label source previously passed 14 client regression tests and targeted lint/TypeScript checks.
- Artifact/source verification: 562 checks passed, 0 failures. Frontend SHA-256: `25a672ab3bba0dc417e60882bdece851b5524745fd4ce97ed7ee3e868ddf95d8`. Latest receipt: `.tmp-verify/release-latest.json`; immutable manifest: `.tmp-verify/udf-20260919T023411Z/artifacts/release.json`.
- Read-only production preflight passed: SSH, API/nginx/mail services active, API restart count 0, 15 GB free. Before deployment, Users/Settings HTML hashes matched the prior Resident Reports frozen output.
- DEPLOYED: frontend archive, manifest, checksums, and release-specific script uploaded and hash-verified under `/root/udf-releases/udf-20260919T023411Z/`. `deploy-permission-labels.sh` SHA-256: `4663b38331df94e8ee6f82dbbee4f3551c4c2edd5c78e503ccd5ac7ae874f5bd`; shell syntax passed locally and remotely. Unit `udf-web-release-20260919T023411Z.service` completed with `Result=success`, `ExecMainStatus=0`, `ActiveState=active`, `SubState=exited`; completion journal time `2026-09-19 04:38:11` and `DEPLOYED` marker confirmed. Do NOT rerun this completed unit/script or historical deployment scripts.
- Protected frontend backup: `/var/backups/udf/udf-20260919T023411Z/frontend.tar.gz` (9,999,144 bytes), directory mode 700 and archive mode 600; archive readability passed. Previous frontend retained at `/var/www/udf/frontend.previous-udf-20260919T023411Z`. Every prior content-addressed browser asset was preserved and compared byte-for-byte before cutover. No database backup/restore or migration was needed for this frontend-only update.
- Verification: six public routes (`/`, `/crm/`, `/crm/patrols/`, `/crm/resident-reports/`, `/crm/users/`, `/crm/settings/`) and their 29 referenced assets match release output byte-for-byte. Representative descriptive labels are present in the served JavaScript. User/role endpoints still require authentication (401 without credentials); API/database health passed. Independent off-server verifier: 597 checks passed, 0 failed.
- API/nginx/mail process IDs, restart counts, and active timestamps matched before/after; no service was restarted. API PID remains unchanged with restart count 0 and no error-priority journal entries since cutover. Backend entrypoint/package hashes also matched; uploads, configuration, database, signing keys, and Android/Play artifacts were untouched.
- Browser limitation: ordinary navigation to the release-qualified Users page redirected to `/login/`; no usable authorized staff session exists. No authentication bypass or live user/permission mutations were performed. Actual checkbox rendering/layout/runtime remain UNVERIFIED. NEXT: sign in normally, refresh Users & Roles, and perform read-only label acceptance. No redeployment is needed.
- Repository follow-up: deployment progress and the new deployment script remain uncommitted; application source stays at the existing `1e69745` commit. No new commit or Git push was performed.

## Resident Reports production deployment (2026-09-19)
- COMPLETE: user explicitly requested production deployment of the Resident Reports changes and approved a scoped local commit. Commit `947dc46337b3feb229e9ffce5c0cdd74824bc191` contains 20 related source/test files and migration 030. No Git push, Android rebuild, or Play upload is included.
- Frozen candidate `udf-20260919T021239Z` was built from that exact Git commit, excluding unrelated staged/working Android changes. Backend build, 40-page static export, type/lint checks and capability guard passed; the same six existing lint warnings remain.
- Historical immutable manifest: `.tmp-verify/udf-20260919T021239Z/artifacts/release.json` (the latest-receipt pointer now identifies the permission-label candidate above). Backend SHA-256 `993e31cb9da52e14dd72c51ef96f68be1a5866ce590a9a5c8e0b819369c04c44`; frontend SHA-256 `6ae3a1eb5a9badf975a5f7b60930365960a1dc4a4064374369c95e81632b2623`.
- Artifact/frozen-source/committed-source verification: 561 checks passed, 0 failed. Deployment script syntax passed; `deploy-resident-reports.sh` SHA-256 `dca3aae224e19bdc385a351e0c58bc472cc3e8a8b16fe0360c64ba04add5e2c3`.
- Read-only production preflight passed: SSH access, API/database health, nginx and all three mail services active; 15 GB free; migration 029 was latest before deployment.
- DEPLOYED: archives and script were uploaded and hash-verified under `/root/udf-releases/udf-20260919T021239Z/`. Unit `udf-release-20260919T021239Z.service` completed with `Result=success`, `ExecMainStatus=0`, `ActiveState=active`, `SubState=exited`; the `DEPLOYED` marker is present. Server journal completion time: `2026-09-19 04:16:57`. Do NOT rerun this unit or either completed deployment script.
- Backups: `/var/backups/udf/udf-20260919T021239Z/` (17 MB), directory mode 700 and database dump mode 600. Database dump plus backend/frontend/config archive readability passed before cutover. A full restore drill and off-box backup transfer were not performed.
- ONLY migration `030_resident_report_management.sql` and its ledger entry were applied transactionally; the ledger was independently rechecked. User/member/report/event/media row counts matched before/after migration while the API was stopped. Uploads compare identically with the retained previous application.
- Previous directories retained: `/opt/udf/backend.previous-udf-20260919T021239Z` and `/var/www/udf/frontend.previous-udf-20260919T021239Z`. Old content-addressed web assets were preserved for existing tabs. nginx/mail configuration and services were not changed; all remain active.
- Post-deployment verification: `node .tmp-verify/release.mjs verify https://crm.udf-party.co.za` passed 591 checks, 0 failures, including committed/frozen source and byte-identical public HTML/JS/CSS for `/`, `/crm/`, `/crm/patrols/`, and `/crm/resident-reports/`. New report endpoints require authentication (401 without credentials). API/database health passed; API restart count 0 and no error-priority journal entries since cutover.
- Browser limitation: ordinary release-qualified Resident Reports navigation redirected to `/login/`; no usable signed-in session was available. No login bypass or live report/task mutations were performed. Tabs, filters, counts, and authenticated browser runtime remain UNVERIFIED. NEXT: sign in normally with an authorized staff account, then perform read-only browser acceptance checks. Do not redeploy or rebuild on a generic continuation.

## Repository follow-up (2026-09-19)
- User requested a commit of the remaining staged Android release setup, verification receipts/scripts, and latest production deployment script/record. JavaScript, shell, and Python syntax checks, JSON validation, and staged whitespace checks passed. Signing keys, signing properties, and the private secrets directory remain ignored and untracked.
- This repository-only follow-up does not change the deployed source commit `947dc46`. No Git push, production redeployment, Android rebuild, signing-key generation, or Play publication is part of this request.

## Google Play release (new request, 2026-09-18)
- IN PROGRESS: user requested a Play release and explicitly approved a NEW upload key for the FIRST Play release of `com.udf.party`, plus an L3 deep review. That review returned no findings before the build-configuration changes; it is not a claim that later changes were reviewed.
- New upload key generated locally, encrypted, with owner-only permissions under the ignored `secrets/android/` directory. Never regenerate/overwrite it on continuation. No passwords or private key contents are recorded here. User must securely back up that directory outside this machine before publishing.
- Candidate: versionName `1.0.2`, versionCode `3`; signed APK plus AAB requested. Earlier debug APK/receipts remain preserved.
- BUILD SUCCESSFUL: `assembleRelease` + `bundleRelease` + `dumpReleaseManifest` completed (345 Gradle tasks). `verify-apk.py release` passed: APK/AAB identity, API 36 target, approved upload signer, non-debuggable, HTTPS-only network config, no broad media permissions, 168 web assets verified in both archives, production API baked, APK zip-alignment verified, R8 mapping preserved. Receipt: `deploy/release-progress/play-release-build.json`.
- Artifacts: `frontend/android/app/build/outputs/apk/release/app-release.apk` (30.05 MB), `frontend/android/app/build/outputs/bundle/release/app-release.aab` (30.66 MB), R8 mapping at `frontend/android/app/build/outputs/mapping/release/mapping.txt` (12.7 MB). Upload key and public certificate at `secrets/android/` (owner-only permissions, git-ignored).
- Upload certificate SHA-256: `0744136ba322327792b70495877024a9238e08e218418ea939577a4adb66d797`. Play App Signing requires the public certificate (`secrets/android/udf-upload-certificate.pem`) to be uploaded to Play Console; the private key stays local.
- Outstanding: Play Console upload/publication, device installation/runtime testing, and user backup of `secrets/android/` (key + properties + certificate). The connected emulator already has UDF installed with the debug signer, so it cannot install this release in place; a clean emulator or real device is required for runtime testing.
- Official Play requirements checked: https://support.google.com/googleplay/android-developer/answer/11926878 — new submissions require API 36 starting August 31, 2026. Installed SDK 36 and JDK 17 verified. Preparation script now pins API 36, AGP 8.10.1, Gradle 8.11.1 with official distribution checksum; native inset handling added for API 35+; unnecessary broad media permissions removed (existing system pickers retained).
- Current Git state supersedes the old no-repository blocker below: `/Users/why/UDF` is now a repository at `fa8d376`. This session did not initialize Git or make a commit. Preexisting release-progress edits/untracked receipts are preserved.
- No Play Console upload/publication, production deployment, device install, or runtime test has occurred in this request.

## Earlier continuation check (2026-09-19, before Resident Reports deployment)
The commit/deployment observations in this historical subsection are superseded by the completed Resident Reports deployment above. Android artifact observations remain applicable.
- Play-release preparation paused when the user redirected to Resident Reports status. The read-only Play Console browser check was canceled; account access, upload, and publication remain unverified. No rebuild, install, commit, deployment, or upload was performed.
- Current AAB and R8 mapping SHA-256 values match `play-release-build.json`. The release APK is MISSING at its recorded path, although output metadata remains. Do not claim it is currently available or overwrite the historical build receipt. Debug APK SHA-256 still matches `apk-build.json`.
- Upload key directory and files remain owner-only and git-ignored; the public upload certificate fingerprint matches the receipt. Off-machine backup is still unconfirmed. ADB currently lists no connected devices, superseding the earlier connected-emulator observation.
- Resident Reports management changes are present locally and uncommitted, including migration `030_resident_report_management.sql`, C3 assessment, acknowledgment/action evidence, ward/councillor summaries, task assignment and deadlines, filters, pagination, and filtered CSV export.
- Current-code checks PASSED: backend TypeScript, frontend TypeScript (`--incremental false`), backend workflow regression (39 passed, 0 failed; fixtures rolled back), and network-free client workflow regression (12 passed). These are not browser/device acceptance checks or proof of production deployment.
- The recorded production release covers migrations through 029. Deployment of the new Resident Reports changes/migration 030 and inclusion in a new Android artifact have not been established. Preserve existing unrelated working-tree changes; do not assume the earlier Play bundle contains them.

## Resume protocol
On a request such as "proceed", "proceed where last", or "continue", read this file first, validate the recorded state against current artifacts/tools, and resume the first unfinished item. Update this file after each meaningful result and before handing off. Do not repeat completed checks unless the code/artifact changed. Never treat an unverified check as passing or a continuation request as permission to bypass a blocker. Keep credentials, tokens, private keys, and personal data out of this folder.

## Previous CRM release identity (2026-09-18)
- Candidate: `udf-20260918T035445Z` (superseded by the Resident Reports release above).
- Historical manifest: `.tmp-verify/udf-20260918T035445Z/artifacts/release.json` (the latest-receipt pointer now refers to the Resident Reports candidate above).
- Frozen source: `.tmp-verify/udf-20260918T035445Z/source/`.
- Artifacts: `.tmp-verify/udf-20260918T035445Z/artifacts/`.
- Recorded backend SHA-256: `8e7387c98e1d2646425e777bd5dbfb382d8787155551aa570365bf52a5d932a7`.
- Recorded frontend SHA-256: `b77e9f6d45cfd6392ef5a51d3d03dcafb812442a55e6b201676c2d3c42ac2ff2`.
- VERIFIED: both artifact hashes match the receipt; every manifest-listed frozen and working source file matches its recorded hash. `/`, `/crm/`, `/crm/patrols/` HTML and their referenced JavaScript/CSS match frozen output byte-for-byte. `.tmp-verify/release.mjs verify` completed with 0 failures.
- Verification helper now supports a read-only `verify` mode; it does not modify release artifacts or application/authentication state.
- Browser verification origin: `http://localhost:3000`; existing session/tab only.

## Previous CRM / Android checklist
- [x] Establish durable release progress and resume instructions.
- [x] Region and Subcouncil viewport sheets visibly render; Subcouncil Wards heading.
- [x] Ward 9 inner scroll shows `SUBURBS — TAP TO VIEW DETAILS`.
- [x] Child drill/back, including Ward 9 to Bellville Landfill and back.
- [x] Region Close, map Reset with no modal, and Enter on map shape passed earlier.
- [x] Full-page floating-pill anomaly isolated to screenshot capture: viewport before/after and unchanged runtime geometry show full sheet/scrim. No observed viewport rendering defect; no CSS change made.
- [ ] Ward Close: two automation timeouts; interaction remains UNVERIFIED. Do not fake a click through script.
- [x] Dashboard `/crm/?release=udf-20260918T035445Z` renders in the existing session: 4 active members, other totals zero, activity empty states. Query navigation bypasses the observed cached-URL redirect loop; bare `/crm/` browser behavior remains UNVERIFIED. Three initial 401 console errors were followed by automatic refresh 200 and dashboard retry 200; no runtime exception observed. Screenshot then failed because browser view was hidden/unattached.
- [ ] Patrol `/crm/patrols/`: not visited after navigation failure; empty state/statistics/pagination/runtime checks UNVERIFIED.
- [ ] Filter reset intentionally UNVERIFIED; do not retry known unresponsive native empty-option automation.
- [x] Confirm artifact hashes, manifest-listed source consistency, and serving provenance: 0 failures.
- [x] Backend/frontend TypeScript checks passed; frontend lint passed with 6 warnings (campaign hook dependency, 3 image warnings, ID-card assets memoization, rating categories memoization).
- [x] User approved the L3 deep review; it returned no findings. No Git repository was initialized and no commit was made. User subsequently confirmed proceeding with CRM deployment.
- [x] Read-only production preflight: SSH works, `udf-api` active, local health endpoint returns HTTP 200 with `status: ok` and `db: true`, 15 GB disk available.
- [x] Production started with migrations 001–026. Applied 027–029 and their ledger entries in one transaction after taking backups; independently rechecked all three ledger entries after deployment.
- [x] Production patrol-status compatibility check: zero incompatible rows.
- [x] Uploaded and verified archives and deployment script at `/root/udf-releases/udf-20260918T035445Z/`.
- [x] Deployment service `udf-release-20260918T035445Z.service` completed: `Result=success`, `ExecMainStatus=0`, `ActiveState=active`, `SubState=exited`. Do NOT rerun it; its deployed marker and existing-path guards intentionally prevent duplicate deployment.
- [x] Protected backups confirmed at `/var/backups/udf/udf-20260918T035445Z/` (16 MB): database dump, backend, frontend, and configuration archives. Archive listing and database-dump listing passed; a full restore drill was NOT performed.
- [x] Public `/`, `/crm/`, `/crm/patrols/` return HTTP 200 over valid HTTPS and match frozen release HTML. Referenced JavaScript/CSS also match byte-for-byte from the operator machine. `node .tmp-verify/release.mjs verify https://crm.udf-party.co.za`: 572 integrity checks passed, 0 failed.
- [x] API running, database healthy, service restart count 0; no error-priority API journal entries since cutover. This does not replace authenticated browser runtime verification.
- [x] Old/current uploads compare identically after cutover. nginx, postfix, dovecot and opendkim all remain active; configuration was not changed.
- [x] Rebuild Android web assets targeting `https://crm.udf-party.co.za/api`: optimized build and 40 static pages completed; capability guard passed; same 6 lint warnings.
- [x] `cap:sync` completed; fresh web assets copied into `frontend/android/app/src/main/assets/public`; 7 Capacitor plugins synced; `android:assets` reapplied tracked branding and native hardening overrides.
- [x] Open `/Users/why/UDF/frontend/android` in Android Studio.
- [x] Build user-selected DEBUG TEST APK 1.0.1 (2): `:app:assembleDebug` completed successfully in 22 seconds (174 tasks; 38 executed, 136 up-to-date). Android Studio UI inspection again failed with Apple Event `-609`; the actual build used the same Android project and Gradle wrapper via CLI with installed Homebrew JDK 17. No toolchain upgrade or signing-key change.
- [x] Record old APK 1.0 (1) signing identity and hash in `deploy/release-progress/apk-baseline.json` using `verify-apk.py baseline`. Preserve this receipt; do not overwrite it with the new APK.
- [x] Tracked native override and generated app configuration use versionCode `2`, versionName `1.0.1`; new APK manifest and output metadata independently confirm that version and `com.udf.party` debug identity.
- Previous artifact was debug version 1.0 (1); its identity is retained in `apk-baseline.json`. `frontend/android/keystore.properties` remains absent. Production signing requires the existing release key/configuration or an explicit alternative decision.
- [x] `verify-apk.py verify` passed: APK v2 signature valid, same signer as the previous local APK, version increment confirmed, ZIP integrity passed, 168 packaged web files byte-identical to `frontend/out` and synced assets, bundled production API `https://crm.udf-party.co.za/api`, no remote Capacitor `server.url`. Exact artifact path/hash are recorded below and in `apk-build.json`.
- [ ] Device installation, upgrade on an actual device, and native/runtime smoke tests NOT performed. Same-signer compatibility is verified only against the prior local APK, not an unknown installed copy.

## Current blockers and next actions
1. Query-string ordinary navigation enabled dashboard verification without manual authentication/storage edits. Bare-route browser verification, patrol UI checks, and Ward Close remain unverified because browser availability/control is unreliable; do not turn these into false passes.
2. Requested APK update/build is COMPLETE. Provide the verified debug APK below; do not rebuild it on a generic continuation unless inputs changed or a new build is requested. Device installation/runtime testing and distribution were not performed; obtain appropriate direction before those actions.
3. CRM deployment is COMPLETE. Do not redeploy on a generic continuation request. Remaining browser verification requires restored browser control. The deployment preserved uploads and old content-addressed frontend assets, retained previous application directories, and made no nginx/mail configuration changes or reset/seed operations. APK work did not mutate production.
4. Historical repository blocker is superseded: the existing workspace repository was used, and the user-approved scoped Resident Reports commit is `947dc46`. No Git initialization or push was performed. Preserve unrelated staged/working changes; do not make further commits or repeat the canceled broad repository search without direction.
5. Earlier user selection was DEBUG TESTING APK. That completed artifact remains debug-only. The subsequent first-Play-release request and NEW upload-key approval are tracked in the Google Play section above; do not conflate the two signing identities.

## Completed Android artifact
- APK: `/Users/why/UDF/frontend/android/app/build/outputs/apk/debug/app-debug.apk`.
- Package/version: `com.udf.party`, `1.0.1`, versionCode `2`; debug testing build.
- Size: 34,939,688 bytes (approximately 34.94 MB).
- SHA-256: `487f87b446bb862e96ef11ef5ab051315bacf350b8cc4bc98cb1672d5b27a2c8`.
- Build command: `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ./frontend/android/gradlew -p frontend/android --no-daemon --console=plain :app:assembleDebug` (from workspace root).
- Verification command: `python3 deploy/release-progress/verify-apk.py verify`.
- Receipts: `deploy/release-progress/apk-baseline.json` (previous APK) and `deploy/release-progress/apk-build.json` (updated APK, public certificate fingerprint, asset/API checks).
- Nonblocking build warnings: flatDir dependency metadata, SDK XML v4/v3 tooling mismatch, unchecked Capacitor Java operations. APK verifier emitted META-INF/JAR-entry signature warnings retained in its receipt; APK v2 verification passed. Toolchain versions and dependencies were not changed.
- Android Studio UI build completion is NOT claimed: Apple Event `-609` blocked UI control, so CLI Gradle performed the actual build. Language-server diagnostics were unavailable; the verification script executed successfully.

## Verification evidence
All paths below are relative to the workspace unless absolute.
- `.tmp-verify/release-resume-region-viewport-after-full.png`: correct viewport Region sheet.
- `.tmp-verify/release-resume-region-full-comparison.png`: full-page capture artifact.
- `.tmp-verify/release-resume-subcouncil4-viewport.png`: full Subcouncil sheet.
- `.tmp-verify/release-resume-ward9-suburbs-viewport.png`: Ward Suburbs heading after inner scroll.
- `.tmp-verify/release-resume-ward9-child-viewport.png`: child detail.
- `.tmp-verify/release-resume-ward9-child-back-viewport.png`: back to Ward 9.
- `.tmp-verify/release-verified-reset-map.png`: Reset; viewBox changed from `120.6 361.7 504.3 768.4` to `0.0 0.0 1000.0 1523.8` after at least one second.
- `.tmp-verify/release-verified-region-keyboard.png`: Enter opens Region.
- Earlier failed dashboard navigation had `<no console messages found>`. Latest successful query navigation showed three initial 401 errors, automatic refresh 200, and dashboard retry 200; no runtime exception observed.
- Latest screenshot failure: `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE` (hidden/unattached browser view).

## Deployment safety
Target: `102.68.98.129`. Live backend: `/opt/udf/backend`; live frontend: `/var/www/udf/frontend`. Latest frontend deployment/recovery locations are recorded in the Permission label section above; unchanged backend deployment/recovery locations remain in the Resident Reports section. The earlier CRM deployment completed at server journal time `2026-09-18 07:03:46 UTC`.

Earlier release retained locations:
- Release archives, script and `DEPLOYED` marker: `/root/udf-releases/udf-20260918T035445Z/`.
- Root-protected backups: `/var/backups/udf/udf-20260918T035445Z/`.
- Previous backend: `/opt/udf/backend.previous-udf-20260918T035445Z`.
- Previous frontend: `/var/www/udf/frontend.previous-udf-20260918T035445Z`.

Backups remain on the production server; off-box backup transfer and full restore testing were not performed. Preserve uploads, database, configuration, credentials, mail services, and signing identity. A rollback requires explicit operational intent and must preserve uploads written since cutover; do not automatically restore the database or blindly rerun the deployment script.
