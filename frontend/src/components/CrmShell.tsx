'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '../lib/auth';
import { api, tokenStore } from '../lib/api';
import { Perm, can, type PermName } from '../lib/caps';
import type { AppNotification, Member, Permission, Role, ServiceRequest } from '../types';
import { memberLabel } from './ui';
import { fmtDateTime } from './crm/ui';
import Logo from './Logo';

/**
 * Enterprise CRM Shell — professional desktop layout with sidebar navigation,
 * top bar with search/notifications/profile, breadcrumbs, and auth guard.
 *
 * Two authorisation gates live here, and both are derived from the permission
 * list the server sends with the session rather than from a hand-maintained copy
 * of the role matrix (see `lib/caps.ts` for why that copy was deleted):
 *
 *   1. WHO may use the desktop surface at all — `DESKTOP_ROLES`.
 *   2. WHICH screens that person may open — the `permission` on each nav item.
 *
 * Gate 2 reaches past the sidebar in three places, all of which used to offer
 * what the API would refuse or ignore: the profile dropdown's shortcuts, the
 * bell panel's link to the Notification Centre (`notify:write`, which a ward
 * councillor does not hold — the panel itself needs only a session, so the bell
 * works for all three roles), and each source the top-bar search queries (D9).
 *
 * Gate 2 is not cosmetic. Before it, every signed-in role saw all 26 screens;
 * a ward councillor clicking "Audit Log" or a regional organiser clicking
 * "Users & Roles" got a 403 rendered as an error card. Hiding the link is the
 * same fix the campaign applied to the mobile app's phantom publish buttons
 * (D6), and the server still enforces it independently — this only stops the UI
 * offering what the API refuses.
 */

/**
 * Roles served by the desktop CRM.
 *
 * An explicit product decision, not an inference from the permission matrix:
 * `analyst` holds `overview:read` and would pass a permission-only gate, but the
 * platform's rule is that members, supporters, branch coordinators and analysts
 * work in the mobile app and only the three office-holding roles get the
 * desktop. Keeping this as a role list rather than folding it into the
 * permissions means the two questions ("is this a desktop role?" and "may this
 * desktop role open this screen?") stay separately answerable.
 */
const DESKTOP_ROLES: readonly Role[] = [
  'superadmin',
  'national_admin',
  'regional_organizer',
  'ward_councillor',
];

/**
 * The permission each screen requires, derived from what the page actually
 * fetches (`src/app/crm/<page>/page.tsx` → `lib/api.ts` → the route's
 * `requirePermission`), recorded in `deploy/.artifacts/routes.json`.
 *
 * The rule applied, screen by screen: gate on the permission the page's primary
 * fetch requires; where that fetch is public or optional-auth, gate on the
 * permission its defining management action requires — because a console whose
 * every control returns 403 is not a screen the caller "can load" in any useful
 * sense, and is the exact defect this gate exists to remove.
 *
 *   Screen          Primary fetch        Action           Gate
 *   Dashboard       crm/dashboard        —                overview:read
 *   Analytics       crm/dashboard        —                overview:read
 *   Cases           crm/engagements      case:update      overview:read
 *   Escalations     crm/escalations      case:update      overview:read
 *   Verifications   /verifications       verify:write     case:read
 *   Ratings         /ratings             rating:write     overview:read
 *   Resident Rpts   transparency/reports —                report:read
 *   Members         crm/members          member:read      member:read
 *   Users & Roles   crm/users            role:manage      role:manage
 *   Moderation      moderation/users     moderate:users   moderate:users
 *   Wards           crm/members + geo    —                member:read
 *   Events          /events (public)     event:write      event:write
 *   Appointments    /appointments        appoint:write    appoint:write
 *   Bulletins       /ward-bulletins      bulletin:write   bulletin:read
 *   Posts           /posts (optional)    post:moderate    post:moderate
 *   Campaigns       crm/campaigns        notify:write     notify:write
 *   Participations  /participations      participation:…  engagement:write
 *   Petitions       public/petitions     none (read-only) overview:read
 *   Projects        /projects            engagement:write case:read
 *   Patrols         /patrols             none (read-only) patrol:read
 *   Heatmaps        patrols/heatmap      —                overview:read
 *   Work Demand     jobs/demand          —                jobs:demand_read
 *   Opportunities   jobs/opportunities   jobs:opportunity_write  (same)
 *   Recruitment     recruitment/report   —                recruitment:report
 *   Scorecards      scorecards/summary   rating:acknowledge  rating:scorecard_read
 *   Notifications   /notifications       notify:write     notify:write
 *   Audit Log       crm/audit            —                audit:read
 *   Reports         crm/* (CSV export)   —                report:generate
 *   Settings        crm/roles/:role/…    role:manage      role:manage
 *
 * Net effect on the three desktop roles: national_admin sees all 29;
 * regional_organizer loses Users & Roles, Moderation, Audit Log and Settings
 * (no role:manage / moderate:users / audit:read); ward_councillor additionally
 * loses Events, Appointments, Posts, Campaigns and Notifications, which are the
 * five write permissions D6 deliberately did not grant.
 */
const NAV_SECTIONS: {
  label: string;
  items: { href: string; label: string; icon: string; permission: PermName }[];
}[] = [
  {
    label: 'Overview',
    items: [
      { href: '/crm', label: 'Dashboard', icon: 'dashboard', permission: Perm.OVERVIEW_READ },
      { href: '/crm/analytics', label: 'Analytics', icon: 'analytics', permission: Perm.OVERVIEW_READ },
    ],
  },
  {
    label: 'Service Delivery',
    items: [
      { href: '/crm/engagements', label: 'Cases', icon: 'case', permission: Perm.OVERVIEW_READ },
      { href: '/crm/escalations', label: 'Escalations', icon: 'escalation', permission: Perm.OVERVIEW_READ },
      { href: '/crm/verifications', label: 'Verifications', icon: 'verify', permission: Perm.CASE_READ },
      { href: '/crm/ratings', label: 'Ratings', icon: 'rating', permission: Perm.OVERVIEW_READ },
      { href: '/crm/resident-reports', label: 'Resident Reports', icon: 'inbox', permission: Perm.REPORT_READ },
    ],
  },
  {
    label: 'Members & Roles',
    items: [
      { href: '/crm/members', label: 'Members', icon: 'members', permission: Perm.MEMBER_READ },
      { href: '/crm/users', label: 'Users & Roles', icon: 'users', permission: Perm.ROLE_MANAGE },
      { href: '/crm/moderation', label: 'Moderation', icon: 'moderation', permission: Perm.MODERATE_USERS },
      { href: '/crm/wards', label: 'Wards', icon: 'wards', permission: Perm.MEMBER_READ },
    ],
  },
  {
    label: 'Engagement',
    items: [
      { href: '/crm/events', label: 'Events', icon: 'events', permission: Perm.EVENT_WRITE },
      { href: '/crm/appointments', label: 'Appointments', icon: 'appointments', permission: Perm.APPOINT_WRITE },
      { href: '/crm/bulletins', label: 'Bulletins', icon: 'bulletins', permission: Perm.BULLETIN_READ },
      { href: '/crm/posts', label: 'Posts', icon: 'posts', permission: Perm.POST_MODERATE },
      { href: '/crm/campaigns', label: 'Campaigns', icon: 'campaigns', permission: Perm.NOTIFY_WRITE },
    ],
  },
  {
    label: 'Participation',
    items: [
      { href: '/crm/participations', label: 'Participations', icon: 'participations', permission: Perm.ENGAGEMENT_WRITE },
      { href: '/crm/petitions', label: 'Petitions', icon: 'petitions', permission: Perm.OVERVIEW_READ },
      { href: '/crm/projects', label: 'Projects', icon: 'projects', permission: Perm.CASE_READ },
    ],
  },
  {
    label: 'Field Operations',
    items: [
      { href: '/crm/patrols', label: 'Patrols', icon: 'patrols', permission: Perm.PATROL_READ },
      { href: '/crm/heatmaps', label: 'Heatmaps', icon: 'heatmaps', permission: Perm.OVERVIEW_READ },
    ],
  },
  {
    label: 'Jobs',
    items: [
      { href: '/crm/work-demand', label: 'Work Demand', icon: 'demand', permission: Perm.JOBS_DEMAND_READ },
      { href: '/crm/opportunities', label: 'Opportunities', icon: 'briefcase', permission: Perm.JOBS_OPPORTUNITY_WRITE },
    ],
  },
  {
    label: 'Growth & Accountability',
    items: [
      { href: '/crm/recruitment', label: 'Recruitment', icon: 'recruitment', permission: Perm.RECRUITMENT_REPORT },
      { href: '/crm/scorecards', label: 'Scorecards', icon: 'scorecards', permission: Perm.RATING_SCORECARD_READ },
    ],
  },
  {
    label: 'Administration',
    items: [
      { href: '/crm/notifications', label: 'Notifications', icon: 'notifications', permission: Perm.NOTIFY_WRITE },
      { href: '/crm/audit', label: 'Audit Log', icon: 'audit', permission: Perm.AUDIT_READ },
      { href: '/crm/reports', label: 'Reports', icon: 'reports', permission: Perm.REPORT_GENERATE },
      { href: '/crm/settings', label: 'Settings', icon: 'settings', permission: Perm.ROLE_MANAGE },
    ],
  },
  {
    label: 'Platform',
    items: [
      { href: '/crm/platform', label: 'Ops Overview', icon: 'dashboard', permission: Perm.PLATFORM_READ },
      { href: '/crm/website-analytics', label: 'Website Analytics', icon: 'analytics', permission: Perm.ANALYTICS_READ },
      { href: '/crm/downloads', label: 'App Downloads', icon: 'analytics', permission: Perm.ANALYTICS_READ },
      { href: '/crm/website', label: 'Website Content', icon: 'settings', permission: Perm.CONTENT_MANAGE },
      // The public homepage's "Meet our ward councillors" roster — published
      // website content, so it sits with the editor under the same gate.
      { href: '/crm/candidates', label: 'Ward Councillors', icon: 'members', permission: Perm.CONTENT_MANAGE },
    ],
  },
];

/** Flat nav list, used for the breadcrumb and the direct-URL gate. */
const NAV_ITEMS = NAV_SECTIONS.flatMap((section) => section.items);

/**
 * The gate a screen declares, falling back to `overview:read` for a `/crm/*` path
 * with no nav entry.
 *
 * Used for both the direct-URL check and the profile dropdown's shortcuts, so
 * "Settings needs role:manage" is stated once, next to the nav item, instead of
 * being restated where it can drift from it. The fallback is the permission the
 * whole surface is gated on server-side, so an unlisted screen behaves like the
 * dashboard rather than being silently open or silently closed.
 */
function navPermission(href: string): PermName {
  return NAV_ITEMS.find((item) => item.href === href)?.permission ?? Perm.OVERVIEW_READ;
}

/**
 * Sections with the items this session may open, dropping sections left empty.
 *
 * An empty section header with nothing under it reads as a rendering bug, not as
 * "you have no access", so the whole section goes.
 */
function visibleSections(permissions: readonly Permission[] | null) {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => can(permissions, item.permission)),
  })).filter((section) => section.items.length > 0);
}

/*
 * Inline styles for the two refusal screens. Both render *instead of* the shell,
 * so the `<style jsx>` block below — which lives inside the shell's tree and is
 * scoped to it by styled-jsx — is not in effect on them. Inline is the honest
 * option here rather than a second stylesheet for ~40 lines used twice.
 */
const CENTER_SCREEN: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '100vh',
  padding: 24,
  background: '#f6f3f1',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

const NOTICE_CARD: React.CSSProperties = {
  maxWidth: 560,
  background: '#fff',
  border: '1px solid #ece5e1',
  borderLeft: '4px solid #c8102e',
  borderRadius: 12,
  padding: '28px 30px',
  boxShadow: '0 12px 32px rgba(28, 25, 23, 0.08)',
};

const NOTICE_BADGE: React.CSSProperties = {
  display: 'inline-block',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.8,
  textTransform: 'uppercase',
  color: '#c8102e',
  background: '#fbecee',
  border: '1px solid #f2ccd2',
  borderRadius: 999,
  padding: '4px 10px',
  marginBottom: 14,
};

const NOTICE_TITLE: React.CSSProperties = {
  margin: '0 0 12px',
  fontSize: 21,
  fontWeight: 700,
  color: '#1c1917',
  lineHeight: 1.3,
};

const NOTICE_BODY: React.CSSProperties = {
  margin: '0 0 12px',
  fontSize: 14,
  lineHeight: 1.65,
  color: '#57534e',
};

const NOTICE_ACTIONS: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap',
  marginTop: 20,
};

const NOTICE_PRIMARY: React.CSSProperties = {
  background: '#c8102e',
  color: '#fff',
  border: '1px solid #c8102e',
  borderRadius: 8,
  padding: '10px 18px',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
};

const NOTICE_SECONDARY: React.CSSProperties = {
  background: '#fff',
  color: '#1c1917',
  border: '1px solid #d6ccc4',
  borderRadius: 8,
  padding: '10px 18px',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
};

const ICONS: Record<string, JSX.Element> = {
  dashboard: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>,
  analytics: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>,
  case: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>,
  escalation: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>,
  verify: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>,
  rating: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>,
  members: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>,
  moderation: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><line x1="9.5" y1="9.5" x2="14.5" y2="14.5" /><line x1="14.5" y1="9.5" x2="9.5" y2="14.5" /></svg>,
  wards: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" /><line x1="8" y1="2" x2="8" y2="18" /><line x1="16" y1="6" x2="16" y2="22" /></svg>,
  events: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>,
  appointments: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /><path d="M8 14h.01" /><path d="M12 14h.01" /><path d="M16 14h.01" /><path d="M8 18h.01" /><path d="M12 18h.01" /></svg>,
  bulletins: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" /><path d="M18 14h-8" /><path d="M15 18h-5" /><path d="M10 6h8v4h-8V6Z" /></svg>,
  posts: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>,
  campaigns: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 11l18-5v12L3 14v-3z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" /></svg>,
  participations: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>,
  petitions: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>,
  projects: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>,
  patrols: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" /></svg>,
  heatmaps: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><circle cx="15.5" cy="15.5" r="1.5" /><circle cx="15.5" cy="8.5" r="1.5" /><circle cx="8.5" cy="15.5" r="1.5" /><circle cx="12" cy="12" r="1.5" /></svg>,
  demand: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /><line x1="3" y1="20" x2="21" y2="20" /></svg>,
  briefcase: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></svg>,
  recruitment: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" /></svg>,
  scorecards: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 3h6v2H9z" /><path d="m12 9 1.2 2.4 2.6.4-1.9 1.8.5 2.6-2.4-1.3-2.4 1.3.5-2.6-1.9-1.8 2.6-.4L12 9z" /></svg>,
  notifications: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>,
  audit: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>,
  reports: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>,
  inbox: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
};

/*
 * ── Top-bar search (D9) ─────────────────────────────────────────────────────
 *
 * This box held state that nothing ever read: typing changed `searchQuery` and
 * changed nothing else. It now queries the two server-side filters that exist —
 * `GET /crm/members?search=` (membership no / public code) and
 * `GET /crm/engagements?search=` (case ref / title / ward / category, added for
 * this) — and each source is asked only when the session holds the permission
 * that route requires, so the panel can never be the thing that produces a 403.
 *
 * Filtering an already-fetched page client-side was rejected: it would search
 * the first 50 rows and report everything else as "no matches", the same silent
 * truncation the Home tiles had (D52). The placeholder lost "wards" for the
 * same reason — the Wards screen is a client-side composition of boundaries,
 * members and cases with no text filter of its own, so a ward hit would have
 * nowhere to land. Ward *codes* still match, inside the case source.
 *
 * What is not searched is a POPIA decision, not a limitation: member names,
 * emails and phone numbers live in `members.sealed_pii` and a case's reporter in
 * `service_requests.reporter_sealed`, encrypted at rest with blind indexes for
 * exact match only. Searching them would mean decrypting whole tables per
 * keystroke. The panel says so out loud rather than let a user conclude that the
 * person they typed does not exist.
 */
const SEARCH_MIN = 2;
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 5;

/**
 * One search source's answer.
 *
 * Three states, because two are not enough: `skipped` is "this session may not
 * ask" (permission gate — say nothing), `error` is "asked and it failed" (say
 * so), `ok` is a real answer including a real zero. Collapsing `error` into an
 * empty `ok` would render a failed search as "no matches", which is the exact
 * fabrication D51 removed from the Home tiles.
 */
type SourceResult<T> =
  | { status: 'ok'; items: T[]; total: number }
  | { status: 'error' }
  | { status: 'skipped' };

type SearchHits = {
  members: SourceResult<Member>;
  cases: SourceResult<ServiceRequest>;
};

const NO_HITS: SearchHits = { members: { status: 'skipped' }, cases: { status: 'skipped' } };

/**
 * A result row deep-links with the identifier that pins exactly that row.
 *
 * Neither screen has a per-record route — both open the record in a modal from
 * a filtered list — so a one-row list is the honest equivalent of a detail page.
 */
function pinHref(screen: string, exact: string) {
  return `${screen}?search=${encodeURIComponent(exact)}`;
}

/** How many alerts the bell panel loads. The endpoint caps at 200. */
const ALERT_LIMIT = 20;

/**
 * Whether this shell can follow an alert's link.
 *
 * Alerts carry one of two grammars. A `/…` path is a route in `src/app` and the
 * desktop follows it. A `tab:<tab>#<section>` string is a mobile deep link
 * parsed by `EngageTab.followLink` inside the app shell; it is not a URL, so a
 * row carrying one renders without a chevron instead of looking clickable and
 * going nowhere.
 */
function desktopHref(link: string | null): string | null {
  return link !== null && link.startsWith('/') ? link : null;
}

export default function CrmShell({ children }: { children: React.ReactNode }) {
  const { authenticated, ready, role, email, permissions, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHits>(NO_HITS);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unread, setUnread] = useState<number | null>(null);
  const [alerts, setAlerts] = useState<AppNotification[] | null>(null);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const topbarRef = useRef<HTMLElement | null>(null);

  /** Gate 1 — is this a role the desktop CRM serves at all? */
  const isDesktopRole = role !== null && DESKTOP_ROLES.includes(role);

  /** Gate 2 — which of the 26 screens may this session open? */
  const sections = useMemo(() => visibleSections(permissions), [permissions]);

  /**
   * Gate 2 applied to the URL, not just the sidebar.
   *
   * Filtering the nav stops a role *clicking* into a screen it cannot load, but
   * the URL is still typeable, bookmarkable and shareable — a regional organiser
   * with `/crm/audit` in their history would otherwise land on a 403 card. An
   * unknown `/crm/*` path (a screen added without a nav entry) falls back to
   * `overview:read`, the permission the surface itself is gated on server-side.
   */
  const currentItem = NAV_ITEMS.find((item) => item.href === pathname);
  const screenAllowed = can(permissions, navPermission(pathname));

  /**
   * Gate 2 applied to the top-bar search, source by source.
   *
   * The permissions are the ones the *routes* carry — `member:read` for
   * `/crm/members`, `overview:read` for `/crm/engagements` — so a session that
   * cannot see the Members screen does not get member hits from the search box
   * either. All three desktop roles hold `overview:read` (it is what the whole
   * surface is gated on), which makes the case source always available here and
   * the member source the one that varies.
   */
  const maySearchMembers = can(permissions, Perm.MEMBER_READ);
  const maySearchCases = can(permissions, Perm.OVERVIEW_READ);
  const maySearch = maySearchMembers || maySearchCases;
  const query = searchQuery.trim();

  /**
   * Whether the permission list is settled.
   *
   * `AuthProvider` heals a session that signed in before the server sent
   * permissions by refreshing once; until that lands `permissions` is `[]`,
   * which is indistinguishable from "the server authorised nothing" and would
   * deny every screen for the length of one round trip. `tokenStore.permissions`
   * keeps the distinction (`null` = never stored, `[]` = stored and empty), so
   * hold the loader for that one case instead of flashing a denial.
   */
  const permissionsKnown = permissions.length > 0 || tokenStore.permissions !== null;

  /**
   * Sign out through the auth context, NOT by clearing localStorage directly.
   *
   * The old handler removed `access_token` and `refresh_token` from the browser
   * and pushed `/login`. That only hides the session locally: the refresh token
   * stayed valid server-side for its full 7-day life, so anyone who had copied
   * it — a shared machine, a leaked backup, browser storage synced to another
   * device — could keep minting access tokens after the user believed they had
   * signed out. `logout()` posts the token to `POST /auth/logout`, which revokes
   * it and writes an `auth.logout` audit entry, then clears every key
   * `tokenStore` owns (the old handler also left `tc_accepted_version` and
   * `must_change_password` behind).
   *
   * `replace` rather than `push`: after a sign-out the CRM page must not be one
   * Back-click away.
   */
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
    } catch {
      // Never strand the user on a signed-in-looking screen: `api.logout()`
      // clears local state in a `finally`, so revocation is best-effort and the
      // navigation must happen regardless.
    } finally {
      router.replace('/login');
    }
  }

  useEffect(() => {
    if (ready && !authenticated) {
      router.replace('/login');
    }
  }, [ready, authenticated, router]);

  /**
   * The bell badge — the real unread count for *this* user.
   *
   * It was a literal `3` (D9), which happened to be correct for the ward
   * councillor in the validation fixtures and wrong for everybody else: the
   * national admin has no alerts at all and the regional organiser has one. A
   * hardcoded count is worse than no badge, because it is believed.
   *
   * `null` means "not known yet, or the request failed", and renders no badge —
   * the same shape as a real zero, but never stored as one. Recording a failed
   * request as `0` would be the UI asserting "you have no alerts" on the
   * server's behalf (the D51 lesson).
   */
  useEffect(() => {
    if (!authenticated || !isDesktopRole) return;
    let cancelled = false;
    api
      .unreadCount()
      .then((r) => !cancelled && setUnread(r.unread))
      .catch(() => !cancelled && setUnread(null));
    return () => {
      cancelled = true;
    };
  }, [authenticated, isDesktopRole]);

  /**
   * Debounced search.
   *
   * `cancelled` is what makes it correct rather than merely quiet: without it a
   * slow response to "se" lands after the response to "sewer" and overwrites
   * it — the panel would show results for a query the box no longer contains.
   * Each source swallows its own failure so one 403 or timeout cannot blank the
   * other, and the panel-wide error is raised only when every source this
   * session may ask has failed; a single failed source is reported in its own
   * group instead.
   */
  useEffect(() => {
    if (query.length < SEARCH_MIN) {
      setHits(NO_HITS);
      setSearching(false);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    setSearching(true);

    const timer = setTimeout(() => {
      function ask<T>(
        allowed: boolean,
        run: () => Promise<{ items: T[]; total: number }>,
      ): Promise<SourceResult<T>> {
        if (!allowed) return Promise.resolve<SourceResult<T>>({ status: 'skipped' });
        return run().then(
          ({ items, total }): SourceResult<T> => ({ status: 'ok', items, total }),
          (): SourceResult<T> => ({ status: 'error' }),
        );
      }

      const limit = String(SEARCH_LIMIT);
      Promise.all([
        ask<Member>(maySearchMembers, () => api.crmMembers({ search: query, limit })),
        ask<ServiceRequest>(maySearchCases, () => api.crmEngagements({ search: query, limit })),
      ]).then(([members, cases]) => {
        if (cancelled) return;
        setHits({ members, cases });
        setSearching(false);
        const asked = (maySearchMembers ? 1 : 0) + (maySearchCases ? 1 : 0);
        const failed = (members.status === 'error' ? 1 : 0) + (cases.status === 'error' ? 1 : 0);
        setSearchError(
          asked > 0 && asked === failed ? 'Search could not reach the server.' : null,
        );
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, maySearchMembers, maySearchCases]);

  /**
   * Dismissal for all three top-bar panels.
   *
   * None of it existed: the profile dropdown stayed open across navigations and
   * floated over whatever screen it had just left. One listener pair covers
   * click-outside and Escape for search, alerts and profile alike.
   */
  useEffect(() => {
    if (!searchOpen && !showNotifications && !showProfile) return;
    const close = () => {
      setSearchOpen(false);
      setShowNotifications(false);
      setShowProfile(false);
    };
    function onDown(e: MouseEvent) {
      if (topbarRef.current && !topbarRef.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [searchOpen, showNotifications, showProfile]);

  /** A navigation closes whatever was open — the panels belong to the old screen. */
  useEffect(() => {
    setSearchOpen(false);
    setShowNotifications(false);
    setShowProfile(false);
  }, [pathname]);

  /** Open/close the bell, loading the inbox on the way in. */
  async function toggleNotifications() {
    const next = !showNotifications;
    setShowNotifications(next);
    setShowProfile(false);
    if (!next) return;
    setAlertsLoading(true);
    try {
      const r = await api.listNotifications({ unread: true, limit: ALERT_LIMIT });
      setAlerts(r.items);
      // The list carries the authoritative count, so opening the panel also
      // corrects a badge that has gone stale since the page loaded.
      setUnread(r.unread);
    } catch {
      setAlerts(null); // "could not load", deliberately not `[]`
    } finally {
      setAlertsLoading(false);
    }
  }

  /**
   * Mark one alert read, clear it from the bell, and close the panel if the row
   * is about to navigate.
   *
   * The bell panel is an unread queue, so a message disappears the moment it is
   * read; the durable history stays in the Notification Centre, which lists
   * every message (read included). Read-state is cosmetic and the navigation is
   * the point of the click, so a failed `markNotificationRead` must never
   * swallow it. The count is decremented locally rather than re-fetched: one
   * round trip per click on a panel whose only job is to be cheap.
   */
  async function openAlert(n: AppNotification) {
    if (desktopHref(n.link)) setShowNotifications(false);
    if (n.read) return;
    try {
      await api.markNotificationRead(n.id);
      setAlerts((list) => list?.filter((x) => x.id !== n.id) ?? null);
      setUnread((c) => (c === null || c <= 0 ? c : c - 1));
    } catch {
      /* non-fatal */
    }
  }

  async function readAllAlerts() {
    try {
      await api.markAllNotificationsRead();
      setAlerts([]); // the unread queue empties; the archive keeps the read messages
      setUnread(0);
    } catch {
      /* non-fatal */
    }
  }

  if (!ready || !authenticated || !permissionsKnown) {
    return (
      <div style={CENTER_SCREEN}>
        <div style={{ textAlign: 'center' }}>
          <div className="spinner" />
          <p style={{ marginTop: 16, color: '#8a817b' }}>Loading…</p>
        </div>
        <style jsx>{`
          .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid #ece5e1;
            border-top-color: #c8102e;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin: 0 auto;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  /**
   * Gate 1 refusal — an explanatory screen, not a bounce.
   *
   * The plan said "redirected to the app with an explanatory screen"; those pull
   * in opposite directions, and the screen wins. An automatic redirect fires
   * before anyone can read why they moved, and a member who typed or bookmarked
   * `/crm` would experience it as the app misbehaving. The button makes the move
   * the user's, and the copy states the policy rather than an error — nothing
   * was refused, because nothing was fetched: this returns before `children`
   * mount, so the page components never issue a request to be 403'd.
   */
  if (!isDesktopRole) {
    return (
      <div style={CENTER_SCREEN}>
        <div style={NOTICE_CARD}>
          <div style={NOTICE_BADGE}>Mobile app account</div>
          <h1 style={NOTICE_TITLE}>The desktop CRM is not available for this account</h1>
          <p style={NOTICE_BODY}>
            {role
              ? <>Your role, <strong>{role.replace(/_/g, ' ')}</strong>, works in the UDF mobile app.</>
              : <>This session could not be identified.</>}
            {' '}The desktop CRM is reserved for office-holding roles — national administration,
            regional organisers and ward councillors. Everyone else, including members,
            supporters, branch coordinators and analysts, uses the mobile app.
          </p>
          <p style={NOTICE_BODY}>
            No data was requested and nothing was denied: this screen is shown before any
            CRM page loads. If you believe this account should have desktop access, an
            administrator changes it under <strong>Users &amp; Roles</strong>.
          </p>
          <div style={NOTICE_ACTIONS}>
            <button style={NOTICE_PRIMARY} onClick={() => router.replace('/')}>
              Open the mobile app view
            </button>
            <button style={NOTICE_SECONDARY} onClick={signOut} disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Unfiltered, on purpose: the breadcrumb and the denial panel below must be
  // able to name a screen this session is not allowed to open.
  const breadcrumbSection = NAV_SECTIONS.find(s => s.items.some(i => pathname === i.href));

  /**
   * Panel-level roll-ups.
   *
   * A single source failing is reported inside its own group, so "nothing
   * matches" is claimed only when nothing failed — otherwise a timeout on the
   * member source would be presented to the user as an authoritative empty
   * result set, and they would conclude the person does not exist.
   */
  const searchFailed = hits.members.status === 'error' || hits.cases.status === 'error';
  const searchTotal =
    (hits.members.status === 'ok' ? hits.members.total : 0) +
    (hits.cases.status === 'ok' ? hits.cases.total : 0);

  return (
    <div className="crm-enterprise">
      {/* Sidebar */}
      <aside className={`crm-sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <div className="crm-sidebar-header">
          <Logo size={28} wordmark={sidebarOpen} variant="light" />
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="crm-sidebar-toggle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {sidebarOpen ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
            </svg>
          </button>
        </div>

        <nav className="crm-sidebar-nav">
          {sections.length === 0 && sidebarOpen && (
            <div className="crm-nav-empty">
              No screens are authorised for this session. Your role is a desktop CRM role,
              so the permission list the server sent does not match it — sign out and back
              in, and if it persists the account&apos;s role needs checking under Users
              &amp; Roles.
            </div>
          )}
          {sections.map((section) => (
            <div key={section.label} className="crm-nav-section">
              {sidebarOpen && <div className="crm-nav-section-label">{section.label}</div>}
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`crm-nav-item ${pathname === item.href ? 'active' : ''}`}
                  title={!sidebarOpen ? item.label : undefined}
                >
                  <span className="crm-nav-icon">{ICONS[item.icon]}</span>
                  {sidebarOpen && <span className="crm-nav-label">{item.label}</span>}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* Main Content */}
      <div className="crm-main">
        {/* Top Bar */}
        <header className="crm-topbar" ref={topbarRef}>
          <div className="crm-topbar-left">
            <button onClick={() => setSidebarOpen(!sidebarOpen)} className="crm-topbar-menu">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            {currentItem && (
              <div className="crm-breadcrumbs">
                <span className="crm-breadcrumb-section">{breadcrumbSection?.label}</span>
                <span className="crm-breadcrumb-sep">/</span>
                <span className="crm-breadcrumb-current">{currentItem.label}</span>
              </div>
            )}
          </div>

          <div className="crm-topbar-center">
            {maySearch && (
              <div className="crm-search">
                <svg className="crm-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  placeholder={
                    maySearchMembers && maySearchCases
                      ? 'Search members & cases…'
                      : maySearchMembers
                        ? 'Search members…'
                        : 'Search cases…'
                  }
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSearchOpen(true);
                  }}
                  onFocus={() => setSearchOpen(true)}
                  aria-label="Search members and cases"
                />

                {searchOpen && query.length >= SEARCH_MIN && (
                  <div className="crm-panel crm-search-panel" aria-live="polite">
                    {searching && <div className="crm-panel-note">Searching…</div>}

                    {!searching && searchError && (
                      <div className="crm-panel-note crm-panel-error">{searchError}</div>
                    )}

                    {!searching && !searchError && (
                      <>
                        {!searchFailed && searchTotal === 0 && (
                          <div className="crm-panel-note">
                            Nothing matches &ldquo;{query}&rdquo; in the scope this session can read.
                          </div>
                        )}

                        {hits.members.status === 'ok' && (
                          <div className="crm-panel-group">
                            <div className="crm-panel-head">
                              <span>Members</span>
                              <span className="crm-panel-count">{hits.members.total}</span>
                            </div>
                            {hits.members.items.length === 0 ? (
                              <div className="crm-panel-note">No member matches in your scope.</div>
                            ) : (
                              hits.members.items.map((m) => (
                                <Link
                                  key={m.id}
                                  href={pinHref('/crm/members', m.publicCode ?? m.membershipNo ?? query)}
                                  className="crm-panel-row"
                                  onClick={() => setSearchOpen(false)}
                                >
                                  <span className="crm-panel-row-title">{memberLabel(m)}</span>
                                  <span className="crm-panel-row-sub">
                                    {[m.tier, m.status, m.ward ? `Ward ${m.ward}` : null]
                                      .filter(Boolean)
                                      .join(' · ')}
                                  </span>
                                </Link>
                              ))
                            )}
                            {hits.members.total > hits.members.items.length && (
                              <Link
                                href={pinHref('/crm/members', query)}
                                className="crm-panel-more"
                                onClick={() => setSearchOpen(false)}
                              >
                                View all {hits.members.total} members →
                              </Link>
                            )}
                          </div>
                        )}
                        {hits.members.status === 'error' && (
                          <div className="crm-panel-note crm-panel-error">
                            The member directory could not be searched.
                          </div>
                        )}

                        {hits.cases.status === 'ok' && (
                          <div className="crm-panel-group">
                            <div className="crm-panel-head">
                              <span>Cases</span>
                              <span className="crm-panel-count">{hits.cases.total}</span>
                            </div>
                            {hits.cases.items.length === 0 ? (
                              <div className="crm-panel-note">No case matches in your scope.</div>
                            ) : (
                              hits.cases.items.map((c) => (
                                <Link
                                  key={c.id}
                                  href={pinHref('/crm/engagements', c.refNo || query)}
                                  className="crm-panel-row"
                                  onClick={() => setSearchOpen(false)}
                                >
                                  <span className="crm-panel-row-title">{c.title || c.refNo}</span>
                                  <span className="crm-panel-row-sub">
                                    {[c.refNo, c.wardCode ? `Ward ${c.wardCode}` : null, c.category, c.status]
                                      .filter(Boolean)
                                      .join(' · ')}
                                  </span>
                                </Link>
                              ))
                            )}
                            {hits.cases.total > hits.cases.items.length && (
                              <Link
                                href={pinHref('/crm/engagements', query)}
                                className="crm-panel-more"
                                onClick={() => setSearchOpen(false)}
                              >
                                View all {hits.cases.total} cases →
                              </Link>
                            )}
                          </div>
                        )}
                        {hits.cases.status === 'error' && (
                          <div className="crm-panel-note crm-panel-error">
                            The case register could not be searched.
                          </div>
                        )}

                        <div className="crm-panel-foot">
                          Matches membership no, public code, case ref, title, ward and
                          category. Names, emails and phone numbers are sealed under POPIA
                          and are never searched — a person missing here may still be a
                          member.
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="crm-topbar-right">
            <div className="crm-bell">
              <button
                className="crm-topbar-btn"
                onClick={toggleNotifications}
                aria-label={
                  unread === null ? 'Notifications' : `Notifications, ${unread} unread`
                }
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
                {unread !== null && unread > 0 && (
                  <span className="crm-badge-count">{unread > 99 ? '99+' : unread}</span>
                )}
              </button>

              {showNotifications && (
                <div className="crm-panel crm-bell-panel" aria-live="polite">
                  <div className="crm-panel-head">
                    <span>Alerts</span>
                    {unread !== null && (
                      <span className="crm-panel-count">{unread} unread</span>
                    )}
                  </div>

                  {alertsLoading && <div className="crm-panel-note">Loading…</div>}

                  {!alertsLoading && alerts === null && (
                    <div className="crm-panel-note crm-panel-error">Alerts could not be loaded.</div>
                  )}

                  {!alertsLoading && alerts !== null && alerts.length === 0 && (
                    <div className="crm-panel-note">
                      Nothing outstanding. Alerts raised for your ward or region appear here.
                    </div>
                  )}

                  {!alertsLoading &&
                    alerts?.map((n) => {
                      const href = desktopHref(n.link);
                      const inner = (
                        <>
                          <span className="crm-panel-row-title">{n.title}</span>
                          {n.body && <span className="crm-panel-row-sub">{n.body}</span>}
                          <span className="crm-panel-row-meta">
                            {n.kind}
                            {n.regionCode ? ` · ${n.regionCode}` : ''} · {fmtDateTime(n.createdAt)}
                            {href ? ' · open →' : ''}
                          </span>
                        </>
                      );
                      return href ? (
                        <Link
                          key={n.id}
                          href={href}
                          className={`crm-panel-row${n.read ? '' : ' unread'}`}
                          onClick={() => openAlert(n)}
                        >
                          {inner}
                        </Link>
                      ) : (
                        <button
                          key={n.id}
                          type="button"
                          className={`crm-panel-row${n.read ? '' : ' unread'}`}
                          onClick={() => openAlert(n)}
                        >
                          {inner}
                        </button>
                      );
                    })}

                  {!alertsLoading && alerts !== null && alerts.length > 0 && (
                    <button
                      type="button"
                      className="crm-panel-more"
                      onClick={readAllAlerts}
                      disabled={unread === 0}
                    >
                      {unread === 0 ? 'All read' : 'Mark all read'}
                    </button>
                  )}

                  {/*
                    Read from the nav item, not restated: the Notification Centre
                    *screen* broadcasts, so it needs `notify:write`. This panel
                    needs only an authenticated session — which is precisely why
                    a ward councillor, who holds neither, gets a working bell
                    here rather than a shortcut to a 403 (D9).
                  */}
                  {can(permissions, navPermission('/crm/notifications')) && (
                    <Link
                      href="/crm/notifications"
                      className="crm-panel-more crm-panel-foot-link"
                      onClick={() => setShowNotifications(false)}
                    >
                      Notification centre →
                    </Link>
                  )}
                </div>
              )}
            </div>

            <div className="crm-profile-menu">
              <button
                className="crm-profile-btn"
                onClick={() => {
                  setShowProfile(!showProfile);
                  setShowNotifications(false);
                }}
              >
                <div className="crm-avatar">{email?.[0]?.toUpperCase() || 'U'}</div>
                <div className="crm-profile-info">
                  <div className="crm-profile-email">{email}</div>
                  <div className="crm-profile-role">{role}</div>
                </div>
              </button>

              {showProfile && (
                <div className="crm-dropdown">
                  {/*
                    Gated on the same permissions as the sidebar entries they
                    duplicate. These two shortcuts pointed at role:manage and
                    audit:read screens for every signed-in role, so a ward
                    councillor had a permanent one-click path to a 403.
                  */}
                  {can(permissions, navPermission('/crm/settings')) && (
                    <Link href="/crm/settings" className="crm-dropdown-item">Settings</Link>
                  )}
                  {can(permissions, navPermission('/crm/audit')) && (
                    <Link href="/crm/audit" className="crm-dropdown-item">Audit Log</Link>
                  )}
                  <button
                    className="crm-dropdown-item crm-dropdown-danger"
                    onClick={signOut}
                    disabled={signingOut}
                  >
                    {signingOut ? 'Signing out…' : 'Sign Out'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/*
          Content. `children` is swapped out rather than overlaid, so a denied
          screen never mounts: its page component is what issues the fetch, and
          not mounting it is the difference between a refusal explained here and
          a 403 rendered as an error card by the page.
        */}
        <main className="crm-content">
          {screenAllowed ? (
            children
          ) : (
            <div className="crm-denied">
              <div className="crm-denied-badge">Not authorised</div>
              <h2 className="crm-denied-title">
                {currentItem ? currentItem.label : 'This screen'} is not available to your role
              </h2>
              <p className="crm-denied-body">
                It requires <code className="crm-denied-code">{navPermission(pathname)}</code>,
                which the server did not grant this session. Nothing was fetched and nothing
                was refused by the API — the screen was not loaded.
              </p>
              <p className="crm-denied-body">
                Pick another screen from the sidebar, or go back to the dashboard.
              </p>
              <Link href="/crm" className="crm-denied-link">Back to Dashboard</Link>
            </div>
          )}
        </main>
      </div>

      <style jsx>{`
        .crm-enterprise {
          display: flex;
          height: 100vh;
          background: #f6f3f1;
          color: #1c1917;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        /* Sidebar */
        .crm-sidebar {
          width: 260px;
          background: linear-gradient(180deg, #1c1917 0%, #141414 45%, #0c0a09 100%);
          color: #fff;
          display: flex;
          flex-direction: column;
          transition: width 0.2s ease;
          overflow: hidden;
          border-right: 1px solid #000;
          box-shadow: 2px 0 14px rgba(0, 0, 0, 0.2);
        }
        .crm-sidebar.closed {
          width: 68px;
        }
        .crm-sidebar-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: linear-gradient(90deg, rgba(200, 16, 46, 0.16), rgba(200, 16, 46, 0));
        }
        .crm-sidebar-toggle {
          background: none;
          border: none;
          color: #fff;
          cursor: pointer;
          padding: 4px;
          display: flex;
          align-items: center;
        }
        .crm-sidebar-toggle svg {
          width: 20px;
          height: 20px;
        }

        .crm-sidebar-nav {
          flex: 1;
          overflow-y: auto;
          padding: 8px 0;
        }
        .crm-nav-empty {
          margin: 12px 16px;
          padding: 14px;
          font-size: 12px;
          line-height: 1.6;
          color: #d6ccc4;
          background: rgba(200, 16, 46, 0.14);
          border: 1px solid rgba(200, 16, 46, 0.32);
          border-radius: 8px;
        }
        .crm-nav-section {
          margin-bottom: 14px;
        }
        .crm-nav-section-label {
          padding: 10px 20px 6px;
          font-size: 10px;
          font-weight: 700;
          color: #8a817b;
          text-transform: uppercase;
          letter-spacing: 1.2px;
        }
        :global(.crm-nav-item) {
          position: relative;
          display: flex;
          align-items: center;
          gap: 12px;
          margin: 2px 12px;
          padding: 9px 14px;
          border-radius: 8px;
          color: #a8a29e;
          text-decoration: none;
          font-size: 14px;
          font-weight: 500;
          transition: background 0.15s, color 0.15s;
        }
        :global(.crm-nav-item:hover) {
          background: rgba(255, 255, 255, 0.06);
          color: #fff;
        }
        :global(.crm-nav-item.active) {
          background: linear-gradient(135deg, #c8102e 0%, #a00d24 100%);
          color: #fff;
          font-weight: 600;
          box-shadow: 0 4px 14px rgba(200, 16, 46, 0.4);
        }
        :global(.crm-nav-item.active::before) {
          content: '';
          position: absolute;
          left: -12px;
          top: 8px;
          bottom: 8px;
          width: 3px;
          background: #fff;
          border-radius: 0 3px 3px 0;
          opacity: 0.9;
        }
        :global(.crm-sidebar.closed .crm-nav-item) {
          justify-content: center;
          margin: 2px 10px;
          padding: 10px;
        }
        :global(.crm-sidebar.closed .crm-nav-item.active::before) {
          left: -10px;
        }
        .crm-nav-icon {
          width: 20px;
          height: 20px;
          flex-shrink: 0;
        }
        .crm-nav-icon svg {
          width: 100%;
          height: 100%;
        }
        .crm-nav-label {
          white-space: nowrap;
        }

        /* Main */
        .crm-main {
          position: relative;
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .crm-main::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 3px;
          background: linear-gradient(90deg, #c8102e 0%, #a00d24 55%, #7c0a1b 100%);
          z-index: 20;
        }

        /* Topbar */
        .crm-topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 24px;
          background: #fff;
          border-bottom: 1px solid #ece5e1;
          box-shadow: 0 1px 3px rgba(28, 25, 23, 0.05);
          gap: 16px;
          z-index: 10;
        }
        .crm-topbar-left {
          display: flex;
          align-items: center;
          gap: 16px;
        }
        .crm-topbar-menu {
          background: none;
          border: none;
          cursor: pointer;
          padding: 4px;
          display: none;
        }
        .crm-topbar-menu svg {
          width: 24px;
          height: 24px;
          color: #64748b;
        }
        .crm-breadcrumbs {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
        }
        .crm-breadcrumb-section {
          color: #8a817b;
        }
        .crm-breadcrumb-sep {
          color: #ddd2cc;
        }
        .crm-breadcrumb-current {
          color: #1c1917;
          font-weight: 600;
        }

        .crm-topbar-center {
          flex: 1;
          max-width: 480px;
        }
        .crm-search {
          position: relative;
        }
        .crm-search input {
          width: 100%;
          padding: 9px 12px 9px 36px;
          border: 1px solid #ece5e1;
          border-radius: 8px;
          font-size: 14px;
          background: #f6f3f1;
          transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
        }
        .crm-search input:focus {
          outline: none;
          border-color: #c8102e;
          background: #fff;
          box-shadow: 0 0 0 3px rgba(200, 16, 46, 0.12);
        }
        .crm-search-icon {
          position: absolute;
          left: 12px;
          top: 50%;
          transform: translateY(-50%);
          width: 16px;
          height: 16px;
          color: #8a817b;
        }

        .crm-topbar-right {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .crm-topbar-btn {
          position: relative;
          background: none;
          border: none;
          cursor: pointer;
          padding: 8px;
          color: #57534e;
        }
        .crm-topbar-btn svg {
          width: 20px;
          height: 20px;
        }
        .crm-badge-count {
          position: absolute;
          top: 4px;
          right: 4px;
          background: #C8102E;
          color: #fff;
          font-size: 10px;
          font-weight: 600;
          padding: 2px 5px;
          border-radius: 10px;
          min-width: 16px;
          text-align: center;
        }

        /* ── Top-bar panels (D9): search results and the alert inbox ────────
           Scoped rather than declared :global(...): every element carrying these
           classes is in this file's own JSX, so styled-jsx hashes them normally.
           Both panels reuse one .crm-panel frame so the two dropdowns that now
           sit in the same bar cannot drift apart visually. */
        .crm-bell {
          position: relative;
        }
        .crm-panel {
          position: absolute;
          top: 100%;
          margin-top: 10px;
          background: #fff;
          border: 1px solid #ece5e1;
          border-radius: 10px;
          box-shadow: 0 12px 32px rgba(28, 25, 23, 0.16);
          overflow: hidden auto;
          max-height: 70vh;
          z-index: 100;
        }
        .crm-search-panel {
          left: 0;
          right: 0;
        }
        .crm-bell-panel {
          right: 0;
          width: 360px;
        }
        .crm-panel-group + .crm-panel-group {
          border-top: 1px solid #ece5e1;
        }
        .crm-panel-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 9px 14px;
          background: #f6f3f1;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          color: #57534e;
        }
        .crm-panel-count {
          background: #ece5e1;
          color: #44403c;
          border-radius: 9px;
          padding: 1px 7px;
          font-size: 11px;
          letter-spacing: 0;
          text-transform: none;
        }
        .crm-panel-note {
          padding: 12px 14px;
          font-size: 13px;
          color: #6b6560;
          line-height: 1.45;
        }
        .crm-panel-error {
          color: #c8102e;
        }
        .crm-panel-row {
          display: flex;
          flex-direction: column;
          gap: 2px;
          width: 100%;
          padding: 10px 14px;
          border: none;
          border-top: 1px solid #f4efec;
          background: none;
          text-align: left;
          text-decoration: none;
          cursor: pointer;
          font: inherit;
          transition: background 0.12s;
        }
        .crm-panel-row:hover {
          background: #f9f6f4;
        }
        /* An unread alert keeps a marker on its left edge rather than a tinted
           background, so a busy inbox does not turn into a wall of red. */
        .crm-panel-row.unread {
          box-shadow: inset 3px 0 0 #c8102e;
        }
        .crm-panel-row-title {
          font-size: 13.5px;
          font-weight: 600;
          color: #1c1917;
        }
        .crm-panel-row-sub {
          font-size: 12px;
          color: #6b6560;
          line-height: 1.4;
        }
        .crm-panel-row-meta {
          font-size: 11px;
          color: #a8a29e;
        }
        .crm-panel-more {
          display: block;
          width: 100%;
          padding: 10px 14px;
          border: none;
          border-top: 1px solid #ece5e1;
          background: #fbfaf9;
          color: #c8102e;
          font-size: 12.5px;
          font-weight: 600;
          text-align: center;
          text-decoration: none;
          cursor: pointer;
        }
        .crm-panel-more:hover {
          background: #fbecee;
        }
        .crm-panel-more:disabled {
          color: #a8a29e;
          background: #fbfaf9;
          cursor: default;
        }
        .crm-panel-foot-link {
          color: #57534e;
        }
        .crm-panel-foot {
          padding: 10px 14px;
          border-top: 1px solid #ece5e1;
          background: #fbfaf9;
          font-size: 11px;
          line-height: 1.5;
          color: #8a817b;
        }

        .crm-profile-menu {
          position: relative;
        }
        .crm-profile-btn {
          display: flex;
          align-items: center;
          gap: 12px;
          background: none;
          border: none;
          cursor: pointer;
          padding: 4px 8px;
          border-radius: 6px;
        }
        .crm-profile-btn:hover {
          background: #f6f3f1;
        }
        .crm-avatar {
          width: 34px;
          height: 34px;
          border-radius: 50%;
          background: linear-gradient(135deg, #c8102e 0%, #7c0a1b 100%);
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 700;
          font-size: 14px;
          box-shadow: 0 2px 6px rgba(200, 16, 46, 0.35);
        }
        .crm-profile-info {
          text-align: left;
        }
        .crm-profile-email {
          font-size: 13px;
          font-weight: 600;
          color: #1c1917;
        }
        .crm-profile-role {
          font-size: 10px;
          color: #8a817b;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .crm-dropdown {
          position: absolute;
          top: 100%;
          right: 0;
          margin-top: 10px;
          background: #fff;
          border: 1px solid #ece5e1;
          border-radius: 10px;
          box-shadow: 0 12px 32px rgba(28, 25, 23, 0.16);
          min-width: 190px;
          overflow: hidden;
          z-index: 100;
        }
        :global(.crm-dropdown-item) {
          display: block;
          padding: 11px 16px;
          color: #1c1917;
          text-decoration: none;
          font-size: 14px;
          border: none;
          background: none;
          width: 100%;
          text-align: left;
          cursor: pointer;
          transition: background 0.12s;
        }
        :global(.crm-dropdown-item:hover) {
          background: #f6f3f1;
        }
        :global(.crm-dropdown-danger) {
          color: #c8102e;
          font-weight: 600;
          border-top: 1px solid #ece5e1;
        }
        :global(.crm-dropdown-danger:hover) {
          background: #fbecee;
        }

        /* Content */
        .crm-content {
          flex: 1;
          overflow-y: auto;
          padding: 28px 32px;
        }

        /* Screen-level refusal (bookmarked URL this session may not open) */
        .crm-denied {
          max-width: 560px;
          margin: 48px auto;
          background: #fff;
          border: 1px solid #ece5e1;
          border-left: 4px solid #c8102e;
          border-radius: 12px;
          padding: 28px 30px;
          box-shadow: 0 12px 32px rgba(28, 25, 23, 0.08);
        }
        .crm-denied-badge {
          display: inline-block;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          color: #c8102e;
          background: #fbecee;
          border: 1px solid #f2ccd2;
          border-radius: 999px;
          padding: 4px 10px;
          margin-bottom: 14px;
        }
        .crm-denied-title {
          margin: 0 0 12px;
          font-size: 19px;
          font-weight: 700;
          color: #1c1917;
        }
        .crm-denied-body {
          margin: 0 0 12px;
          font-size: 14px;
          line-height: 1.65;
          color: #57534e;
        }
        .crm-denied-code {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12.5px;
          background: #f6f3f1;
          border: 1px solid #ece5e1;
          border-radius: 4px;
          padding: 1px 5px;
          color: #1c1917;
        }
        :global(.crm-denied-link) {
          display: inline-block;
          margin-top: 8px;
          background: #c8102e;
          color: #fff;
          text-decoration: none;
          border-radius: 8px;
          padding: 10px 18px;
          font-size: 14px;
          font-weight: 600;
        }

        .spinner {
          width: 40px;
          height: 40px;
          border: 3px solid #ece5e1;
          border-top-color: #c8102e;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          margin: 0 auto;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
