# UDF production release progress

Last updated: 2026-09-18. Overall status: CRM PRODUCTION DEPLOYMENT FIRST; APK DEFERRED BY USER. Production has not been changed by this session. Android web assets are rebuilt and synced, but no new APK has been built.

## Resume protocol
On a request such as "proceed", "proceed where last", or "continue", read this file first, validate the recorded state against current artifacts/tools, and resume the first unfinished item. Update this file after each meaningful result and before handing off. Do not repeat completed checks unless the code/artifact changed. Never treat an unverified check as passing or a continuation request as permission to bypass a blocker. Keep credentials, tokens, private keys, and personal data out of this folder.

## Release identity
- Candidate: `udf-20260918T035445Z`.
- Receipt: `.tmp-verify/release-latest.json`.
- Frozen source: `.tmp-verify/udf-20260918T035445Z/source/`.
- Artifacts: `.tmp-verify/udf-20260918T035445Z/artifacts/`.
- Recorded backend SHA-256: `8e7387c98e1d2646425e777bd5dbfb382d8787155551aa570365bf52a5d932a7`.
- Recorded frontend SHA-256: `b77e9f6d45cfd6392ef5a51d3d03dcafb812442a55e6b201676c2d3c42ac2ff2`.
- VERIFIED: both artifact hashes match the receipt; every manifest-listed frozen and working source file matches its recorded hash. `/`, `/crm/`, `/crm/patrols/` HTML and their referenced JavaScript/CSS match frozen output byte-for-byte. `.tmp-verify/release.mjs verify` completed with 0 failures.
- Verification helper now supports a read-only `verify` mode; it does not modify release artifacts or application/authentication state.
- Browser verification origin: `http://localhost:3000`; existing session/tab only.

## Checklist
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
- [ ] Resolve release security gate. Workspace has no Git repository; do not initialize or commit without permission. No review has run. Obtain required decision before deployment.
- [x] Read-only production preflight: SSH works, `udf-api` active, local health endpoint returns HTTP 200 with `status: ok` and `db: true`, 15 GB disk available.
- [x] Read production migration IDs: 001–026 applied; candidate requires 027–029. Inspected those SQL files; no migrations have run on production in this session.
- [ ] Backups, migration-data compatibility, artifact staging, deployment and post-deployment health verification.
- [x] Rebuild Android web assets targeting `https://crm.udf-party.co.za/api`: optimized build and 40 static pages completed; capability guard passed; same 6 lint warnings.
- [x] `cap:sync` completed; fresh web assets copied into `frontend/android/app/src/main/assets/public`; 7 Capacitor plugins synced; `android:assets` reapplied tracked branding and native hardening overrides.
- [x] Open `/Users/why/UDF/frontend/android` in Android Studio.
- [ ] DEFERRED until after CRM deployment: finish Gradle sync and build the user-selected DEBUG TEST APK through Android Studio. Desktop actions have failed intermittently with Apple Event `-609`.
- [x] Set tracked native override to versionCode `2`, versionName `1.0.1`, then reapply `android:assets` to generated project. New APK has NOT been built.
- Existing APK metadata: debug `com.udf.party`, versionCode `1`, versionName `1.0`. This is an OLD artifact, not a completed update. `frontend/android/keystore.properties` is absent; no release output metadata exists. Production signing requires the existing release key/configuration or an explicit alternative decision.
- [ ] Verify APK signature/version/API target and report exact artifact path/hash. No new signing identity without permission.

## Current blockers and next actions
1. Query-string ordinary navigation enabled dashboard verification without manual authentication/storage edits. Bare-route browser verification, patrol UI checks, and Ward Close remain unverified because browser availability/control is unreliable; do not turn these into false passes.
2. User explicitly prioritized CRM production deployment and deferred APK work until afterward. Do not make further Android changes while CRM deployment is pending.
3. Full production release is not complete. Do not claim otherwise or run first-time provisioning/reset/seed scripts on the existing server.
4. User selected USE EXISTING REPOSITORY, not Git initialization. No existing repository path was provided; the workspace itself has no Git repository. Broad home-directory repository search was canceled. Do not initialize/commit or repeat that canceled search without direction.
5. User selected DEBUG TESTING APK. Preserve that decision for the deferred APK step; do not claim it is a production-signed release.

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
- Latest console read after dashboard navigation: `<no console messages found>`; this is not proof the app has no runtime errors because navigation failed.
- Latest screenshot failure: `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE` (hidden/unattached browser view).

## Deployment safety
The existing target is `102.68.98.129`, backend `/opt/udf/backend`, frontend `/var/www/udf/frontend`. Preserve uploads, database, configuration, credentials, mail services, and existing signing identity. Consult `deploy/RUNBOOK.md` but do not run destructive bootstrap steps intended for initial provisioning. Record actual backup/release locations here only after successfully creating them. Current backups/deployment: NOT PERFORMED.
