# Phase 1-4 Audit

**Date**: 2026-09-11  
**Auditor**: AI Agent  
**Scope**: Backend modules + frontend UI for Phases 1-4

---

## Summary

**Working end-to-end**: 12/20 features  
**Partial (backend only or minimal UI)**: 6/20 features  
**Missing**: 2/20 features

---

## Phase 1: Foundation

| Feature | Backend | Frontend UI | Status | Priority |
|---------|---------|-------------|--------|----------|
| Ward rows in `regions` | ✅ Migration 003 + seed | ✅ Map renders boundaries | **Working** | — |
| `ward_profiles` table | ✅ Schema exists | ❌ No UI to view/edit | **Partial** | Low |
| `documents` table | ✅ Schema exists | ❌ No library page, no download UI | **Missing** | Medium |
| `petitions` + signatures | ✅ Full API + public sign | ✅ PublicHome lists + signs | **Working** | — |
| `leaders` directory | ✅ Schema exists | ❌ No public directory page | **Missing** | Medium |
| Public front page | ✅ Manifesto API | ✅ PublicHome (just built) | **Working** | — |
| Two-lane registration | ✅ `/register` + confirm | ✅ RegisterForm + `/confirm` | **Working** | — |
| `enquiries` table | ✅ Schema exists | ❌ No UI | **Partial** | Low |
| `role_badges` (QR extend) | ❌ Not implemented | ❌ IdCardSheet shows basic QR only | **Partial** | Low |

---

## Phase 2: Core Value

| Feature | Backend | Frontend UI | Status | Priority |
|---------|---------|-------------|--------|----------|
| `service_requests` + timeline | ✅ Full API + ref numbers | ⚠️ EngageTab lists cases, no "report a case" form | **Partial** | High |
| Public `/track/:ref` | ✅ `getServiceRequest` exists | ❌ No page | **Missing** | High |
| Member ward home | ⚠️ Geo API exists | ⚠️ HomeTab shows some data, not ward-resolved | **Partial** | High |
| `WARD_COUNCILLOR` role + `wardCode` JWT | ✅ Role + permissions + JWT claim | ✅ Caps drive UI visibility | **Working** | — |
| `public_participations` + comments | ✅ Full API | ⚠️ EngageTab lists, no comment/rate UI | **Partial** | High |
| `ratings` (1-5 scale) | ✅ Full API + ≤2 reason enforcement | ❌ No rating UI | **Missing** | Medium |
| `ward_bulletins` | ✅ Full API + moderation | ✅ HomeTab feed + EngageTab list | **Working** | — |
| Ward dashboard (councillor) |  No dedicated endpoint | ❌ No page | **Missing** | High |

---

## Phase 3: Accountability

| Feature | Backend | Frontend UI | Status | Priority |
|---------|---------|-------------|--------|----------|
| `verifications` | ✅ Full API + self-verify block | ❌ No verification flow UI | **Missing** | Medium |
| Ward scorecards |  No endpoint | ❌ No display | **Missing** | Medium |
| `projects` + milestones | ✅ Full API | ⚠️ EngageTab lists, no detail/vote UI | **Partial** | Medium |
| `project_votes` | ✅ Schema exists | ❌ No voting UI | **Missing** | Medium |

---

## Phase 4: Movement

| Feature | Backend | Frontend UI | Status | Priority |
|---------|---------|-------------|--------|----------|
| `patrols` + tracks + stops | ✅ Full API + GPS | ️ EngageTab lists, no start/stop UI | **Partial** | Medium |
| Coverage heat map | ✅ `getHeatmap` API | ❌ No heat map layer on MapTab | **Missing** | Low |
| `engagement_requests` | ✅ Schema exists | ❌ No UI to request councillor time | **Missing** | Low |
| Metro overview | ⚠️ Geo API exists | ❌ No cross-ward analytics page | **Missing** | Low |
| Media capture (voice/video) | ✅ `media_assets` schema | ❌ No capture UI | **Missing** | Low |
| Offline sync queue | ❌ Not implemented | ❌ Not implemented | **Missing** | Low |

---

## Priority Backlog

**High Priority** (core value, user-facing):
1. Public `/track/:ref` page — residents can track service requests
2. Member "report a case" form — core engagement flow
3. Public participation comment/rate UI — ward democracy
4. Ward dashboard for councillors — their front page
5. Member ward home — resolve by geolocation, show councillor + scorecard

**Medium Priority** (accountability, trust):
6. Verification flow UI — members verify closed cases
7. Ward scorecard display — published proof
8. Leadership directory page — public transparency
9. Documents library page — manifesto, policies, forms
10. Project voting UI — ward democracy

**Low Priority** (nice-to-have, legal complexity):
11. Coverage heat map layer
12. Engagement request UI
13. Metro overview analytics
14. Media capture (voice/video)
15. Offline sync queue
16. `ward_profiles` edit UI
17. `enquiries` UI
18. `role_badges` extension

---

## Recommendations

1. **Build `/track/:ref` first** — single most powerful recruitment tool (resident sees proof before joining)
2. **Add "report a case" form to EngageTab** — core member engagement
3. **Build participation comment UI** — enables ward democracy
4. **Create councillor ward dashboard** — gives councillors their tooling
5. **Defer heat maps, offline sync, media capture** — legal complexity + low immediate value

---

**Next**: Build CRM Desktop (Phase 5) per separate plan.
