# UDF Ward Job Interest Register & Opportunity Relay — Product Requirements Document

| Field | Value |
|---|---|
| Document | PRD-2026-09-12 Ward Jobs (Job Interest Register) |
| Version | 1.0 (Draft for approval) |
| Status | Pending National Administrator sign-off |
| Owner | Product (UDF) |
| Related artefacts | `PRD.md` (Ward Transparency & CRM Moderation), `DESIGN.md`, `backend/src/auth/permissions.ts`, migrations `001`–`006` |
| Scope | Mobile app (Capacitor/Next.js export) + CRM Desktop (Next.js `/crm`) + Express/Postgres backend |
| Planned migration | `007_jobs.sql` |

---

## 1. Executive summary

This PRD specifies a **ward-scoped job interest register** and an **opportunity relay**. In one paragraph:

A **confirmed member** of a ward can add themselves, from the app, to a **work-interest register** capturing only their **name, surname, email address, type of work sought and work experience/skills**. **No CV, no documents, no ID numbers, no addresses are ever uploaded or stored.** The register exists purely as an **indication of job needs within the ward**. The **ward councillor** sees only **aggregate demand** ("14 members available for labourer work, 6 for catering") — never a personal list — giving them a credible, PII-free briefing pack for **project companies and businesses entering the ward** that need labourers, catering or any form of local service. When a **job or advertisement becomes available** (typically from a project running in that ward), the councillor or staff records it as an **opportunity**; the platform **notifies matched members through the platform and by email**, instructing them to **send their application directly to that particular company**. The platform never intermediates applications, never collects CVs, and never hands a contact list to any third party.

This complements the Transparency PRD: projects (FR-D3 there) show *what was built*; this PRD shows *who in the ward wants the work that comes with it*.

---

## 2. Goals & non-goals

**Goals**
- G1: Give ward members a frictionless way (mobile app) to indicate they are looking for work — minimal data, no uploads.
- G2: Give the ward councillor a **sense of job needs within the ward** as aggregate counts by work type / skill, to share with project companies and local businesses.
- G3: When a job or advertisement becomes available, **inform matched members via the platform (and email)** and direct them to apply **to the company itself**.
- G4: Strict POPIA minimisation: name + email + work type + experience only; withdrawable at any time; no third-party disclosure of personal data.
- G5: CRM visibility: councillors manage opportunities and view ward demand; regional/national view cross-ward demand analytics; all gated by RBAC and audited.

**Non-goals**
- NG1: **No CV / document / photo uploads of any kind.** The platform is a database of interest indications, not a recruitment portal. (Hard product rule — repeat in UI copy.)
- NG2: No application tracking, no employer accounts, no placement outcomes SLA. The relay ends at "member informed, applies directly to company".
- NG3: No sharing/exporting of member names or emails to companies, councillors or anyone else. Employers receive **aggregates only**; individual members are contacted **only by the platform**.
- NG4: No scraping or auto-import of external job adverts; opportunities are manually recorded by councillor/staff (consistent with the manual municipal-integration decision).
- NG5: No i18n (English only), no SMS in v1 (in-app + email only).
- NG6: Visitors and members of other wards cannot see ward demand detail or register interest outside their own ward.

---

## 3. Personas & roles

Mapped 1:1 to `Role` in `backend/src/auth/permissions.ts`.

| Role | Responsibilities in this PRD |
|---|---|
| Member (`member`) | Adds/edits/withdraws **own** job interest (name, surname, email, work type, experience) from the app; sees own status; sees opportunities published for **own ward**; receives match notifications; applies directly to the company. |
| Ward Councillor (`ward_councillor`) | Sees **aggregate** ward demand (counts by work type/skill, trend, availability); records **opportunities** (jobs/adverts from project companies or local businesses) with the company's direct contact; publishes → platform notifies matched members; sees notification delivery counts only. |
| Local Coordinator (`local_coordinator`) | May record opportunities on behalf of a ward in their branch scope (same aggregate-only view; cannot export contacts). |
| Regional Organizer (`regional_organizer`) | Cross-ward **aggregate** demand analytics for the region; may publish region-wide opportunities scoped to selected wards. |
| National Administrator (`national_admin`) | Full aggregate analytics; owns the work-type taxonomy; owns feature flags/kill-switch; audit oversight. |
| Analyst (`analyst`) | Read-only aggregate demand reports (no personal data, consistent with sealed-PII discipline). |
| Visitor / other-ward member | **No access** to demand data or opportunity lists outside their ward. Public surface shows at most "N people in this ward are registered as looking for work" as an anonymous count (optional, flag-gated). |

---

## 4. Terminology

| Term | Definition |
|---|---|
| Job interest (register entry) | One member's indication of availability: name, surname, email, work type(s), experience summary. The **only** personal data in this feature. |
| Work type | Controlled taxonomy (seeded): `labourer, catering, cleaning, security, driving, construction, plumbing, electrical, painting, gardening, retail, admin, healthcare, teaching, it, other`. Owned by national admin. |
| Experience / skills | Short free-text (≤240 chars) — "3 years site labourer, forklift ticket". No documents. |
| Ward demand | Aggregate, PII-free counts of job interests per ward, sliced by work type and recency. The councillor's briefing pack for incoming project companies. |
| Opportunity | A job or advertisement recorded on the platform for a ward: title, company/employer name, work type(s), short description, **company contact** (email/portal/phone), optional link to the ward `project`. Status lifecycle below. |
| Match | A job interest whose work type intersects an opportunity's work types, in the same ward, not withdrawn. |
| Relay | Platform-generated notification (in-app + email) to each matched member: "Opportunity in your ward — apply directly to {company} at {contact}". |
| Reference number | Opportunity code `UDF-JOB-W{ward}-NNNNNN` (same family as service-log refs, FR-I of the Transparency PRD). |

**Opportunity state machine:** `draft → published → (notified) → closed | expired`. `published` triggers the relay; `closed` is manual (filled/withdrawn by company), `expired` automatic after `expires_at`. Only `published` opportunities are member-visible.

---

## 5. Functional requirements

### 5.1 FR-K — Member job interest registration (app)
- **FR-K1** A signed-in **member** can open a "Looking for work" card in the app (Engage tab section) and submit: **first name, surname, email, work type(s) (≥1), experience summary (optional, ≤240 chars)**. Email is pre-filled from the account where available and editable.
- **FR-K2** The form states verbatim: *"This is an indication only. Do not upload a CV or any documents. When a job becomes available in your ward we will notify you here and by email so you can apply directly to the company."*
- **FR-K3** The register is **ward-scoped to the member's own ward** (JWT `wardCode`); a member cannot register interest in another ward. If the member changes ward (Transparency PRD FR-G), the interest follows the member to the new ward automatically.
- **FR-K4** One active interest per member; re-submitting **updates** it (skills/work types change over time). `updated_at` is tracked so demand can be filtered to "active in last 90 days".
- **FR-K5** The member can **withdraw** at any time (single tap, no reason required). Withdrawal is a **hard delete** of the personal row (POPIA minimisation); only an anonymous count is retained in aggregate history.
- **FR-K6** Members see opportunities **published for their ward**, newest first, with title, company, work types, short description, reference number, closes date, and the **company contact / how to apply**. The platform's role ends at display + notification; a persistent hint reads: *"Apply directly to the company. UDF never collects CVs."*
- **FR-K7** No document upload control may exist anywhere in this flow (no file input, no camera, no attachment field) — enforced in code review and acceptance tests.

### 5.2 FR-L — Ward demand view (councillor / staff, aggregates only)
- **FR-L1** The ward councillor sees a **demand dashboard** for their own ward: total active interests, breakdown **by work type**, breakdown by experience keywords (top terms), 30/90-day trend, and "available now" count.
- **FR-L2** The dashboard contains **no names, no emails, no per-person rows** — in any view, export or API response. This is the pack the councillor takes to project companies and businesses working in the ward ("if they need labourers, catering, any form of services in the area the project runs in").
- **FR-L3** Regional organizers see the same aggregates across wards in their region; national/analyst see metro-wide aggregates. Drill-down never goes below ward level.
- **FR-L4** Optional public surface (flag-gated, default off): the ward transparency overview (FR-C of `PRD.md`) may show one anonymous cell — "People looking for work: N". Never a list.
- **FR-L5** Every demand view render is audited (`recordAudit` action `jobs.demand.read`, ward scope) as evidence that no personal data left the aggregate boundary.

### 5.3 FR-M — Opportunity recording & relay (councillor / staff)
- **FR-M1** A councillor (own ward) or staff (scoped) can record an **opportunity**: title, company/employer, work type(s), short description (≤600 chars), **company application contact** (email and/or phone and/or URL — the destination members apply to), optional linked ward `project_id`, optional `closes_at`.
- **FR-M2** On **publish**, the platform computes matches (same ward, work-type intersection, not withdrawn) and sends: (a) an **in-app notification** (existing `app_notifications` spine) and (b) an **email** to each matched member containing the opportunity details and the company contact, with the instruction to apply directly. Emails are sent from the platform; **the company never receives the member list**.
- **FR-M3** Each opportunity carries reference `UDF-JOB-W{ward}-NNNNNN`, shown in the notification, the email and the member list view (traceability, mirrors FR-I).
- **FR-M4** The councillor sees **delivery counts only**: matched N, notified N, in-app delivered N, emails sent/failed N. No recipient identities beyond counts (recipient list exists transiently in the outbox and is not exposed in any UI/API).
- **FR-M5** Opportunity edits after publish (e.g. corrected contact) re-notify only if work types or contact changed, and say "updated" in the notification. `close`/`expire` removes it from member lists; already-sent notifications remain as history.
- **FR-M6** Duplicate guard: publishing the same title+company within 14 days warns the author (prevents notification spam).
- **FR-M7** All create/publish/close transitions are audited and (once Transparency PRD FR-F ships) councillor-authored opportunity announcements may optionally route through the moderation queue — flag-gated, default off in Phase A.

### 5.4 FR-N — CRM Desktop surfaces
- **FR-N1** New **Work Demand** page (`/crm/work-demand`): ward selector (scope-filtered by role), aggregate dashboard per FR-L, trend chart, CSV export of **aggregates only** (columns: ward, work type, count, period — no personal fields exist to export).
- **FR-N2** New **Opportunities** page (`/crm/opportunities`): queue by status, author, ward; create/edit/publish/close; per-opportunity delivery counts; reference numbers; filter by work type/ward/age.
- **FR-N3** Mobile councillor flow mirrors FR-N2 (create/publish from the app, Engage tab "Jobs" section) since councillors work in the field; CRM is the analytics and administration surface.
- **FR-N4** Extend **Settings** (`/crm/settings`): work-type taxonomy editor (national only), relay email template, feature flags `jobs.register`, `jobs.relay`, `jobs.publicCount`, demand staleness window (default 90 days), duplicate-guard window.
- **FR-N5** Gating: `/crm/work-demand` and `/crm/opportunities` require `jobs:demand_read` / `jobs:opportunity_write` per §7; sidebar entries appear only for entitled roles.

---

## 6. Data model (new migration `007_jobs.sql`)

| Change | Type | Purpose |
|---|---|---|
| `work_type` | new enum/text-check domain (seeded list, §4) | FR-K1 taxonomy |
| `job_interests` | new table `(id uuid pk, member_id uuid → members.id unique-active, ward_code text → regions.code, first_name text, surname text, email citext, work_types text[], experience text check length ≤240, status text check ('active','withdrawn'), created_at, updated_at)` + partial unique index on `member_id where status='active'` | FR-K register |
| `job_opportunities` | new table `(id, ward_code, ref_no text unique, title, company, work_types text[], description ≤600, contact_email, contact_phone, contact_url, project_id null → projects.id, status ('draft','published','closed','expired'), created_by, published_at, closes_at, expires_at, created_at)` | FR-M |
| `job_opportunity_stats` | new table `(opportunity_id pk, matched int, notified_inapp int, emailed int, email_failed int)` | FR-M4 counts (counts only — no recipient rows) |
| `job_demand_daily` | new rollup `(ward_code, work_type, day, active_count)` refreshed on change | FR-L trend without scanning personal rows |
| Reuse | `app_notifications` (in-app relay), `audit_log` (all reads/writes), outbox/email sender (relay emails) | FR-M2 |

**POPIA notes.** `job_interests` holds the only personal data: name, email, work types, experience. Email is stored in clear **for communication purposes only** (this row is never public and never aggregated with identity); withdrawal hard-deletes the row. No CV/document columns exist. `job_opportunity_stats` deliberately stores counters, not recipient lists, so no query can reconstruct who was told what beyond the transient send. Indexes: `(ward_code, status)`, GIN on `work_types` for both tables.

---

## 7. API surface & RBAC deltas

New `Permission` constants: `JOBS_INTEREST_WRITE ('jobs:interest_write')`, `JOBS_DEMAND_READ ('jobs:demand_read')`, `JOBS_OPPORTUNITY_WRITE ('jobs:opportunity_write')`.

| Role | Adds |
|---|---|
| member | `jobs:interest_write` (own row only, ward-gated server-side) |
| ward_councillor | `jobs:demand_read` (own ward), `jobs:opportunity_write` (own ward) |
| local_coordinator | `jobs:demand_read` + `jobs:opportunity_write` (branch wards) |
| regional_organizer | `jobs:demand_read` (region), `jobs:opportunity_write` (region) |
| national_admin | all three (national) + taxonomy ownership |
| analyst | `jobs:demand_read` (aggregates, read-only) |

| Audience | Endpoint | Gate |
|---|---|---|
| Member | `GET/PUT /api/jobs/interest` · `DELETE /api/jobs/interest` | `jobs:interest_write` + own-ward check |
| Member | `GET /api/jobs/opportunities` (own ward, published only) | authenticated member |
| Councillor/staff | `GET /api/jobs/demand?ward=` | `jobs:demand_read` + scope |
| Councillor/staff | `POST/PATCH /api/jobs/opportunities[/:id]` · `POST /:id/publish` · `POST /:id/close` | `jobs:opportunity_write` + scope |
| CRM | `GET /api/crm/jobs/demand` · `GET /api/crm/jobs/opportunities` · `GET .../opportunities/export` (aggregate CSV) | as above, region/national scoping |
| Internal | relay worker: on publish → match → notify + email → write `job_opportunity_stats` | system |

All mutating calls `recordAudit` with ward scope; demand reads audit per FR-L5.

---

## 8. Screen specifications

**Mobile (member):** Engage tab → "Jobs" section: (1) *Looking for work* card — register/edit form (name, surname, email, work-type chips, experience textarea, withdraw button, no-upload disclaimer); (2) *Opportunities in your ward* list — ref number, company, work types, closes date, **Apply directly** contact block.
**Mobile (councillor):** Engage tab → "Jobs" section: (1) *Ward work demand* aggregate card (counts by work type + trend spark); (2) *Post an opportunity* flow (form → publish → delivery counts).
**CRM:** `/crm/work-demand` (analytics + aggregate export), `/crm/opportunities` (queue + lifecycle + counts), Settings additions (taxonomy, template, flags).

---

## 9. Debug & QA flow (how this feature is verified end-to-end)

Built on the diagnostics backbone recommended in `PRD.md` §6 (correlation IDs, client telemetry inbox, audit join). The sanctioned flow for this feature:

1. **Seed & personas.** Use seeded accounts (`member.ward9@udf.example`, `councillor.ward9@udf.example`, `national.admin@udf.example`, password `ChangeMe!12345`, ward `NORTH-W09`). Seed script inserts 3 job interests across 2 work types and 1 draft opportunity for Ward 9 so every screen renders with data on a fresh DB.
2. **API-first verification (curl).** Before touching UI: `PUT /api/jobs/interest` as member → 200; `GET /api/jobs/demand?ward=NORTH-W09` as councillor → aggregates containing **no** `first_name`/`email` keys (assert on raw JSON); as member → 403; `POST /api/jobs/opportunities` + `/publish` → stats row shows `matched>0`; member in another ward → opportunity list empty.
3. **Boundary tests (the POPIA tripwires).** Automated assertions that: no API response under `/api/jobs/*` or `/api/crm/jobs/*` contains `email` or `first_name` except the member's **own** interest row; no upload endpoint exists (route table snapshot test); withdrawal deletes the row (`SELECT count(*)=0`) and demand count drops by 1.
4. **Relay test with outbox capture.** In dev, the email sender writes to a local outbox table/log; publishing an opportunity must produce exactly N emails for N matches, each containing the ref number and company contact and **not** containing any other member's data. In-app notifications verified via `GET /api/notifications`.
5. **UI verification (browser).** Member session: register interest, see disclaimer text, confirm no file input exists in DOM; councillor session: demand card shows counts only; publish flow shows delivery counts. Console must be clean; correlation ID from a failed request must appear in `audit_log.metadata` and (Phase 6) the diagnostics inbox.
6. **Mobile (APK) runbook.** Standard pipeline (`build:mobile` with `NEXT_PUBLIC_API_BASE=http://10.0.2.2:4000/api` → `cap sync` → prepare assets → gradle `assembleDebug`); install on `Pixel_9_Pro`; WebView console via `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` + Chrome DevTools (ADB taps unreliable — drive interactions via CDP).
7. **Feature flags & kill-switch.** `jobs.register` off hides the member card; `jobs.relay` off lets councillors record opportunities **without** notifying (manual briefing mode); `jobs.publicCount` off suppresses the anonymous public cell. A faulty relay is disabled in production without redeploy.
8. **Triage.** Any 5xx on `/api/jobs/*` surfaces in the diagnostics inbox grouped by signature with the correlation ID → jump to audit rows → identify ward/actor/opportunity. Status `open → ack → resolved`, owner assigned (Transparency PRD §6.7).

---

## 10. Acceptance criteria

- **AC-K1**: member registers interest with name/surname/email/1+ work types; second submit updates (still one active row); withdraw hard-deletes; re-register allowed.
- **AC-K2**: the register form and opportunity detail contain **no file-upload control**; disclaimer text present verbatim (FR-K2).
- **AC-K3**: member of Ward A does not see Ward B opportunities; after an approved ward change the interest follows to the new ward and old-ward opportunities disappear.
- **AC-L1**: councillor demand view shows counts by work type for own ward; raw JSON contains no `first_name`/`email` fields; regional/national see only their scope; every view writes a `jobs.demand.read` audit row.
- **AC-L2**: aggregate CSV export contains only ward/work-type/count/period columns.
- **AC-M1**: publish computes matches (ward + work-type intersection, active only) and creates in-app + email relay with ref `UDF-JOB-W{ward}-NNNNNN`; stats show matched/notified counts; no recipient list is exposed by any endpoint.
- **AC-M2**: duplicate title+company within 14 days warns; close/expired removes from member lists; re-publish after contact change marks notification "updated".
- **AC-N1**: `/crm/work-demand` and `/crm/opportunities` render for entitled roles only (sidebar gating + 403 on direct nav for others).
- **AC-P1 (POPIA)**: deletion request = withdraw; no orphan rows in `job_interests`, rollups recount within one refresh; audit shows the deletion.

---

## 11. Rollout plan

- **Phase A — Register + demand (mobile-first):** migration `007`, member interest card, councillor demand card, `/crm/work-demand`, flags `jobs.register` on, `jobs.publicCount` off.
- **Phase B — Opportunity relay:** opportunities CRUD (app + CRM), publish → notify + email, delivery counts, `/crm/opportunities`, flag `jobs.relay` on.
- **Phase C — Analytics & optional public count:** demand rollup trends, regional/national dashboards, evaluate `jobs.publicCount` against the Transparency overview.
- Each phase behind flags (§9.7); APK rebuild per phase via the standard export → cap sync → gradle pipeline.

---

## 12. Risks, assumptions & open questions

| # | Item | Type | Note |
|---|---|---|---|
| 1 | Email stored in clear on `job_interests` (not sealed) | Assumption | Justified: communication-only, never exposed except to the owner; revisit if National Admin requires sealed-PII parity with `users`. |
| 2 | Company contact accuracy | Risk | Councillor-recorded; wrong contact breaks the relay. Mitigation: mandatory contact field + "updated" re-notification (FR-M5). |
| 3 | Expectation management | Risk | Members may believe the platform finds them jobs. Mitigation: verbatim disclaimer (FR-K2), "Apply directly" copy everywhere. |
| 4 | Notification spam | Risk | Duplicate guard (FR-M6) + one relay per publish + rate cap per member per week (config, default 3). |
| 5 | Work-type taxonomy drift | Assumption | Seeded list, national-owned; `other` + free-text experience absorb edge cases. |
| 6 | Demand staleness | Assumption | "Active" = not withdrawn and updated ≤90 days (configurable); stale rows excluded from counts, retained for the member. |
| 7 | Moderation of opportunity text | Open question | Phase A ships without FR-F moderation on opportunities (councillor-authored, ward-scoped, low risk); flag to route via moderation queue later if required. |
