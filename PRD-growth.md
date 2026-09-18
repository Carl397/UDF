# UDF Recruitment Genealogy, Member Onboarding & Councillor Accountability — Product Requirements Document

| Field | Value |
|---|---|
| Document | PRD-2026-09-14 Growth, Onboarding & Accountability (Wave 5) |
| Version | 1.0 (Draft for approval) |
| Status | Pending National Administrator sign-off |
| Owner | Product (UDF) |
| Related artefacts | `PRD.md` (Ward Transparency & CRM Moderation, FR-A–J), `PRD-jobs.md` (Ward Jobs, FR-K–N), `DESIGN.md`, `backend/src/auth/permissions.ts`, migrations `001`–`018` |
| Scope | Mobile app (Capacitor/Next.js export) + CRM Desktop (Next.js `/crm`) + Express/Postgres backend |
| Planned migrations | `019_recruitment_tree.sql`, `020_member_onboarding_otp.sql`, `021_councillor_ratings.sql` |

---

## 1. Executive summary

This PRD specifies **five connected capabilities** that turn the UDF platform from a transparency surface into a **growth, onboarding and accountability engine**. In one paragraph:

When a **ward councillor** (or any member) recruits someone from the mobile app, the recruit carries the recruiter's **reference number**, and the platform records a real **parent → child recruitment link**. Every member who joins can in turn recruit others, so the platform can render a **recruitment tree** — "this branch grew to 6, those 6 grew to 15, those 15 to 40" — and **trace any member back to the first source**. A **national report** ranks ward councillors by the recruitment trees they originated. Once registered, a member is **onboarded by email OTP**: they receive a starter-pack email containing a **6-digit OTP**, open the app, enter their email and the OTP as their first password, are **forced to change it**, and are then signed in. That same starter-pack email carries the **ward councillor's bio brochure and photo, the mini-manifesto, and the party leader's picture**, with a thank-you for joining and for holding the councillor accountable. On the **map**, subcouncils are colour-coded at the subcouncil level and, when drilling into wards, **each ward gets a distinct colour with its number and area name labelled**. Finally, members can **rate their ward councillor at any time** from the front of the app across a fixed set of **performance categories** on a **monthly** cycle, **1–5**; a score of **1–2 requires a compulsory 100-word explanation** of what is wrong and how to improve, while **3–5 needs only minimal wording**. Each submission enters an **acknowledgement lifecycle** — the councillor/staff views it and an acknowledgement is returned to the member.

These build directly on the existing spine: the sealed-PII `members` table, the hash-chained `audit_log`, the RBAC model in `auth/permissions.ts`, the `regions` hierarchy (municipality → region → subcouncil → ward → suburb), the `ratings` table, and the `leaders` / `ward_profiles` councillor directory.

---

## 2. Goals & non-goals

**Goals**
- G1: Record a durable, queryable **recruitment link** (referrer → recruit) for every member, replacing the free-text `members.referral` hint.
- G2: Render a **recruitment tree** (genealogy) for any node and **trace to the root source**; expose depth, direct-referrals and total-downline counts.
- G3: Give **national/regional leadership a recruitment report** ranking ward councillors by the trees they originate (accountability for growth).
- G4: Onboard members with **email OTP** and a **forced first-password change**, so a self-registered member can actually sign in (today they cannot — see §3.1).
- G5: Deliver a **starter-pack email** that welcomes the member and attaches the **ward councillor's bio + photo, mini-manifesto and party-leader picture**.
- G6: **Colour-code the map** by subcouncil, and by **distinct colour per ward** (with number + area-name labels) when drilled in.
- G7: Let members **rate their ward councillor monthly across categories (1–5)**, with a **100-word minimum reason for scores ≤2**, from a **front-of-app** surface, backed by an **acknowledgement lifecycle** and a councillor/national rollup.

**Non-goals**
- NG1: No SMS OTP in v1 (email only), consistent with `PRD.md` NG4.
- NG2: No monetary/MLM reward for recruitment — the tree is an **accountability and reporting** structure, never a payout scheme.
- NG3: No public exposure of the recruitment tree; it is a **staff/national analytics** surface. A member sees only their **own** downline.
- NG4: No change to the sealed-PII model, blind indexes, or hash-chained `audit_log` guarantees.
- NG5: No municipal system integration; no i18n (English only).
- NG6: Ratings do **not** auto-remove or sanction a councillor; they are evidence for human review (acknowledgement → CRM).

---

## 3. Current-state findings (why these gaps exist)

Grounded in the code as it stands on `main` (migrations `001`–`018`):

### 3.1 Members cannot sign in after self-registering
`registerMember` (`modules/memberships/service.ts`) inserts a **`members`** row (status `pending`) and issues a `member_tokens` confirm link, but it never creates a **`users`** row. Login (`modules/auth/service.ts`) authenticates against `users` only. Members link to users **solely** via `members.created_by`, which is `NULL` for public self-registration. **Result:** a person who registers on `/register` has no credentials and no account to log into. FR-P closes this by provisioning a `users` row (role `member`, `ward_code` set) bound to the member, gated by OTP and a forced password change.

### 3.2 Referral is free text, not a link
`members.referral TEXT` (migration `002`) stores the referrer's **public code** as typed/`?ref=`-supplied text. There is no FK, no integrity, and no way to walk a tree. FR-O adds `members.referred_by_member_id` (self-FK) resolved from the referral code at registration, plus a recursive-CTE tree/report.

### 3.3 No email transport
There is **no SMTP configuration** in `config/env.ts`; "emails" are captured in outbox tables (`job_relay_outbox`, `resident_report_outbox`) with a code comment "dev transport has no SMTP". The production host runs postfix/dovecot/opendkim, but the app does not send through it. FR-Q introduces a real, configured mailer (nodemailer → local/relay SMTP) with DKIM signing on the server, and an `email_outbox` for delivery state + retry.

### 3.4 Ratings exist but are single-shot and category-free
`ratings` (migration `003`) has `target_type`, `target_id`, `member_id`, `rating 1–5`, `reason` (service enforces reason when ≤2), and `UNIQUE(member_id, target_type, target_id)` — i.e. **one rating per member per target, ever**. There are no categories, no monthly cadence, no word-count rule, and no acknowledgement lifecycle. FR-S adds a dedicated **councillor scorecard** table (categories × month) rather than overloading `ratings`, keeping the existing item-level ratings intact.

### 3.5 Map colour-coding is partially there
`components/MapView.tsx` already fills subcouncils with one hue each (FNV hash of the code) and wards with **tints of the parent subcouncil's hue**, plus name labels at both levels and a zoom cut at 12. FR-R keeps this and adds: **distinct hue per ward** when drilled into a single subcouncil, **ward number prominence**, and a **legend**.

---

## 4. Personas & roles

Mapped 1:1 to `Role` in `backend/src/auth/permissions.ts`.

| Role | Responsibilities in this PRD |
|---|---|
| Member (`member`) | Recruits others (own referral link/code); sees **own** downline tree; completes OTP onboarding + forced password change; receives the starter-pack email; rates own ward councillor monthly; sees acknowledgements on own ratings. |
| Ward Councillor (`ward_councillor`) | Recruits from the app (referrals attributed to their reference number); sees the tree **they originate**; sees their own scorecard (ratings + reasons) and **acknowledges** submissions; is the subject of the starter-pack bio. |
| Local Coordinator (`local_coordinator`) | Branch recruitment analytics across their wards. |
| Regional Organizer (`regional_organizer`) | Region-scoped recruitment report + scorecard rollups. |
| National Administrator (`national_admin`) | **National recruitment report** ranking ward councillors by originated trees; owns rating categories, acknowledgement SLA and feature flags; full audit oversight. |
| Analyst (`analyst`) | Read-only aggregate recruitment + scorecard reports (no sealed PII). |
| Visitor / recruit | Registers via a referral link; the referrer is captured at registration. |

---

## 5. Terminology

| Term | Definition |
|---|---|
| Reference number | A member's stable public code `UDF-XXX-YYY` (`members.public_code`), used as the recruitment attribution token in `/register?ref=`. |
| Recruit / downline | A member whose `referred_by_member_id` points (directly or transitively) at a given node. |
| Recruitment tree (genealogy) | The rooted tree formed by `referred_by_member_id`; "leaves/branches" view of how one source grew into many. |
| Root source | The top-most referrer of a tree — typically the ward councillor who started the branch. |
| Depth | Number of hops from the root to a node (root = 0). |
| OTP | 6-digit one-time code delivered by email; hashed at rest; used as the member's **first password**. |
| Starter pack | The onboarding email: welcome + OTP + ward councillor bio brochure & photo + mini-manifesto + party-leader picture + thank-you/accountability note. |
| Scorecard | A member's monthly rating of their ward councillor across the fixed categories. |
| Rating category | A fixed dimension of councillor performance (see FR-S1). |
| Acknowledgement | The lifecycle state returned to a member after staff/councillor has viewed their scorecard submission (`submitted → viewed → acknowledged`). |
| Mini-manifesto | A short, ward-friendly extract of the party manifesto (`documents` where `category='manifesto'`, or `publicMeta.manifesto`). |

---

## 6. Functional requirements

### 6.1 FR-O — Recruitment genealogy & national report

- **FR-O1** At registration, resolve `referral` (the `?ref=` public code, or the "Referred by (party code)" field) to a **member id** and store it in `members.referred_by_member_id`. Keep the raw code in `members.referral` for auditability. An unresolvable/blank code leaves the field `NULL` (organic/self signup) — never an error.
- **FR-O2** A member's **own reference number and join link** (`/register?ref=<code>`) are surfaced in the app (Home / More → "Invite & grow"), with a share sheet (QR + copy link). This is the token a ward councillor shows on their phone when they sign someone up.
- **FR-O3** A councillor registering a recruit **from their own device/session** attributes the recruit to the councillor automatically (their `sub` → their member row), even if the recruit did not type a code — the code path is `created_by` fallback then `referred_by_member_id`.
- **FR-O4** **Tree read**: `GET /api/member/recruitment/tree?root=<memberId>&depth=<n>` returns the subtree (nodes with public code, tier, joined date, depth, direct-referral count, downline count). A **member** may only request a tree **rooted at themselves**; staff may request within scope.
- **FR-O5** **Trace to source**: `GET /api/member/recruitment/lineage?member=<id>` returns the ancestor chain from the member up to the **root source** (used to answer "where did this branch start?").
- **FR-O6** **National/regional recruitment report**: `GET /api/crm/recruitment/report?scope=&period=` ranks originators (ward councillors first) by: direct referrals, total downline, tree depth, active-vs-pending recruits, and 30/90-day growth. Drill-down opens that originator's tree (FR-O4). Aggregates are PII-free at national level; per-node identity resolves only within scope and is audited.
- **FR-O7** Every tree/lineage/report read is audited (`recruitment.tree.read`, `recruitment.report.read`) with scope, mirroring `PRD-jobs.md` FR-L5.
- **FR-O8** **Integrity**: the self-FK forbids cycles (a node cannot become its own ancestor). A DB trigger or service check rejects any update that would create a cycle; re-parenting is a national-only, audited action.

### 6.2 FR-P — Member onboarding: provisioning, OTP, forced password change

- **FR-P1** On successful registration (and on confirm-token acceptance), **provision a `users` row** for the member: role `member`, `ward_code` = member's ward, `region_codes` = member's region, sealed PII (email, fullName) from the member, `must_change_password = TRUE`, and a **random initial password** the user never sees (so the account cannot be used until OTP + change). Bind `users.member_id = members.id` via a new column (see §7) so the link is explicit rather than `created_by`-only.
- **FR-P2** On provisioning, **issue a 6-digit OTP** (purpose `onboarding`), hash it at rest (`email_otps`), TTL 10 minutes, max 5 attempts, resend cooldown 60 s, rate-limited per account + IP. Send it inside the **starter-pack email** (FR-Q).
- **FR-P3** **Login with OTP as first password**: the member enters email + OTP on the normal login form. The server, when the account is `must_change_password` and pre-OTP, accepts the **OTP as the password** (verified against `email_otps`, not the password hash), consumes it, and returns a session with `mustChangePassword = TRUE`.
- **FR-P4** **Forced password change**: the client gates on `mustChangePassword` (existing mechanism, migration `013`) and routes to change-password. `changePassword` already clears the flag, bumps `token_version` and revokes other sessions — reused as-is. Until changed, every authenticated surface is blocked except change-password/logout.
- **FR-P5** **Resend / recover**: "Resend OTP" re-issues (cooldown + rate limit); after OTP expiry the member requests a fresh one. A **password reset** path also re-verifies by OTP (aligns with `PRD.md` FR-H3).
- **FR-P6** All OTP issue/verify/fail/consume events are audited (`auth.otp.*`) and visible in the CRM security view; lockout after repeated failures.
- **FR-P7** POPIA: the OTP is delivered to the sealed email (decrypted server-side at send time only); delivery failures surface a retry, never the address. OTP rows are purged on consume/expiry.

### 6.3 FR-Q — Starter-pack email (welcome + councillor bio + manifesto + leader)

- **FR-Q1** The starter-pack email is sent to a newly registered member (at provisioning, FR-P2) and contains: (a) welcome + the member's **membership number** and **reference number**; (b) the **6-digit OTP** and "use this as your first password, then change it"; (c) the **ward councillor's bio brochure** (name, position, bio, public contact) and **photo**; (d) the **mini-manifesto**; (e) the **party leader's picture** and a short line; (f) a **thank-you** for joining and for **keeping the ward councillor accountable**, with a link to the rating surface (FR-S).
- **FR-Q2** Content is resolved server-side: councillor from `ward_profiles.councillor_member_id` → `leaders` (bio, `photo_id` → `media_assets`), else `leaders.ward_code` match (mirrors `geo/service.ts` councillorForWard); mini-manifesto from `documents` (`category='manifesto'`) or `publicMeta`; party leader from `leaders` where `position_code` = party-leader position. A ward with **no** councillor renders a graceful vacancy block ("your ward seat is vacant — here's the regional contact"), never a broken email.
- **FR-Q3** Images are embedded as **CID attachments** (or absolute HTTPS URLs to `/media/<id>` served by the app) so they render in mail clients without third-party hosts. No external image hosts (self-contained rule).
- **FR-Q4** A real **mailer** sends via configured SMTP (`SMTP_*` env) with DKIM (opendkim on the host). Every send writes an `email_outbox` row (to-hash, template, status, attempts, error, sent_at) for delivery state + retry; the outbox is **internal** (never exposed by an API), mirroring the jobs relay discipline.
- **FR-Q5** The template is HTML + plaintext multipart, WCAG-reasonable contrast, red/black brand, mobile-first. Template + party-leader/manifesto sources are editable in `/crm/settings` (national only) behind flag `onboarding.starterPack`.
- **FR-Q6** If SMTP is unconfigured (dev), the mailer falls back to the **outbox capture** behaviour already used by jobs/reports, so nothing crashes and the send is inspectable — but production requires real SMTP (fail-fast on boot when `NODE_ENV=production` and SMTP is unset, like the other production guards in `env.ts`).

### 6.4 FR-R — Map colour-coding (subcouncil + distinct wards)

- **FR-R1** At **subcouncil level** (zoom < cut), each subcouncil keeps a **distinct stable hue** (existing FNV-hash palette) with its name labelled and member-count shading.
- **FR-R2** When **drilled into a single subcouncil** (ward level), each **ward gets a distinct colour** (not a tint of one parent hue), with the **ward number and area name** labelled prominently. Distinctness is bounded (a curated 20-colour qualitative palette cycled by ward index within the subcouncil) so neighbouring wards never share a colour.
- **FR-R3** A **legend** shows the colour → ward/subcouncil mapping for the current view, plus the member-count ramp.
- **FR-R4** The member-restricted map (`MemberMapView`, Wave 4 `memberMap`) inherits the same ward colouring for the member's own ward + parent subcouncil context.
- **FR-R5** No new PII: colours derive from region codes only; counts remain the aggregate choropleth already returned by `/geo/choropleth`.

### 6.5 FR-S — Councillor performance rating (categories, monthly, 100-word rule, acknowledgement)

- **FR-S1** **Categories** (fixed, national-owned, seeded): `accessibility` ("Availability & accessibility"), `service_delivery` ("Responsiveness to service issues"), `communication` ("Communication & feedback"), `accountability` ("Accountability & transparency"), `presence` ("Ward presence & attendance"). Members rate **each category 1–5**.
- **FR-S2** **Monthly cadence**: a member may submit **one scorecard per calendar month** for their **own ward councillor**. Re-submitting in the same month **updates** that month's scorecard (until acknowledged); a new month opens a fresh one. This replaces the "one rating ever" limit for the councillor-scorecard use (existing item-level `ratings` are untouched).
- **FR-S3** **100-word rule**: for any category scored **1 or 2**, a free-text reason of **≥100 words** is **compulsory**, explaining what is wrong and how to improve. For **3, 4, 5**, reason is **optional** (minimal wording). Enforced server-side (word count on trimmed reason) and client-side (live word counter, submit disabled until met for ≤2).
- **FR-S4** **Front-of-app surface**: a **"Rate your councillor"** card is prominent on the member **Home** tab (and reachable from Engage), always available, showing the current month's status (Not rated / Submitted / Acknowledged) and the per-category stars.
- **FR-S5** **Eligibility**: only a member whose `ward_code` has an **active councillor** may rate; a vacant seat shows the vacancy state (no rating). A councillor cannot rate themselves. Staff cannot submit member scorecards.
- **FR-S6** **Acknowledgement lifecycle**: `submitted → viewed → acknowledged`. The councillor/staff sees new scorecards in the CRM/app; opening one marks `viewed`; sending an acknowledgement (optional short note) marks `acknowledged` and notifies the member ("Your feedback was received and reviewed"). SLA (default 7 days to first view) is configurable and surfaced in CRM.
- **FR-S7** **Attribution vs display**: a scorecard is attributed to the member internally (abuse control, one-per-month) but displayed to the councillor **aggregated by category** with the **reasons** (reasons are the actionable content). The member's identity is revealed to the councillor **only** if the member opts in ("share my name so the councillor can follow up"); default anonymous.
- **FR-S8** **Rollups & report**: per-councillor and per-ward category averages, distribution, count, and the **≤2 reasons queue**; regional/national see rollups across wards. Feeds the national accountability view alongside the recruitment report (FR-O6).
- **FR-S9** Every submit/view/acknowledge is audited (`rating.scorecard.*`) with ward scope.

---

## 7. Data model (new migrations)

### `019_recruitment_tree.sql`
| Change | Type | Purpose |
|---|---|---|
| `members.referred_by_member_id` | add col `uuid NULL REFERENCES members(id) ON DELETE SET NULL` | FR-O1 durable link |
| `idx_members_referred_by` | index on `referred_by_member_id` | fast child lookups |
| backfill | `UPDATE members SET referred_by_member_id = (SELECT id FROM members p WHERE p.public_code = members.referral)` where resolvable | migrate existing free-text refs |
| `fn_prevent_referral_cycle()` | trigger: reject an update that makes a node its own ancestor (recursive check) | FR-O8 integrity |

Tree/report queries use `WITH RECURSIVE` (same pattern already proven in `geo/service.ts` `getRegionSummary`). A materialised `recruitment_rollup(originator_member_id, direct, downline, depth, active, pending, updated_at)` refreshed on member insert/status-change keeps the national report < 200 ms without walking every tree on request.

### `020_member_onboarding_otp.sql`
| Change | Type | Purpose |
|---|---|---|
| `users.member_id` | add col `uuid NULL UNIQUE REFERENCES members(id) ON DELETE SET NULL` | FR-P1 explicit member↔user link (replaces `created_by`-only) |
| `email_otps` | new table `(id, user_id, purpose text check in ('onboarding','login','password_reset','ward_change'), code_hash, expires_at, attempts int default 0, consumed_at, created_at)` + index `(user_id, purpose)` | FR-P2/`PRD.md` FR-H |
| `email_outbox` | new table `(id, user_id null, to_bidx, template, subject, status check in ('queued','sent','failed'), attempts, error, sent_at, created_at)` — **internal, never exposed** | FR-Q4 delivery state |
| backfill | provision `users` for existing active members lacking one (idempotent), `must_change_password=TRUE` | so current members can onboard |

### `021_councillor_ratings.sql`
| Change | Type | Purpose |
|---|---|---|
| `rating_category` | new enum (`accessibility, service_delivery, communication, accountability, presence`) | FR-S1 |
| `councillor_scorecards` | new table `(id, member_id → members.id, councillor_member_id → members.id, ward_code → regions.code, period_month date, status check in ('submitted','viewed','acknowledged') default 'submitted', share_name bool default false, ack_note text, ack_by, ack_at, viewed_at, created_at, updated_at, UNIQUE(member_id, period_month))` | FR-S2/S6 |
| `councillor_scorecard_items` | new table `(id, scorecard_id → councillor_scorecards.id ON DELETE CASCADE, category rating_category, score int check 1..5, reason text, UNIQUE(scorecard_id, category))` + `CHECK` enforced in service: `score<=2 ⇒ word_count(reason)>=100` | FR-S1/S3 |
| `rating_category_config` | new table `(code, label, position, is_active)` seeded | FR-S1 national-owned taxonomy |
| `scorecard_rollup` | new rollup `(ward_code, councillor_member_id, category, period_month, avg, count, low_count)` refreshed on submit | FR-S8 fast report |

Existing `ratings` (item-level: cases/projects/patrols) is **unchanged**.

**POPIA notes.** No new sealed-PII columns. `email_otps.code_hash` is a salted hash; rows purged on consume/expiry. `email_outbox.to_bidx` stores a blind index, not the address (address resolved transiently at send). Recruitment report exposes identity **only within scope** and is audited. Scorecard reasons are attributable internally but shown to the councillor aggregated unless the member opts into `share_name`.

---

## 8. API surface (new/changed)

| Audience | Endpoint | Gate |
|---|---|---|
| Public | `POST /api/public/register` (exists) — now resolves `referred_by_member_id` + provisions user + issues OTP + queues starter pack | open |
| Public | `POST /api/auth/login` — accepts **OTP as password** for `must_change_password` pre-OTP accounts | FR-P3 |
| Public | `POST /api/auth/otp/resend` | rate-limited |
| Member | `GET /api/member/recruitment/tree?root=&depth=` | own root only; `recruitment:read` |
| Member | `GET /api/member/recruitment/lineage?member=` | within own downline / scope |
| Member | `GET /api/member/recruitment/invite` — own code + join link + QR payload | authenticated member |
| Member | `GET /api/member/scorecard/current` · `PUT /api/member/scorecard` · `GET /api/member/scorecard/history` | `rating:write` + own ward + active councillor |
| Councillor | `GET /api/councillor/scorecards` · `POST /api/councillor/scorecards/:id/view` · `POST /api/councillor/scorecards/:id/acknowledge` | own ward |
| CRM | `GET /api/crm/recruitment/report` · `GET /api/crm/recruitment/tree?root=` | `recruitment:report` + scope |
| CRM | `GET /api/crm/scorecards/summary` · `GET /api/crm/scorecards/low-reasons` · category config CRUD | `rating:read` / national |
| Internal | provisioning worker: register → user + OTP + starter-pack email → `email_outbox` | system |

All mutating calls `recordAudit` with ward/region scope.

---

## 9. RBAC deltas (`auth/permissions.ts`)

New `Permission` constants: `RECRUITMENT_READ ('recruitment:read')`, `RECRUITMENT_REPORT ('recruitment:report')`, `RATING_SCORECARD_WRITE ('rating:scorecard_write')`, `RATING_SCORECARD_READ ('rating:scorecard_read')`, `RATING_ACKNOWLEDGE ('rating:acknowledge')`.

| Role | Adds |
|---|---|
| member | `recruitment:read` (own tree), `rating:scorecard_write` (own ward) |
| ward_councillor | `recruitment:read` (own tree), `recruitment:report` (own ward), `rating:scorecard_read` + `rating:acknowledge` (own ward) |
| local_coordinator | `recruitment:report` (branch wards), `rating:scorecard_read` (branch) |
| regional_organizer | `recruitment:report` (region), `rating:scorecard_read` (region) |
| national_admin | all (national) + category taxonomy + flags/SLA ownership |
| analyst | `recruitment:report` + `rating:scorecard_read` (aggregates, read-only) |

`frontend/scripts/check-caps.mjs` capability-drift pins and `lib/caps.ts` are updated in the same change (the drift guard fails the build otherwise — see the Wave 4 `memberMap` lesson).

---

## 10. Non-functional requirements & POPIA

- **Security:** OTP hashed, short TTL, attempt + rate limited, purged on consume; forced password change reuses the token-rotation path; SMTP credentials in `/etc/udf/secrets.env` (never in the bundle); DKIM-signed outbound mail.
- **POPIA:** recruitment identity disclosed only within scope + audited; scorecard reasons attributable internally, aggregated to the councillor unless opt-in; email addresses never logged in clear in the outbox; no PII in map colours.
- **Performance:** `recruitment_rollup` + `scorecard_rollup` materialised and refreshed on write; recursive tree queries depth-capped (default 8) and paginated; national report < 200 ms.
- **Reliability:** mailer retries with backoff via `email_outbox`; OTP resend cooldown; a failed starter-pack email never blocks registration (outbox row + retry, member can request resend).
- **Offline/field:** a councillor recruiting offline queues the registration and syncs (township coverage), per `DESIGN.md`.
- **Accessibility:** WCAG-AA contrast on the red/black system; star-rating controls keyboard-operable with aria labels; email is HTML + plaintext multipart.

---

## 11. Screen specifications

**Mobile (member):**
1. **Home** → "Rate your councillor" card (FR-S4): current-month status + 5 category star rows; ≤2 opens the 100-word reason editor with a live word counter; submit → "Acknowledgement pending".
2. **Home / More** → "Invite & grow" (FR-O2): your reference number, join link, QR, share sheet; "Your recruitment tree" (FR-O4) rendered as an expandable branch/leaf view with counts + "trace to source".
3. **Onboarding** (FR-P3/P4): login screen accepts email + OTP; on `mustChangePassword`, a forced change-password screen before the app unlocks.
4. **Map** (FR-R): subcouncil colours; drill into a subcouncil → distinct ward colours + number/name labels + legend.

**CRM Desktop:**
- `/crm/recruitment` — national/regional recruitment report (rank originators, open tree, growth trend).
- `/crm/scorecards` — category rollups, ≤2 reasons queue, acknowledgement workflow + SLA.
- `/crm/settings` — rating category editor, starter-pack template + sources (leader photo, manifesto), OTP/SMTP toggles, acknowledgement SLA, feature flags.

---

## 12. Acceptance criteria & test plan (seeded roles)

Using seeded accounts (`national.admin@udf.example`, `councillor.ward9@udf.example`, `member.ward9@udf.example`, password `ChangeMe!12345`, ward `NORTH-W09`):

- **AC-O1**: registering with `?ref=<councillor code>` sets `referred_by_member_id` to the councillor; that recruit then recruits two more → tree shows depth 2, downline 3; `lineage` of a leaf traces to the councillor root; a cycle attempt is rejected.
- **AC-O2**: national report ranks the ward-9 councillor with direct=1, downline=3; drill-down opens the tree; report JSON at national scope contains no `email`/`fullName` keys (assert on raw JSON).
- **AC-P1**: a fresh `/register` provisions a `users` row (`member_id` bound, `must_change_password=TRUE`) and an `email_otps` row; login with the OTP succeeds and returns `mustChangePassword=TRUE`; login with a wrong OTP fails and increments attempts; after change-password the flag clears and normal login works.
- **AC-Q1**: the starter-pack email is produced for the new member containing membership no, reference no, OTP, councillor bio + photo, mini-manifesto, leader picture, thank-you; a vacant-ward member gets the graceful vacancy variant; `email_outbox` records status; dev fallback captures without SMTP.
- **AC-R1**: map shows one hue per subcouncil; drilling into subcouncil 17 shows each ward a distinct colour with number + name labels and a legend; member-restricted map colours the member's own ward.
- **AC-S1**: member submits a monthly scorecard; a category scored 2 with <100 words is rejected (server + client); scored 2 with ≥100 words is accepted; scored 4 with no reason is accepted; re-submit same month updates; new month opens fresh.
- **AC-S2**: councillor views (→`viewed`) and acknowledges (→`acknowledged`) a scorecard; the member is notified; identity is hidden unless `share_name`; vacant-seat member cannot rate; councillor cannot rate self.
- **AC-S3**: `/crm/scorecards` shows category averages + ≤2 reasons queue; every submit/view/acknowledge writes an audit row.

Debug flow follows `PRD.md` §6 (correlation IDs, diagnostics inbox, audit join) and `PRD-jobs.md` §9 (API-first curl assertions, POPIA tripwires, outbox capture, CDP-driven mobile runbook).

---

## 13. Rollout plan (phased, flag-gated)

- **Phase A — Recruitment genealogy (FR-O):** migration `019`, referral resolution + backfill, invite/tree/lineage endpoints, national report + `/crm/recruitment`, flag `recruitment.tree`.
- **Phase B — Onboarding + starter pack (FR-P, FR-Q):** migration `020`, member→user provisioning, OTP issue/verify, login-with-OTP, forced change, real mailer + `email_outbox`, starter-pack template, flags `onboarding.otp`, `onboarding.starterPack`. **Requires SMTP secrets on the host before enable.**
- **Phase C — Map colour-coding (FR-R):** distinct ward palette + labels + legend (frontend-only + palette helper), flag `map.wardColors`.
- **Phase D — Councillor ratings (FR-S):** migration `021`, scorecard endpoints, Home card + reason editor, acknowledgement workflow, `/crm/scorecards`, flags `rating.scorecard`.
- Each phase behind flags (§10), `check-caps.mjs` pins updated in-phase, APK rebuilt per phase via the standard export → cap sync → gradle pipeline, deployed via `build-offbox.sh` → `ship.sh` per `deploy/RUNBOOK.md`.

**Recommended build order:** A → B → C → D (A and C are independent; B needs infra secrets; D is the largest surface).

---

## 14. Risks, assumptions & open questions

| # | Item | Type | Note |
|---|---|---|---|
| 1 | Rating scale "between one and two" | Assumption | Interpreted as a **1–5** scale where **≤2** triggers the compulsory 100-word reason (matches existing `ratings` rule). Confirm. |
| 2 | Rating **categories** | Assumption | Proposed 5 (§FR-S1). Confirm wording/set; national-editable after ship. |
| 3 | "Monthly" cadence | Assumption | One scorecard per calendar month per member, updatable until acknowledged. Confirm vs rolling-30-days. |
| 4 | OTP as first password | Assumption | Login accepts the emailed OTP as the password for pre-OTP accounts, then forces a change (matches the dictated flow). Confirm. |
| 5 | Real SMTP | Risk/Decision | Production host has postfix/opendkim but the app has no mailer. FR-Q adds nodemailer + SMTP secrets. **Needs operator to provide/confirm SMTP relay + DKIM before Phase B enable.** |
| 6 | Member→user backfill | Risk | Provisioning `users` for existing members must not collide on `email_bidx`; idempotent `ON CONFLICT DO NOTHING` + audit. |
| 7 | Recruitment tree abuse | Risk | Cycle trigger + national-only re-parenting + audited; no payout (NG2) removes the incentive to fake trees. |
| 8 | Starter-pack images in mail | Risk | CID/own-hosted images only (no external hosts); some clients block remote images → plaintext fallback carries the OTP + text. |
| 9 | Ward number vs area name on map | Assumption | `regions.name` for wards already holds the ward label; confirm it includes the number ("Ward 79") or derive from code suffix. |
| 10 | Report identity at national scope | Assumption | National report is aggregate/ranked; per-node identity only on drill-down within scope, audited. Confirm. |

---

## Appendix A — State machines

**Onboarding:** `registered → user_provisioned(must_change_password) → otp_issued → otp_verified(session) → password_changed(active)`. OTP: `issued → (resent) → verified | expired | locked(≥5 fails)`.
**Starter pack:** `queued → sent | failed(→retry)`.
**Scorecard:** `submitted → viewed → acknowledged`; re-submit in-month updates while `submitted`.
**Recruitment node:** `pending → active`; tree edges immutable except national re-parent (audited, cycle-checked).

## Appendix B — Reference formats
Reference/public code: `UDF-XXX-YYY` (existing). Membership no: `UDF-<year>-<hex>`. OTP: 6 digits. Correlation ID: UUIDv4 in `X-Request-Id`. Scorecard period: `YYYY-MM-01`.

## Appendix C — Feature flags
`recruitment.tree`, `recruitment.report`, `onboarding.otp`, `onboarding.starterPack`, `map.wardColors`, `rating.scorecard`, `rating.acknowledgement` — each role/ward-scoped in `/crm/settings`, kill-switchable without redeploy.
