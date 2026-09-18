# UDF Member Experience, Brand Presentation, Starter Pack & Device-Bound Authentication — Product Requirements Document

| Field | Value |
|---|---|
| Document | PRD-2026-09-15 Member Experience & Device-Bound Auth (Wave 6) |
| Version | 1.1 (Draft for approval — amended 2026-09-15: 6-character password minimum withdrawn, §7.2) |
| Status | Pending National Administrator sign-off |
| Owner | Product (UDF) |
| Related artefacts | `PRD.md` (FR-A–J), `PRD-jobs.md` (FR-K–N), `PRD-growth.md` (FR-O–S), `DESIGN.md`, `deploy/RUNBOOK.md` §15 |
| Scope | Mobile app (Capacitor/Next.js export) + public website + CRM Desktop (`/crm`) + Express/Postgres backend |
| FR range claimed | **FR-T … FR-AC** (FR-A–FR-S are already in use) |
| Planned migrations | `023_device_sessions.sql`, `024_message_audience.sql` |
| Hard dependency | Hostname cutover to `crm.udf-party.co.za` (see §9.1) — FR-AC cannot be satisfied while `PUBLIC_BASE_URL` is a raw IP |

---

## 1. Executive summary

This PRD closes the gap between what the UDF platform *does* and what a real member *sees* on their first contact with it. Today a prospective member lands on a page whose logo is a 42-pixel thumbnail, is invited to sign in on a form that **pre-fills a developer's email address (`admin@party.example`) and prints the seeded admin password in plain text underneath it**, and — if they register — is handed a screen containing three raw URLs, one of which points at a bare IP address with a self-signed certificate. The party's own published contact details are still American placeholders: `+1 (555) 010-1985` and `info@udfparty.example`.

In one paragraph: **brand presentation** is corrected across the three public surfaces (landing, member sign-in, Join the UDF) — the UDF mark is tripled in size, the Android launcher icon is regenerated as a safe-area-padded flag mark so Android's round and squircle masks stop clipping it, and the stray typographic dashes are removed from member-facing copy. The **placeholder party identity is replaced with the real one** (`info@udf-party.co.za`, `www.udf-party.co.za`), and the fictitious telephone and WhatsApp numbers are deleted rather than replaced. The **sign-in page is de-seeded**: no pre-filled address, no demo credentials block. The **Join form** renames *Address* to *Area* and gives it a full-width row of its own, and the **post-submission screen is reduced to exactly one artefact — the membership confirmation link** — with the public party card and the referral link removed. New members receive a **starter pack email carrying the Election Manifesto (Local Government 2026) as an attached PDF**, which requires generic (non-inline) attachment support in the mail layer for the first time. **Authentication becomes device-bound**: a member's device is remembered, only one device may hold a live session at a time, and signing in from a new device requires a fresh email OTP. The **password minimum stays at 10 characters** — a shorter 6-character floor was considered and rejected on security grounds (§7.2). **Messages** gain a real audience model (members / staff / everyone) *and* a national delivery log, so an administrator finally sees every message the platform has sent rather than only the ones addressed to them. Finally, a **leakage rule** forbids raw URLs, IP addresses, API paths and internal hostnames from every member-facing surface.

Nothing here alters the sealed-PII model, the blind indexes, or the hash-chained `audit_log` guarantees.

---

## 2. Goals & non-goals

**Goals**
- G1: Make the UDF mark legible and dominant on all three public surfaces, and make the Android launcher icon render un-clipped on every mask shape.
- G2: Replace every placeholder party contact detail with the real one, and delete the ones the party does not have.
- G3: Remove all developer/demo scaffolding from the member sign-in surface.
- G4: Simplify the Join form (Area field, full width) and reduce the post-submit screen to the single link a member actually needs.
- G5: Deliver the Election Manifesto to every new member as an email attachment that works offline.
- G6: Bind a member's session to one remembered device; re-verify by email OTP on device change.
- G7: Strengthen account security through the device gate, without weakening the existing password floor.
- G8: Give messages a real audience model and give national staff a complete delivery log.
- G9: Guarantee that no URL, IP address, API path or internal hostname is ever rendered to a member or embedded in member-facing email.

**Non-goals**
- NG1: No SMS OTP (email only), consistent with `PRD.md` NG4.
- NG2: No redesign of the CRM desktop shell, its navigation, or any staff workflow beyond the messages surfaces named in FR-AB.
- NG3: No change to the sealed-PII model, blind indexes, envelope encryption, or `audit_log` hash chain.
- NG4: No i18n. English only.
- NG5: No member-to-member direct messaging. FR-AB extends *broadcast* audience and *staff visibility* only.
- NG6: No biometric or hardware-attested device identity. Device identity is the existing `x-device-id` client token (§7.3 states the threat model honestly).
- NG7: No new member-facing document library. The manifesto ships as an email attachment plus the existing `/manifesto` screen; a general document repository is out of scope.

---

## 3. Current-state findings (verified in code)

These are the facts the requirements below act on. Each was read from source, not assumed.

| # | Finding | Location |
|---|---|---|
| C1 | `Logo` takes a `size` prop (px, default 32) and renders `/brand/udf-illustration.png` with `objectFit: cover`, `borderRadius: 20%`. | `frontend/src/components/Logo.tsx` L15–L29 |
| C2 | Sign-in logo is `size={44}`; landing hero is `size={42}`; public pages (join/confirm/verify) use `PublicFrame` at `size={34}`. | `login/page.tsx` L66; `public/PublicHome.tsx` L58; `PublicFrame.tsx` L30 |
| C3 | The sign-in email field is **pre-filled** with `'admin@party.example'` via `useState`. It is initial *state*, not a placeholder — so it submits as typed if untouched. | `frontend/src/app/login/page.tsx` L17 |
| C4 | The sign-in page prints seeded admin credentials: `Demo (after npm run db:seed): admin@party.example / ChangeMe!12345`. | `login/page.tsx` L121–L124; styled `.udf-login-demo` in `login/login.css` L116–L126 |
| C5 | Party contacts are **hardcoded placeholders**, served to the app by the public API — not database rows: `phone: '+1 (555) 010-1985'`, `whatsapp: '+1 (555) 010-1986'`, `email: 'info@udfparty.example'`, `press: 'press@udfparty.example'`, `website: 'https://udfparty.example'`, `address: 'UDF National Secretariat, 1 Front Road, Capital City'`. | `backend/src/modules/public/content.ts` L12–L19 |
| C6 | The landing footer and the Join page render those contacts verbatim; there is no hardcoded phone number anywhere in the frontend. | `PublicHome.tsx` L110–L121; `public/JoinPage.tsx` L61–L73 |
| C7 | The em dash the landing page shows under the logo comes from `MANIFESTO.mission` (`…dignified services, honest work and safe neighbourhoods — and to hold every…`). `officeHours` also carries en dashes. | `content.ts` L27, L20 |
| C8 | The Join page shows an `Office` / `WhatsApp` / `Email` key-value block sourced from C5. | `JoinPage.tsx` L61–L73 |
| C9 | The register form's `Address` field sits inside `.form-grid` (`grid-template-columns: 1fr 1fr`). A `.form-grid .full { grid-column: 1 / -1 }` rule **already exists** and is the intended full-width escape hatch. | `RegisterPanel.tsx` L295–L336; `globals.css` L1350, L1356 |
| C10 | Post-submit, `Registered` renders **three** link boxes: confirmation link (L609–L622), public party card / `verifyUrl` (L624–L637), referral link / `joinUrl` (L639–L649), plus a `ShareCard`. Each prints its raw URL inside a `<code>` element. | `RegisterPanel.tsx` L571–L659 |
| C11 | Password minimum is **10** characters at every entry point: `createUserSchema` and `changePasswordSchema`. `loginSchema` allows min 1 so a 6-digit OTP can be posted as a password. | `backend/src/modules/auth/service.ts` L25–L47 |
| C12 | Hashing is argon2id, `memoryCost 19*1024`, `timeCost 2`, `parallelism 1`. | `backend/src/security/password.ts` L7–L14 |
| C13 | Refresh tokens **are** stored server-side as SHA-256 hashes with `revoked_at`, `ip`, `user_agent` columns — so revocation and therefore single-device enforcement are already structurally possible. | `migrations/001_init.sql` L94–L104 |
| C14 | `x-device-id` is already accepted in CORS, captured in the auth routes, and checked against a `banned_devices` table. There is **no** trusted-device, session-per-device, or device-fingerprint concept. | `app.ts` L59; `auth/routes.ts` L25–L29; `migrations/011_moderation.sql` L46–L56 |
| C15 | `email_otps.purpose` already permits `'login'` alongside `'onboarding'`, `'password_reset'`, `'ward_change'` — the device-change OTP needs no new enum value. TTL 10 min, max 5 attempts, argon2id-hashed at rest. | `security/otp.ts`; `migrations/020_member_onboarding_otp.sql` L53–L71 |
| C16 | Rate limits exist (login 20/15min, change-password 10/15min, OTP resend 5/15min, global 300/60s) but there is **no per-account lockout**. | `auth/routes.ts` L16–L22, L108–L114, L134–L140; `app.ts` L69–L76 |
| C17 | `notifications.user_id IS NULL` means broadcast-to-everyone; otherwise targeted. There is **no** audience column, and `region_code` is stored but not used to filter. | `migrations/002_engage.sql` L139–L159 |
| C18 | The CRM Notifications page calls `api.listNotifications()`, which returns **the caller's own inbox**. An administrator therefore cannot see messages sent to other people; the page's "delivery log" framing is misleading. It labels broadcasts `'All members'`. | `frontend/src/app/crm/notifications/page.tsx` L28–L44, L126 |
| C19 | The mailer supports `multipart/related` with **CID-inline images only** (councillor and leader photos). Generic document attachments are not supported. | `backend/src/security/mailer.ts` L27–L44, L68–L125 |
| C20 | All email URLs flow through one helper, `appUrl()`, backed by `env.PUBLIC_BASE_URL`. In production that value is **still `https://102.68.98.129`**, so starter-pack links currently show a bare IP. | `onboarding/starterPack.ts` L70–L72; `config/env.ts` |
| C21 | Android launcher icons are **copied, never resized**: `prepare-android-assets.mjs` places the same `mipmap-*.png` into `ic_launcher`, `ic_launcher_round` **and** `ic_launcher_foreground`. Using a full-bleed square as an adaptive *foreground* guarantees clipping, because Android reserves the outer ~33% of the foreground layer for mask bleed. | `frontend/scripts/prepare-android-assets.mjs` L34–L81 |
| C22 | The web manifest declares 192/512/1024 icons that all point at the same `udf-illustration.png`, including `purpose: "any maskable"` — a maskable declaration on unpadded art, which browsers will crop. | `frontend/public/manifest.webmanifest` L13–L32 |
| C23 | No document library, welcome-pack bundle, or static document download endpoint exists. | verified absent |

---

## 4. Personas

| Persona | Relevance to this PRD |
|---|---|
| **Prospective member (unauthenticated visitor)** | Sees the landing page and the Join form. Must never see demo credentials, placeholder contacts, or a raw URL. |
| **New member (first 10 minutes)** | Registers, receives the starter pack with the manifesto PDF and a 6-digit OTP, signs in on one device, sets a ≥10-character password. |
| **Returning member** | Signs in on a remembered device with no OTP friction; is challenged by email OTP when the device changes; is signed out elsewhere when they sign in somewhere new. |
| **National Administrator** | Needs a complete message delivery log across all recipients, and an audience selector when composing. |
| **Ward councillor / organiser (staff)** | Newly able to *receive* broadcasts addressed to staff. |

---

## 5. Functional requirements

### FR-T — Brand presentation

- **FR-T1 (Logo ×3).** Triple the rendered UDF mark on the three public surfaces: member sign-in `44 → 132`, landing hero `42 → 126`, `PublicFrame` header (Join / confirm / verify) `34 → 102`. Implemented by changing the `size` prop only; `Logo.tsx` itself is not modified.
- **FR-T2 (Layout integrity).** The tripled marks must not break their containers. The sign-in card is `min(420px, 100%)` wide, so a 132 px mark fits with margin; the `PublicFrame` header and landing hero must be visually re-checked at 360 px viewport width (the narrowest Android target) and must not introduce horizontal scroll.
- **FR-T3 (Launcher icon fits).** Regenerate the Android launcher icon as a **flag-only mark on brand red `#C8102E`**, respecting the adaptive-icon safe area: the foreground layer must place all meaningful content within the **central 66 dp of the 108 dp canvas**, so round, squircle and teardrop masks cannot clip it. Deliverables per density for `ic_launcher_foreground` (108 dp canvas): mdpi 108, hdpi 162, xhdpi 216, xxhdpi 324, xxxhdpi 432 px. Legacy `ic_launcher` / `ic_launcher_round` remain full-bleed at 48/72/96/144/192 px.
- **FR-T4 (Generation, not hand-cropping).** Icon production must be a **repeatable script**, extending `scripts/generate-android-assets.mjs`, taking the master art as input and emitting every density. Hand-edited binaries are not acceptable — C21 exists precisely because copying replaced resizing.
- **FR-T5 (Maskable honesty).** In `manifest.webmanifest`, either supply a genuinely padded asset for the `purpose: "any maskable"` entry or drop `maskable` from it. Declaring unpadded art as maskable (C22) is a defect.
- **FR-T6 (Dash removal).** Remove typographic dash separators from member-facing copy: the em dash in `MANIFESTO.mission` (C7) is replaced by a full stop and a new sentence; `officeHours` en dashes become the word `to`. In the Join form, the `— e.g.` / `— type it in full` / `— try typing` placeholder and empty-message dashes (`RegisterPanel.tsx` L302, L305, L376, L378, L420, L422, L493) become plain phrasing without a dash. **Scope note:** this applies to prose shown to members; it does **not** apply to the hyphens inside identifiers such as party codes (`UDF-ABC-XYZ`) or ward codes (`CPT-W068`), which are data and must not be altered.

### FR-U — Real party identity

- **FR-U1.** In `PARTY_PROFILE.contacts` (C5): set `email` to `info@udf-party.co.za`; set `website` to `https://www.udf-party.co.za`.
- **FR-U2.** **Delete** `phone` and `whatsapp`. The party does not publish these numbers, so they are removed rather than replaced — deleting the key, not blanking the string, so no empty row renders.
- **FR-U3.** Set `press` to `info@udf-party.co.za` (single published address) and replace the placeholder `address` with the real secretariat address, or delete the key if none is to be published.
- **FR-U4 (Null-safe consumers).** Every consumer of these fields must render nothing — not `undefined`, not an empty row — when a key is absent. `PublicHome.tsx` L112–L118 already guards `email` and `phone`; the Join page block (C8) does **not** guard and must be made conditional.
- **FR-U5.** No contact detail may be hardcoded in the frontend. `content.ts` remains the single source of truth.

### FR-V — Member sign-in page

- **FR-V1 (No pre-filled address).** The email field initialises to the empty string. A `placeholder` may be used for guidance, but the field's *value* must start empty so an untouched form cannot submit a developer address (C3).
- **FR-V2 (No demo credentials).** Delete the demo block (C4) from the JSX and delete the now-unused `.udf-login-demo` rules from `login.css`. **This is a live production credential disclosure and is the highest-severity item in this PRD.**
- **FR-V3 (Empty box).** The reported "blank box" is the pre-filled field once cleared. After FR-V1 the field must show either a placeholder or a label-only empty state with no stray bordered element beneath it; the rendered form must contain exactly two inputs (email, password).
- **FR-V4 (Retain onboarding help).** The OTP hint under the password field (`login/page.tsx` L95–L98) and the "Email me a sign-in code" action are **kept** — they are how a real new member signs in, and are not demo scaffolding.

### FR-W — Join the UDF form

- **FR-W1 (Area field).** Rename the `Address` label to **`Area`** (`RegisterPanel.tsx` L296). The underlying form key, the API field and the DB column stay `address` — this is a presentation change only, so no migration and no API break.
- **FR-W2 (Full width, own row).** The Area field occupies a full-width row of its own, placed **after** the two-column pairs, by adding the existing `full` class (C9). Both branches — the `Autocomplete` and the plain-input fallback — must be full width.
- **FR-W3 (Contact block).** Remove the `Office` and `WhatsApp` rows from the Join page contact card (C8); keep a single `Email` row bound to `info@udf-party.co.za` via FR-U1, rendered only when the value exists (FR-U4).
- **FR-W4.** Dash removal per FR-T6 applies to this form's labels, placeholders and empty messages.

### FR-X — Post-submission screen

- **FR-X1 (One artefact).** After a successful registration the screen presents **only the membership confirmation link**, with its QR code, `Copy` and `Open` actions. The confirmation-link box (C10, L609–L622) is retained.
- **FR-X2 (Remove public party card).** Delete the `verifyUrl` box (L624–L637).
- **FR-X3 (Remove referral link).** Delete the `joinUrl` box (L639–L649).
- **FR-X4 (Share surface).** The `ShareCard` block must be removed from this screen unless it can be shown to render no URL and no referral code; it is a referral-propagation surface and falls under the same instruction. The member's own `publicCode` may still be displayed as text (it is an identifier, not a link).
- **FR-X5 (No API contract change).** `RegisterResult` continues to carry `verifyUrl` and `joinUrl`; they are simply not rendered here. Staff surfaces that legitimately need them (`InviteGrow`, ID card studio) are untouched.
- **FR-X6 (Link presentation).** Per FR-AC, the confirmation link must not be printed as a raw URL string. It is presented as a QR code plus labelled `Copy` / `Open` actions.

### FR-Y — Starter pack with the Election Manifesto

- **FR-Y1 (Generic attachments).** Extend the mail layer (C19) to carry non-inline attachments. Concretely: a `multipart/mixed` outer part wrapping the existing `multipart/related`/`multipart/alternative` tree, with `Content-Disposition: attachment; filename="…"` and base64 transfer encoding. Inline CID images must continue to work unchanged — this is an additive MIME change and the existing councillor/leader photo path is a regression risk that must be re-tested.
- **FR-Y2 (Manifesto asset).** Convert `Election Manifesto Local Government 1Sept 2026.docx` to a branded PDF and commit it to the repository as a build asset (proposed: `backend/assets/starter-pack/udf-election-manifesto-2026.pdf`). The PDF, not the `.docx`, is what ships: it renders identically on every device and cannot execute macros.
- **FR-Y3 (Attach to starter pack).** `buildStarterPackEmail` attaches the manifesto PDF and references it in the body copy. The OTP resend template (`buildOtpResendEmail`) does **not** attach it — a resend is a code delivery, not a re-onboarding.
- **FR-Y4 (Size budget).** Total assembled message must stay under **10 MB**; the PDF itself should target **under 3 MB**. If conversion exceeds that, images in the PDF must be downsampled. Oversized mail is silently dropped by some providers, which would be invisible to us.
- **FR-Y5 (Starter pack content).** The pack states the member's membership number, their 6-digit OTP and its 10-minute validity, the published contact `info@udf-party.co.za`, the website `www.udf-party.co.za`, the councillor brochure and leader photo (existing behaviour), and the attached manifesto.
- **FR-Y6 (Outbox).** The attachment must not be persisted into `email_outbox` payloads as raw base64 if that table is used for retry — store a reference to the asset instead, or the table will grow by ~3 MB per member.

### FR-Z — Password policy

> **Decision 2026-09-15: no change.** A 6-character minimum was requested, evaluated in §7.2 and **withdrawn by the owner**. The policy below is the *existing* behaviour, restated so this PRD cannot be read as authorising a change.

- **FR-Z1 (Minimum stays 10, all roles).** The password minimum remains **10** characters in `createUserSchema` and `changePasswordSchema` (C11), for every role. `loginSchema` stays at min 1 so a 6-digit OTP can still be posted as a first-run password. **No code change.**
- **FR-Z2 (No complexity rules).** Unchanged: no character-class requirements, as today.
- **FR-Z3 (Hashing unchanged).** argon2id parameters (C12) stay as they are.
- **FR-Z4 (Per-account lockout — deferred, not in this wave).** The platform has **no per-account lockout** today (C16); only IP-based rate limiting. This was originally specified as a mandatory compensating control for the 6-character floor. With the floor staying at 10, it is no longer required, and it is **not requested work** — it is recorded here as a known hardening gap for a future wave rather than silently dropped. If picked up later: 10 consecutive failed attempts locks the account for 15 minutes, counted per user, enumeration-safe (a locked response must be indistinguishable from a wrong password).

**Net effect on implementation: FR-Z requires no code and no migration.** The `failed_login_count` / `locked_until` columns in `023_device_sessions.sql` (§6) are therefore also deferred — see the note there.

### FR-AA — Device-bound authentication

- **FR-AA1 (Remember device).** On successful authentication the presented `x-device-id` (C14) is recorded against the user as a trusted device, with `first_seen_at`, `last_seen_at`, and a user-agent label for display. A returning member on a remembered device signs in with password only — no OTP.
- **FR-AA2 (Single active device).** A member may hold **one** live session at a time. On successful sign-in from a device that is not the current active device, all of that user's existing refresh tokens are revoked and `token_version` is bumped, which invalidates outstanding access tokens too. This reuses the exact mechanism already proven by the change-password flow (C13), so no new revocation machinery is required.
- **FR-AA3 (Device-change OTP).** Signing in from an **unrecognised** device requires a fresh email OTP of `purpose='login'` (C15 — no schema change) *in addition to* the correct password. The new device is trusted only after the OTP verifies.
- **FR-AA4 (Missing device id).** A request with no `x-device-id` must be treated as an unrecognised device, never as a trusted one. Absence must fail closed.
- **FR-AA5 (Scope).** FR-AA1–AA4 apply to `role='member'`. Staff roles keep multi-session access, because a coordinator working a desktop CRM and a phone simultaneously is normal and single-device would break it. *(This is the one place where staff and members deliberately diverge; it is a session-scope decision and is unrelated to password policy.)*
- **FR-AA6 (Self-service visibility).** A member can see their remembered device and sign out of it. A national administrator can clear a member's trusted devices — the required support path when someone loses a phone.
- **FR-AA7 (Audit).** Device trust, device change and forced sign-out all write to `audit_log`.
- **FR-AA8 (Ban interaction).** Trusted-device state must never override `banned_devices` (C14). A banned device is refused even if trusted.

### FR-AB — Messages

- **FR-AB1 (Audience model).** Add an `audience` dimension to notifications with values `members`, `staff`, `everyone`. Migration `024_message_audience.sql` adds the column with a CHECK constraint and backfills existing broadcast rows to `members`, which is what they were in practice (C17).
- **FR-AB2 (Delivery semantics).** For a broadcast, a user sees the message when their role satisfies the audience: `members` → `role='member'`; `staff` → any non-member role; `everyone` → all authenticated users. Targeted messages (`user_id` set) are unaffected.
- **FR-AB3 (Compose).** The CRM composer gains an audience selector (default `members`, preserving today's behaviour). The existing region-code field continues to narrow a broadcast.
- **FR-AB4 (Region filter honesty).** `region_code` is currently stored but never used to filter (C17). Either implement the filter or label the field as metadata in the UI. Shipping a control that silently does nothing is not acceptable.
- **FR-AB5 (National delivery log).** Staff holding the notifications read permission get a **platform-wide** message log — every message sent, to any recipient, with its audience, region and send time — replacing today's misleading self-inbox view (C18). This is the same class of defect as the resident-reports gap fixed on 2026-09-15: the backend held the data and no staff surface exposed it.
- **FR-AB6 (Privacy boundary — hard rule).** The delivery log shows **counts and audience descriptors, never recipient identities**. For a targeted message the log shows that it was sent and to which ward/region, **not** the member's name or email. This preserves the platform-wide rule already stated in `PRD-jobs.md` NG3 and `frontend/src/app/crm/opportunities/page.tsx` ("no member names, emails or recipient lists").
- **FR-AB7 (Scope).** The log is scoped by the existing `wardCodeScope()` helper: national sees all, regional sees its regions, ward sees its ward. It is not an unscoped table dump.
- **FR-AB8 (Labels).** The `'All members'` label (C18) becomes the message's actual audience value.

### FR-AC — No leakage of URLs, IPs, API paths or internal data

- **FR-AC1 (No raw URLs to members).** No member-facing surface may render a URL as visible text. Links are presented as a labelled action (`Open`, `Copy`) or a QR code. This retires the three `<code>{url}</code>` blocks in `Registered` (C10) — FR-X already removes two of them, and FR-X6 covers the third.
- **FR-AC2 (No IP addresses).** No member-facing surface or email may contain an IP address. **This is currently violated in production**: `PUBLIC_BASE_URL` is `https://102.68.98.129`, so every starter-pack link is an IP (C20). Satisfying FR-AC2 therefore *requires* the hostname cutover in §9.1 — it cannot be fixed in application code.
- **FR-AC3 (No API paths).** No member-facing copy may reveal `/api/...` paths, module names or endpoint shapes.
- **FR-AC4 (No internal hostnames).** No reference to `vm478jzwg.yourlocaldomain.com`, `localhost`, or any internal hostname may reach a member. Note the mailer falls back to `hostname()` if `MAIL_FROM` is unset (`mailer.ts` L70) — production must keep `MAIL_FROM` set, which `env.ts` already enforces with a hard exit.
- **FR-AC5 (No developer scaffolding).** No member-facing surface may reference seed commands, seeded accounts or environment names. Enforced by FR-V2.
- **FR-AC6 (Error responses).** Confirmed already compliant: the error handler returns generic messages in production and exposes details only in development. **No change required** — recorded here so the requirement is covered, not re-implemented.
- **FR-AC7 (Automated guard).** Add a check to the pre-build gate (alongside `check-caps.mjs`) that fails the build when member-facing source or email templates contain an IPv4 literal, an `http(s)://` string outside a configuration file, or the token `party.example`. A rule this easy to regress needs a machine to enforce it.

---

## 6. Data model changes

### `023_device_sessions.sql`

```sql
CREATE TABLE trusted_devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  label        TEXT,                    -- derived from user-agent, for display
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  UNIQUE (user_id, device_id)
);
CREATE INDEX trusted_devices_user_idx ON trusted_devices (user_id) WHERE revoked_at IS NULL;
```

The `users.failed_login_count` / `users.locked_until` columns originally specified in this migration are **removed from scope**, because the lockout they supported is deferred (FR-Z4). Do not add unused columns — they would imply an enforcement path that does not exist.

`label` is a coarse user-agent descriptor ("Android phone", "Chrome on Windows"), **not** a fingerprint — consistent with NG6 and with POPIA minimisation.

### `024_message_audience.sql`

```sql
ALTER TABLE notifications
  ADD COLUMN audience TEXT NOT NULL DEFAULT 'members'
    CHECK (audience IN ('members', 'staff', 'everyone'));

-- Existing broadcasts were members-only in practice; the default backfills them.
CREATE INDEX notifications_audience_idx ON notifications (audience, created_at DESC)
  WHERE user_id IS NULL;
```

No changes to `members`, `sealed_pii`, blind indexes, or `audit_log`.

---

## 7. Security analysis

### 7.1 Items that *improve* security

| Change | Effect |
|---|---|
| FR-V2 (remove demo credentials) | Removes disclosure of a real seeded administrator credential pair from a public page. Largest single security win in this PRD. |
| FR-V1 (no pre-filled admin email) | Stops the login form from nominating an administrator account as the default subject of every brute-force attempt. |
| FR-AA2/AA3 (single device + device OTP) | Adds a second factor on the event that matters (new device) and caps stolen-credential value to one concurrent session. |
| FR-Z1 (password floor held at 10) | The proposed reduction to 6 was withdrawn, so no weakening is introduced. |
| FR-AC (leakage rules) | Reduces reconnaissance surface. |

### 7.2 Considered and rejected: 6-character password minimum

**Status: withdrawn 2026-09-15 by owner decision. The minimum stays at 10 for all roles.** Retained as a record of the analysis so the question is not re-opened without the reasoning.

A 6-character minimum for every role, `national_admin` included, was requested and specified. The assessment that led to withdrawal:

- A 6-character password from a realistic human alphabet is **offline-crackable in hours to days** if the hash database is ever exfiltrated. argon2id at 19 MiB / t=2 (C12) raises the cost per guess substantially but does not change the order of magnitude for a secret that short.
- The `national_admin` role can read the member register, so the blast radius of one compromised administrator account is the entire membership.
- Online guessing would have been adequately contained by lockout plus the existing IP limiter, so the residual exposure was concentrated on **offline** attack after a database compromise, and on **password reuse**.
- Because members are onboarded with a 6-digit OTP and then forced to choose their own password, the 10-character floor applies only at the moment they set a real password — it is not friction on the sign-in path, which was the original motivation for shortening it.

**Outcome:** the floor is held at 10, the compensating lockout that would have been mandatory is no longer required (FR-Z4 records it as a deferred hardening gap), and no security trade-off is being accepted in this wave.

### 7.3 Device identity threat model (stated honestly)

`x-device-id` is a **client-supplied token**, not an attested identity. An attacker who has both a member's password *and* a captured `x-device-id` can present as the trusted device and bypass FR-AA3's OTP. This is acceptable because:
- obtaining the device id requires prior compromise of the device or the transport, and the transport is TLS;
- the alternative (hardware attestation) is explicitly out of scope (NG6).

It must not be described to members as two-factor authentication, because on a remembered device it is not.

---

## 8. Acceptance criteria

**Brand**
- AC-T1: On sign-in, landing and Join, the UDF mark measures 132/126/102 px respectively.
- AC-T2: At a 360 px viewport, none of the three pages scrolls horizontally.
- AC-T3: The launcher icon shows no clipping of the flag under circle, squircle, rounded-square and teardrop masks on an API 26+ device or emulator.
- AC-T4: Re-running the icon generator reproduces every density byte-for-byte from the master art.
- AC-T5: No member-facing string contains ` — ` or ` – `. Party codes and ward codes still contain their hyphens.

**Identity**
- AC-U1: `GET /api/public/meta` returns `contacts.email === 'info@udf-party.co.za'` and `contacts.website === 'https://www.udf-party.co.za'`.
- AC-U2: The response contains **no** `phone` and **no** `whatsapp` key.
- AC-U3: The landing footer and the Join contact card render an email row and no empty rows.
- AC-U4: `grep -rE "555|udfparty\.example"` over `backend/src` and `frontend/src` returns nothing.

**Sign-in**
- AC-V1: The email field is empty on first paint.
- AC-V2: The page source contains no occurrence of `ChangeMe`, `db:seed`, or `party.example`.
- AC-V3: The form contains exactly two `<input>` elements.
- AC-V4: The OTP hint and "Email me a sign-in code" button are still present and functional.

**Join & post-submit**
- AC-W1: The label reads `Area`.
- AC-W2: The Area field spans the full grid width on its own row, in both the autocomplete and fallback branches.
- AC-W3: A registration payload still submits `address`, and the stored member row is unchanged in shape.
- AC-X1: After a successful submit, exactly one link box is rendered, titled for the membership confirmation link.
- AC-X2: The words "Public party card" and "Referral link" do not appear.
- AC-X3: No `<code>` element on the screen contains `http`.

**Starter pack**
- AC-Y1: A member registered end-to-end receives an email with exactly one PDF attachment named `udf-election-manifesto-2026.pdf` that opens without error.
- AC-Y2: The councillor and leader inline images still render (explicit regression check for FR-Y1).
- AC-Y3: The assembled message is under 10 MB.
- AC-Y4: An OTP-resend email carries no attachment.
- AC-Y5: The email body shows `info@udf-party.co.za` and `www.udf-party.co.za`.

**Password & device**
- AC-Z1: A 9-character password is **rejected** and a 10-character one accepted — i.e. the existing policy is provably unchanged by this wave (regression check only; no new behaviour).
- AC-AA1: A member signing in twice on the same device is not asked for an OTP the second time.
- AC-AA2: Signing in on device B invalidates device A's session; device A's next API call returns 401.
- AC-AA3: Signing in on an unrecognised device requires a `purpose='login'` OTP; a correct password alone is refused.
- AC-AA4: A request with no `x-device-id` is treated as unrecognised.
- AC-AA5: A staff account retains two concurrent sessions.
- AC-AA6: A banned device is refused even after being trusted.

**Messages**
- AC-AB1: A broadcast with `audience='staff'` is visible to a ward councillor and **not** to a member.
- AC-AB2: A broadcast with `audience='everyone'` is visible to both.
- AC-AB3: Pre-existing broadcasts remain visible to members after migration.
- AC-AB4: A national admin sees a message sent to a member they are not, in the delivery log.
- AC-AB5: The delivery log renders no member name or email address anywhere.
- AC-AB6: A ward-scoped coordinator does not see another ward's messages.

**Leakage**
- AC-AC1: No member-facing rendered page contains an IPv4 literal.
- AC-AC2: A starter-pack email contains no IPv4 literal (**blocked until §9.1 completes**).
- AC-AC3: The new build guard fails a commit that reintroduces an IP literal or `party.example`.

---

## 9. Dependencies & sequencing

### 9.1 Blocking dependency: the `crm.udf-party.co.za` cutover

**FR-AC2 and AC-AC2 cannot be met by application code.** While `PUBLIC_BASE_URL` is `https://102.68.98.129`, every starter-pack link is an IP address with a self-signed certificate.

Current status as verified on 2026-09-15:
- `crm.udf-party.co.za` **now resolves** to `102.68.98.129` on ns1/ns3/ns4;
- the stray apex `A 169.239.180.4` that previously broke Let's Encrypt multi-perspective validation **is gone** — all four authoritative nameservers now return only the correct address;
- SPF, DKIM (`udf2026`) and DMARC are published and verified; Gmail accepts mail from `no-reply@udf-party.co.za`;
- **no** certificate has been issued and **no** nginx/env change has been applied. Production is untouched.

Remaining steps (already scoped, blocked only on go-ahead): add `crm.udf-party.co.za` to the ACME `:80` block and the `:443` vhost `server_name`; issue the certificate with `certbot certonly --webroot` (**not** `certbot --nginx`, which would collide with the panel's `:80 default_server`); switch the vhost to the LE certificate; set `PUBLIC_BASE_URL`, `CORS_ORIGINS` and `ENABLE_HSTS`; rebuild the APK against the new API base and switch the Android network-security-config from the bundled self-signed anchor to the system CA store. The IP path and `block-direct-ip.conf` must stay alive until every fielded APK is replaced.

### 9.2 Recommended phasing

| Phase | Contents | Rationale |
|---|---|---|
| **1 — Ship immediately** | FR-V (de-seed sign-in), FR-U (real contacts), FR-T1/T2/T6 (logo sizes, dashes), FR-W, FR-X | Pure frontend/content. No migration, no infrastructure. Contains the credential-disclosure fix, which should not wait behind anything. |
| **2 — Infrastructure** | §9.1 cutover | Unblocks FR-AC2. Requires a production maintenance window and an APK rebuild. |
| **3 — Assets** | FR-T3/T4/T5 (icon regeneration), FR-Y2 (manifesto PDF) | Needs artwork and document conversion; independent of code. |
| **4 — Backend** | FR-Y1/Y3–Y6 (attachments), FR-AA (devices, `023`), FR-AB (messages, `024`) | Migrations and auth changes. FR-Z is **not** in this phase — it requires no code (§7.2). |
| **5 — Guards** | FR-AC7 | Locks in phases 1–4 against regression. |

---

## 10. Out of scope / explicitly unchanged

- Sealed PII, blind indexes, envelope encryption, `audit_log` hash chain.
- The CRM shell, its navigation and all staff workflows except the messages surfaces in FR-AB.
- The recruitment tree, ratings, jobs register, resident reports, ID card studio.
- `RegisterResult`'s API shape (FR-X5).
- The `members.address` column and the `address` API field (FR-W1 is a label change only).
- Error-handler behaviour (FR-AC6 — already compliant).

---

## 11. Open questions for sign-off

- ~~**Q1 (security).** Whether the 6-character password minimum should apply to `national_admin`.~~ **Resolved 2026-09-15: withdrawn entirely — the 10-character minimum stays for all roles (§7.2, FR-Z1).**
- **Q2.** Should `PARTY_PROFILE.contacts.address` carry the real secretariat address, or be removed (FR-U3)?
- **Q3.** Is a single published address (`info@udf-party.co.za`) also correct for **press** enquiries, or is a separate press address wanted later?
- **Q4.** FR-X4: remove the "Spread the word" share card from the post-submit screen entirely, or keep a URL-free variant?
- **Q5.** FR-AB4: implement the region filter, or relabel the field as metadata?
- **Q6.** FR-AA6: should a member be able to sign out their own remembered device from within the app in this wave, or is administrator-assisted reset sufficient for v1?
- **Q7.** Does the manifesto PDF need a designed cover page, or is a clean text conversion of the `.docx` acceptable for the first send?
