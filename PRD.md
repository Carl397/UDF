# UDF Ward Transparency, Accountability & CRM Moderation — Product Requirements Document

| Field | Value |
|---|---|
| Document | PRD-2026-09-12 Ward Transparency & CRM Moderation |
| Version | 1.0 (Draft for approval) |
| Status | Pending National Administrator sign-off |
| Owner | Product (UDF) |
| Related artefacts | `DESIGN.md` (living architecture design), `PRD-jobs.md` (Ward Job Interest Register, FR-K–N), `backend/src/auth/permissions.ts`, migrations `001`–`005` |
| Scope | Mobile app (Capacitor/Next.js export) + CRM Desktop (Next.js `/crm`) + Express/Postgres backend |

---

## 1. Executive summary

This PRD specifies a **ward-transparency and accountability surface** for the UDF platform, plus the **CRM moderation and diagnostics capabilities** required to operate it safely under POPIA.

In one paragraph: a first-time visitor opens the app to an **onboarding screen that explains what the UDF stands for** and offers a single **"use my location" tap**. That tap resolves the visitor's ward to **3–5 m accuracy**, identifies **who the ward councillor is**, and shows a **public overview of that councillor's activity** (patrols, projects, cases, bulletins, ratings) as evidence of proactiveness. **Only a member registered to that ward** may open the **detail tier**: individual patrols with dates and remarks, projects with **before / during / after** imagery, service logs with their **reference (notification) numbers** and the reported picture, and a **1–5 rating system** for members to score the councillor's logged work. Logs containing people, children, or street/house addresses are **private**: they surface only as a category + overview to authorised staff, never to members or the public. All councillor posts/events pass a **moderation queue approved by the National Administrator** before publication. Members may view any ward's overview but only their own ward's detail, and may **change ward at most 3 times per 5-year term**. **Email OTP verification** gates login, password reset and ward change. The CRM gains the moderation queue, private-log viewer, ratings/ward-change audit, and a **diagnostics workspace** (the recommended debugging workflow, §6).

---

## 2. Goals & non-goals

**Goals**
- G1: Explain the party's purpose to any visitor before login (onboarding).
- G2: One-tap, high-accuracy (3–5 m) ward + councillor discovery from geolocation.
- G3: Publish councillor proactiveness as a public **overview**; reserve **detail** for ward members.
- G4: Let ward members rate councillor service logs (1–5) with accountable feedback.
- G5: Protect privacy: no people/children imagery, no street/house addresses in member/public media; private-log tier for sensitive work.
- G6: National-administrator approval of all councillor posts/events before publication.
- G7: POPIA-compliant ward portability with a hard change limit (3 per 5-year term).
- G8: Email OTP on login, reset and ward change.
- G9: CRM updated to moderate, audit and **debug** all of the above inside the existing RBAC/audit spine.

**Non-goals**
- NG1: No always-on location tracking; location is ephemeral and tap-initiated only.
- NG2: No public exposure of private logs, raw patrol tracks, or PII.
- NG3: No municipal system integration (manual transcription remains, per `DESIGN.md`).
- NG4: No i18n (English only). No SMS OTP in v1 (email only).
- NG5: No change to the sealed-PII model or the hash-chained `audit_log` guarantees.

---

## 3. Personas, roles & responsibilities

Mapped 1:1 to `Role` in `backend/src/auth/permissions.ts`.

| Role | Enum | Responsibilities in this PRD |
|---|---|---|
| National Administrator | `national_admin` | **Main administrator.** Approves/rejects all moderation items before publication; owns takedowns; views private logs; overrides ward-change limit with recorded reason; owns roles/permissions (`role:manage`); owns diagnostics workspace. |
| Regional Organizer | `regional_organizer` | Regional devolution of administration with **additional access control** (region-scoped). Optional pre-review of moderation items; views private logs in region; regional analytics. |
| Local Coordinator | `local_coordinator` | Branch organisation; submits posts/events into moderation; cannot approve. |
| Ward Councillor | `ward_councillor` | Creates service logs, patrols (with remarks), projects + stage media, bulletins; marks logs **private**; submits own posts/events to moderation; views own-ward ratings. |
| Member | `member` | Registered to one ward. Views own-ward **detail**; rates councillor work; views any ward's **overview**; may change ward ≤3×/term (OTP-gated). |
| Visitor (public) | unauthenticated | Onboarding info; location tap → ward + councillor + **overview** only. |

---

## 4. Terminology

| Term | Definition |
|---|---|
| Ward | A `regions` row with `level='ward'` (PostGIS `geom`). The territorial spine. |
| Overview tier | Aggregate, PII-free counts/scores for a ward (patrols, projects, cases, bulletins, mean rating). Visible to any visitor/member for **any** ward. |
| Detail tier | Per-item records (patrol dates+remarks, project stage media, service logs + reference numbers + reported media). Visible **only** to members registered to that ward, and to staff per scope. |
| Service log | A `service_requests` row (a reported issue/call) with lifecycle + reference number. |
| Private log | A service log or patrol with `visibility='private'`: only category + overview exposed, to authorised staff. |
| Reference / notification number | Stable public code `UDF-W{ward}-NNNNNN` issued at Logged; the "notification number" members view. |
| Patrol | A `patrols` row with track points/stops and councillor **remarks**. |
| Stage media | Project imagery tagged `before` / `during` / `after`. |
| Rating | 1–5 score by a ward member on a councillor log/project/patrol; reason mandatory when ≤2. |
| Moderation item | A post/event/bulletin awaiting review; status `pending → approved | rejected`, plus `taken_down`. |
| Ward change | Re-assignment of a member's ward; counted and capped (3 per 5-year term). |
| OTP | 6-digit one-time code delivered by email; hashed at rest. |
| Correlation ID | `X-Request-Id` propagated through client → API → audit/diagnostics for debugging. |

---

## 5. Functional requirements

### 5.1 FR-A — Startup / onboarding information screen
- **FR-A1** On first launch (and when signed out), the app shows an onboarding screen presenting: party name, mission, and **"What we stand for"** chips (source: existing `manifesto` / `publicMeta`), plus CTAs *Become a member* / *Member sign in*.
- **FR-A2** The onboarding screen carries the **"Use my location"** control (FR-B) and a link to open petitions. No login required.
- **FR-A3** Onboarding content is served from the public content module (statically prerendered) so it renders offline-first and without auth.
- **FR-A4** Onboarding is skippable and re-reachable from the public home; it never blocks a returning signed-in user.

### 5.2 FR-B — "Find my ward councillor" geolocation
- **FR-B1** A single tap requests high-accuracy fused location (GPS + Wi-Fi + cell). The app requests accuracy sufficient for **3–5 m**; `accuracy_m` is captured with every fix.
- **FR-B2** Acceptance rule: proceed when `accuracy_m ≤ 5`. If worse, retry up to 2×; then offer manual ward selection (search/list) as fallback. The UI always displays the achieved accuracy.
- **FR-B3** The raw lat/lng of a **public lookup is ephemeral**: it is used server-side to resolve the ward (`ST_Within/ST_Intersects` on `regions.geom`) and is **not persisted** for visitors. Only `ward_code`, `accuracy_m` and a timestamp are logged (aggregate analytics only).
- **FR-B4** Response displays: ward name/code, the **current ward councillor** (resolved from active `appointments` for position `WARD_COUNCILLOR` in that ward), and the councillor's **overview** (FR-C).
- **FR-B5** If the ward has no active councillor, show a vacancy state ("seat vacant — view bulletins") rather than an error.
- **FR-B6** Location consent is recorded (`member_consents` for members; transient consent prompt for visitors) and revocable; refusal leaves manual ward selection available.
- **FR-B7** POPIA: no raw coordinate history for visitors; members' own patrol/location data follows `DESIGN.md` opt-in patrol rules (thinned, ward-clipped, home-buffer masked).

### 5.3 FR-C — Councillor activity overview (proactiveness), any audience
- **FR-C1** For any resolved/selected ward, show an overview card: counts of patrols (last 30/90 days), active vs resolved service logs, projects (active/completed), bulletins published, and **mean rating** (1–5) with rating count.
- **FR-C2** Overview contains **no PII, no media, no individual remarks** — aggregates only. Safe for visitors and cross-ward members.
- **FR-C3** Overview is available for **any** ward (supports FR-G portability and metro comparison).
- **FR-C4** Overview numbers link into detail **only** when the viewer is a member of that ward (else a lock hint: "Sign in as a member of this ward to see detail").

### 5.4 FR-D — Member-gated ward detail + rating system
- **FR-D1** Gate: detail tier requires `Role.MEMBER` **and** `member.ward == requested ward` (JWT `wardCode`). All other viewers get FR-C overview only.
- **FR-D2** Patrols: list with **date**, duration/distance summary, and the councillor's **remarks**; track map clipped to ward (no raw export).
- **FR-D3** Projects: list with **stage media** — images captured **before**, **during**, and **after** (final outcome) — plus milestone progress.
- **FR-D4** Service logs: list with **reference (notification) number**, category, status, opened/resolved dates, and the **reported picture** (privacy-filtered per FR-E).
- **FR-D5** Rating: ward members rate any councillor log/project/patrol **1–5**; **mandatory free-text reason when ≤2**; one rating per member per target; edit window 24 h; aggregate mean + count shown on overview and detail.
- **FR-D6** Ratings are attributed to the member internally (for abuse control) but displayed **aggregated only**; a councillor may not rate own work; staff see distribution in CRM.
- **FR-D7** Members receive a notification when a rated item changes status (logged → in progress → resolved) and when a new patrol/project is published in their ward.
- **FR-D8** All detail reads are audited (`recordAudit`) with ward scope, to evidence POPIA minimisation.

### 5.5 FR-E — Media privacy & private logs
- **FR-E1** Prohibited in any member/public-visible media: **images of people or children**, and **street/house addresses** (visible signage included). Upload pipeline runs automated checks (face/person detection + OCR for address-like text) and flags hits for moderator review; flagged media is blocked from member/public tiers pending review.
- **FR-E2** Councillors classify each log/patrol `visibility ∈ {public, members, private}` at capture; default `members`.
- **FR-E3** **Private logs** expose to authorised staff (owner councillor, regional+, national) only: title, category, status, date and count-level overview. **No media, no remarks, no addresses** in any member/public response. Private items are excluded from public aggregates except as an anonymous count.
- **FR-E4** Members/public see private logs only as an anonymous category count ("3 private logs this month") — never identifiable content.
- **FR-E5** Media retains EXIF geo+time + content hash (evidence chain) but EXIF is stripped from any served member/public rendition; originals stay server-side, access-audited.
- **FR-E6** Takedown: any moderator can withdraw media/log from member/public tiers instantly; the audit trail records who/when/why.

### 5.6 FR-F — Moderation & National Administrator approval
- **FR-F1** Councillor/local-coordinator **posts and events** (and bulletins) enter moderation as `pending` on submit; they are **not visible publicly** until approved.
- **FR-F2** Approval authority: **National Administrator** (`moderation:approve`). Regional Organizers may **pre-review/recommend** within their region (`moderation:review`) but cannot publish.
- **FR-F3** Decisions carry a reason; rejection returns to author with notes; resubmission restarts the queue. SLA: 48 h to first decision, surfaced in CRM.
- **FR-F4** Post-publication takedown uses `post:moderate` and flips status to `taken_down` with audit; cached/CDN copies purged.
- **FR-F5** The moderation queue in CRM shows author, ward, target type, content preview, privacy flags (FR-E1 hits), age vs SLA, and reviewer history.
- **FR-F6** Every moderation transition writes to the hash-chained `audit_log`.

### 5.7 FR-G — Ward portability, overview-vs-detail, ward-change limit
- **FR-G1** A signed-in member viewing **any** ward sees the **overview** (numbers) for that ward (FR-C). Detail remains own-ward only (FR-D1).
- **FR-G2** A member who has genuinely relocated may **change their ward of registration**, OTP-gated (FR-H), with a recorded reason.
- **FR-G3** **Hard limit: 3 ward changes per 5-year electoral term.** The member's remaining changes are displayed before confirming; at 0 the action is disabled.
- **FR-G4** Each change is written to `ward_change_log` (from/to ward, reason, OTP verification, actor, timestamp) and is visible in CRM as an anti-abuse indicator ("amount of times changing wards").
- **FR-G5** **National Administrator override** may grant an additional change with mandatory written reason; override is audited and reported.
- **FR-G6** After a change, the member's detail access, notifications and rating eligibility re-scope to the new ward immediately; prior-ward detail is revoked. POPIA: historical ward membership is retained only as the audit row, not as a browsable profile.

### 5.8 FR-H — Email OTP verification
- **FR-H1** Login is two-step: password, then a **6-digit email OTP**. Successful OTP issues the session JWT.
- **FR-H2** OTP codes are hashed at rest, expire in 10 minutes, allow 5 attempts, and are rate-limited per account/IP; resend cooldown 60 s.
- **FR-H3** **Password reset** requires OTP re-verification before a new password is accepted ("before you reset, verify once again").
- **FR-H4** **Ward change** (FR-G2) and **rating abuse appeals** require OTP re-verification.
- **FR-H5** OTP delivery uses the sealed email (decrypted server-side at send time only); delivery failures surface a retry, never the address.
- **FR-H6** All OTP issue/verify/fail events are audited and visible in CRM (security view), with lockout after repeated failures.

### 5.9 FR-I — Reference numbers & reported imagery
- **FR-I1** Every service log carries its reference number (`UDF-W{ward}-NNNNNN`) prominently in member detail and in member notifications.
- **FR-I2** The member detail view pairs the reference with a **clear picture of what was reported** (the privacy-filtered reported media, FR-E).
- **FR-I3** Public transparency lookups by reference show status + category only (no media), preserving the existing public trust surface.

### 5.10 FR-J — CRM Desktop updates (must ship with the above)
- **FR-J1** New **Moderation** page (`/crm/moderation`): queue, filters (type/ward/SLA/flag), approve/reject with reason, takedown, reviewer history. Gated `moderation:approve` / `moderation:review`.
- **FR-J2** New **Private Logs** view (`/crm/private-logs`): category+overview list for authorised roles; drill-in shows authorised-staff-only fields; every open is audited.
- **FR-J3** Extend **Ratings** (`/crm/ratings`): distribution per councillor/ward, low-rating reasons queue (≤2), trend charts, export.
- **FR-J4** New **Ward Changes** view (`/crm/ward-changes`): per-member change count vs limit, reasons, OTP confirmation, override action (national only).
- **FR-J5** Extend **Audit** (`/crm/audit`): correlation-ID filter, actor/role/action filters, export; link audit rows to diagnostics events.
- **FR-J6** New **Diagnostics** workspace (`/crm/diagnostics`) — see §6.
- **FR-J7** Extend **Users** (`/crm/users`): show OTP/lockout state, ward + remaining ward-changes, consent state; reset actions re-verified by OTP.
- **FR-J8** Extend **Settings** (`/crm/settings`): feature flags for gradual rollout of each FR group, and the moderation SLA + ward-change-limit constants (3 / 5 years) as configurable policy.

---

## 6. Recommended debugging & diagnostics workflow inside the CRM

**Recommendation: build debugging as a first-class, RBAC-gated "Diagnostics" workspace inside the CRM, on top of the existing hash-chained `audit_log` — not as an external SaaS.** Rationale: the platform already has a tamper-evident audit spine, sealed-PII discipline and a desktop CRM where admins live; bolting on a third-party error tracker would leak PII/geometry and break POPIA minimisation. Concretely:

1. **Correlation-ID tracing (backbone).** Every API request gets `X-Request-Id`; the mobile/web clients attach it to every fetch and to every telemetry event. Server logs, `audit_log.metadata`, and diagnostics events all carry it, so one ID reconstructs a user-reported fault end-to-end.
2. **Client telemetry inbox.** The Capacitor WebView bridge and the web app forward `console.error`, unhandled rejections, and failed network calls (route, role, app version, correlation ID, HTTP status, redacted body) to `POST /api/diagnostics/events`. CRM groups them by signature (dedupe + count + first/last seen) so admins see "12 members hit 500 on /member/ward/detail" rather than 12 noise rows.
3. **Audit ↔ diagnostics join.** From a diagnostics event, jump to the correlated audit rows (actor, action, ward) and to the moderation/private-log record involved. This turns "something broke" into "who, where, which record".
4. **Read-only "view-as" reproduction.** Support staff can render the member-visible state for a ward **without** impersonation and **without** PII decrypt (a scoped, read-only projection). Reproduces FR-D gating bugs safely.
5. **Feature flags + kill-switch.** Each FR group ships behind a flag (role/ward-scoped) in `/crm/settings`, so a faulty surface is disabled in production without a redeploy.
6. **Standard mobile debug runbook.** Document and reuse the proven path: emulator + `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` → Chrome DevTools Protocol for WebView console/network; plus seeded personas per role (`ChangeMe!12345`) for one-command reproduction. This is the sanctioned way to debug the APK, since ADB taps are unreliable in WebViews.
7. **Triage lifecycle.** Diagnostics events carry status `open → ack → resolved` and an owner; unresolved P1 events auto-raise an escalation (reusing the escalation ladder) so debugging is accountable, not ad-hoc.

This keeps debugging **inside** the CRM's permission and audit model: analysts/national admin read diagnostics; no raw PII or coordinates ever enter telemetry (payloads are redacted server-side at ingest).

---

## 7. Data model changes (new migration `006_transparency.sql`)

| Change | Type | Purpose |
|---|---|---|
| `service_requests.visibility` | add col `text check in ('public','members','private')` default `'members'` | FR-E private tier |
| `service_requests.privacy_flags` | add col `text[]` | FR-E1 automated check hits |
| `patrols.visibility`, `patrols.remarks` | add cols | FR-D2 / FR-E |
| `project_media` | new table `(project_id, stage in before/during/after, media_id, captured_at)` | FR-D3 stage imagery |
| `moderation_items` | new table `(target_type, target_id, status, submitted_by/at, reviewed_by/at, decision_note)` | FR-F trail |
| `posts.publication_status`, `events.publication_status` | add cols | FR-F gating |
| `ward_change_log` | new table `(member_id, from_ward, to_ward, reason, otp_verified_at, changed_by, created_at)` | FR-G4 |
| `members.ward_changes_used`, `members.term_started_at` | add cols | FR-G3 cap |
| `email_otps` | new table `(subject_id, purpose, code_hash, expires_at, attempts, consumed_at)` | FR-H |
| `diagnostics_events` | new table `(source, app_version, route, role, correlation_id, severity, signature, payload_jsonb, count, first/last_seen, status, owner)` | §6 |
| `ratings` | reuse existing (target_type/target_id/score/reason) | FR-D5 |
| `member_consents` | reuse for location consent | FR-B6 |

No new PII columns; all new columns are non-identifying or hashed.

---

## 8. API surface (new/changed)

| Audience | Endpoint | Permission / gate |
|---|---|---|
| Public | `GET /api/public/manifesto` (exists) | open |
| Public | `GET /api/public/wards/councillor?lat&lng&accuracy_m` | open; ephemeral coords; returns ward + councillor + overview |
| Public | `GET /api/public/wards/:code/overview` | open |
| Public | `POST /api/auth/login` → OTP challenge; `POST /api/auth/otp/verify`; `POST /api/auth/otp/resend` | FR-H |
| Public | `POST /api/auth/password-reset/request` / `/confirm` | OTP-gated |
| Member | `GET /api/member/wards/:code/detail` | `member` + ward match |
| Member | `POST /api/member/ratings` | `rating:write` + ward match |
| Member | `POST /api/member/ward-change` | OTP + cap |
| Member | `GET /api/member/wards/:code/overview` | any signed-in |
| Councillor | `POST /api/cases`, `POST /api/patrols` (with `visibility`,`remarks`) | `case:log`/`patrol:write` |
| Councillor | `POST /api/projects/:id/media` (stage) | ward-scoped write |
| Councillor | `POST /api/moderation/submit` | author |
| CRM | `GET/POST /api/crm/moderation[/:id/decision]` | `moderation:review` / `moderation:approve` |
| CRM | `GET /api/crm/private-logs` | `case:private_read` |
| CRM | `GET /api/crm/ratings/summary`, `GET /api/crm/ward-changes`, `POST /api/crm/ward-changes/:id/override` | `overview:read` / national |
| CRM | `GET /api/crm/diagnostics/events[/:id]`, `PATCH .../status` | `diagnostics:read` |
| Client | `POST /api/diagnostics/events` | authenticated or anonymous-with-signature; redacted |

---

## 9. RBAC deltas (`auth/permissions.ts`)

New `Permission` constants: `MODERATION_REVIEW ('moderation:review')`, `MODERATION_APPROVE ('moderation:approve')`, `CASE_PRIVATE_READ ('case:private_read')`, `WARD_CHANGE_MANAGE ('ward_change:manage')`, `DIAGNOSTICS_READ ('diagnostics:read')`.

| Role | Adds |
|---|---|
| national_admin | `moderation:approve`, `moderation:review`, `case:private_read`, `ward_change:manage`, `diagnostics:read` |
| regional_organizer | `moderation:review`, `case:private_read` (region-scoped), `diagnostics:read` |
| ward_councillor | (unchanged) authors into moderation; reads own private logs |
| analyst | `diagnostics:read` (read-only, redacted) |
| member / local_coordinator | unchanged (member keeps read + rate + verify + engage) |

---

## 10. Non-functional requirements & POPIA

- **POPIA matrix:** location (visitors) ephemeral, purpose ward-resolution, retention none (aggregate only); member patrol points thinned/ward-clipped, raw 90 d then heat-aggregate; OTP hashed, purged on consume/expiry; media EXIF stripped on serve; private logs minimised; diagnostics payloads redacted (no PII/coords).
- **Accuracy:** target **≤5 m** (3–5 m typical) via fused high-accuracy provider; degrade gracefully (retry → manual ward). Display achieved `accuracy_m`.
- **Security:** sealed PII + blind indexes unchanged; OTP hashed; moderation/override/private-log reads always audited; no PII in telemetry.
- **Offline:** councillor capture queues offline and syncs (township coverage), per `DESIGN.md`.
- **Performance:** overview aggregates precomputed (materialised rollups) so public lookups stay <200 ms; detail paginated.
- **Accessibility/i18n:** WCAG-AA contrast on red/black system; English only.
- **Retention:** ratings aggregated for display, raw attributed rows retained for abuse control under access control.

---

## 11. Screen specifications

**Mobile:** (1) Onboarding (FR-A) with stands-for chips + location button; (2) Councillor card (FR-B4) ward + councillor + overview; (3) Ward overview (FR-C) with lock hints; (4) Member detail tabs Patrols / Projects / Logs (FR-D) with rating control; (5) Ward-change flow with remaining-changes counter + OTP; (6) Login + OTP step.
**CRM:** Moderation, Private Logs, Ratings (extended), Ward Changes, Diagnostics, Audit (correlation filter), Users (OTP/ward state), Settings (flags + policy constants).

---

## 12. Acceptance criteria & test plan (seeded roles)

Using seeded accounts (`national.admin@udf.example`, `regional.organizer@udf.example`, `councillor.ward9@udf.example`, `member.ward9@udf.example`, password `ChangeMe!12345`):

- AC-B: location tap at a Ward-9 coordinate with accuracy ≤5 m returns Ward 9 + its councillor + overview; accuracy >5 m triggers retry then manual fallback.
- AC-C: visitor and out-of-ward member see overview only; detail endpoint 403s them.
- AC-D: `member.ward9` sees Ward-9 patrols (dates+remarks), projects with before/during/after media, logs with reference numbers + reported picture; submits a rating (≤2 forces reason); second rating on same target rejected.
- AC-E: a log flagged with a person-image or address is withheld from member/public tiers; as `private` it shows category+overview only to staff.
- AC-F: councillor post is invisible publicly while `pending`; national approve publishes; regional cannot approve; takedown removes + audits.
- AC-G: member changes ward 3× succeeds, 4th blocked; override by national with reason succeeds and audits.
- AC-H: login without OTP fails; reset requires OTP; 6 wrong OTPs locks with audit.
- AC-J: CRM moderation queue approves/rejects with reason; diagnostics groups a simulated client error by signature and links correlation ID to audit.

---

## 13. Rollout plan

- **Phase 4.5 — Transparency (this PRD, mobile-first):** FR-A, FR-B, FR-C, FR-E, FR-I + schema `006`.
- **Phase 5 — CRM moderation & accountability:** FR-D ratings dashboards, FR-F, FR-J1–J5, FR-J7–J8.
- **Phase 6 — Portability, OTP & diagnostics:** FR-G, FR-H, FR-J6 + §6 telemetry.
- Each phase behind feature flags (§6.5); APK rebuild per phase via the standard export → cap sync → gradle pipeline.

---

## 14. Risks, assumptions & open questions

| # | Item | Type | Note |
|---|---|---|---|
| 1 | Ward-change window = 3 per **5-year term** | Assumption | Dictation garbled ("3 times … 5 years"); confirm period (term vs calendar). |
| 2 | 3–5 m accuracy | Risk | Consumer GPS achieves this only in open sky; degrade gracefully (FR-B2). |
| 3 | Overview public vs member-only | Assumption | Chosen public (aggregates, PII-free); confirm. |
| 4 | Regional pre-review optional vs mandatory | Assumption | Optional recommend; national approval mandatory. Confirm. |
| 5 | OTP channel email-only | Assumption | SMS deferred (NG4). |
| 6 | Automated person/address detection | Risk | False positives block legit media; moderator override required (FR-E1). |
| 7 | Rating abuse | Risk | Attributed raw ratings + one-per-target + low-rating reason mitigate. |

---

## Appendix A — State machines

**Moderation:** `pending → approved → published → taken_down` ; `pending → rejected → (resubmit) pending`.
**Service log visibility:** authored `public|members|private`; privacy flag can force downgrade `public→members→private`.
**Ward change:** `requested → otp_verified → applied (count+1)` ; `requested → blocked (limit)` ; `blocked → override(national) → applied`.

## Appendix B — Privacy classification

| Tier | Audience | Content |
|---|---|---|
| Public | anyone | overview aggregates, reference status, vacancy/bulletins |
| Members | ward members | detail: patrols+remarks, stage media, logs+reference+reported media, ratings |
| Private | owner councillor + regional+ / national | category + overview only (no media/remarks/address) |
| Staff-internal | national/regional + diagnostics | audit, OTP events, ward-change log, redacted telemetry |

## Appendix C — Reference formats
Service log: `UDF-W{ward}-NNNNNN`. OTP: 6 digits. Correlation ID: UUIDv4 in `X-Request-Id`.
