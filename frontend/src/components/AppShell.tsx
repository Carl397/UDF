'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useAuth } from '../lib/auth';
import { api, tokenStore } from '../lib/api';
import { deriveCaps, type Caps } from '../lib/caps';
import { ALL_TIERS } from '../lib/taxonomy';
import { Icon, ToastProvider } from './ui';
import Logo from './Logo';
import HomeTab from './tabs/HomeTab';
import MapTab from './tabs/MapTab';
import MembersTab from './tabs/MembersTab';
import EngageTab from './tabs/EngageTab';
import MoreTab from './tabs/MoreTab';

/** Bottom-bar destinations. */
export type TabId = 'home' | 'map' | 'members' | 'engage' | 'more';

/** Second-level destination inside a tab (deep links from Home / alerts). */
export type Section =
  | ''
  | 'events'
  | 'appointments'
  | 'alerts'
  | 'posts'
  | 'manifesto'
  | 'register'
  | 'invite'
  | 'supporter'
  | 'settings'
  | 'cases'
  | 'bulletins'
  | 'participations'
  | 'patrols'
  | 'projects'
  | 'jobs'
  | 'overview';

export interface Filters {
  regionCode: string;
  /**
   * Visible member tiers — a multi-select, driven by the map legend and the
   * Filters sheet. Every tier is on by default; an empty list means the user
   * switched them all off, so screens render nothing rather than everything.
   */
  tiers: string[];
  status: string;
}

/**
 * Re-exported for the screens that type against it (`SettingsTab`). The
 * interface itself lives in `lib/caps.ts` next to `deriveCaps`, so the shape
 * and the derivation cannot be edited apart from each other.
 */
export type { Caps };

interface ShellState {
  tab: TabId;
  section: Section;
  setTab: (t: TabId) => void;
  open: (tab: TabId, section?: Section) => void;
  filters: Filters;
  setFilters: (f: Partial<Filters>) => void;
  caps: Caps;
  /**
   * The module keys enabled for this session (from `useAuth`). Permission-backed
   * modules are already folded into `caps` (a disabled module's permissions are
   * stripped server-side); this list is for the UI-only surfaces that own no
   * permission — `id_cards` — via `lib/modules.ts` `moduleOn`.
   */
  modules: string[];
  /** Kept for the member directory sheets. */
  canDecryptPii: boolean;
  unread: number;
  refreshUnread: () => void;
}

const ShellCtx = createContext<ShellState | undefined>(undefined);

export function useShell(): ShellState {
  const ctx = useContext(ShellCtx);
  if (!ctx) throw new Error('useShell must be used within <AppShell>');
  return ctx;
}

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'map', label: 'Map', icon: 'map' },
  { id: 'members', label: 'Members', icon: 'users' },
  { id: 'engage', label: 'Engage', icon: 'calendar' },
  { id: 'more', label: 'More', icon: 'dots' },
];

/**
 * The bottom bar this session actually gets.
 *
 * Two tabs sit behind a permission, and for the same reason: a screen whose
 * every request is guaranteed to be refused is worse than no screen, because it
 * renders as *empty data* rather than as *no access*.
 *
 *   `members` → `GET /members` needs `member:read`, which `member` and
 *               `analyst` do not hold. Without the gate it showed a red toast
 *               and an empty list that reads as "the party has no members".
 *   `map`     → the full analytics map under `/api/geo/*` needs `geo:read`,
 *               which `member` lacks — member GPS points are personal
 *               information about identifiable people, so that layer is not open
 *               to the whole membership. From Wave 4 a member instead holds
 *               `geo:read_own_ward` and gets a RESTRICTED map of their own ward
 *               (subcouncil + ward shapes, councillor, ward case heat) via
 *               `/api/geo/my-ward`, so the tab is gated on `memberMap`
 *               (`geoRead || geoReadOwn`) and `MapTab` dispatches to the right
 *               surface. A role holding neither sees no tab.
 *
 * The other three tabs are built from public or self-scoped endpoints and stay
 * for everyone.
 */
function tabsFor(caps: Caps) {
  return TABS.filter((t) => {
    if (t.id === 'members') return caps.memberRead;
    if (t.id === 'map') return caps.memberMap;
    return true;
  });
}

const TITLES: Record<TabId, { title: string; sub: string }> = {
  home: { title: 'UDF Party', sub: 'Movement command center' },
  map: { title: 'Movement Map', sub: 'Members, regions & momentum' },
  members: { title: 'Members', sub: 'Directory, tiers & party cards' },
  engage: { title: 'Engage', sub: 'Events, mandates & alerts' },
  more: { title: 'More', sub: 'Newsroom, mission & settings' },
};

const SECTION_TITLES: Partial<Record<Section, { title: string; sub: string }>> = {
  events: { title: 'Events', sub: 'Rallies, meetings & canvasses' },
  appointments: { title: 'Appointments', sub: 'Mandates & party offices' },
  alerts: { title: 'Notifications', sub: 'Movement alerts' },
  posts: { title: 'Newsroom', sub: 'News, press & community notes' },
  manifesto: { title: 'Mission & Vision', sub: 'What the UDF stands for' },
  register: { title: 'Register Member', sub: 'Membership application form' },
  invite: { title: 'Invite & grow', sub: 'Your reference number & recruitment tree' },
  supporter: { title: 'Supporter Card', sub: 'Share that you back the UDF' },
  settings: { title: 'Settings', sub: 'Account, privacy & preferences' },
  cases: { title: 'Service Requests', sub: 'Log, track & resolve community issues' },
  bulletins: { title: 'Ward Bulletins', sub: 'News, vacancies & completed work' },
  participations: { title: 'Public Participation', sub: 'Consultations, voting & community input' },
  patrols: { title: 'Patrols', sub: 'GPS-tracked ward oversight' },
  projects: { title: 'Projects', sub: 'Ward programmes & milestones' },
  jobs: { title: 'Ward Jobs', sub: 'Work interest & opportunities' },
  overview: { title: 'Metro Overview', sub: 'All wards, heat maps & trends' },
};

export default function AppShell() {
  return (
    <ToastProvider>
      <ShellInner />
    </ToastProvider>
  );
}

function ShellInner() {
  const { email, regionCodes, permissions, modules } = useAuth();
  const [tab, setTab] = useState<TabId>('home');
  const [section, setSection] = useState<Section>('');
  const [filters, setFiltersState] = useState<Filters>({
    regionCode: '',
    tiers: [...ALL_TIERS],
    status: '',
  });
  const [unread, setUnread] = useState(0);
  const [tick, setTick] = useState(0);

  const setFilters = useCallback(
    (f: Partial<Filters>) => setFiltersState((prev) => ({ ...prev, ...f })),
    [],
  );

  const open = useCallback((next: TabId, nextSection: Section = '') => {
    setTab(next);
    setSection(nextSection);
    document.querySelector('.app-body')?.scrollTo({ top: 0 });
  }, []);

  const refreshUnread = useCallback(() => setTick((t) => t + 1), []);

  // Badge count: on mount, whenever a screen asks for a refresh, and every minute.
  useEffect(() => {
    let cancelled = false;
    api
      .unreadCount()
      .then((r) => !cancelled && setUnread(r.unread))
      .catch(() => !cancelled && setUnread(0));
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Capabilities are derived from the permissions the server sent with this
  // session, not looked up from a role table — see lib/caps.ts for why the
  // table was removed.
  const caps = useMemo(() => deriveCaps(permissions), [permissions]);
  const tabs = useMemo(() => tabsFor(caps), [caps]);

  /**
   * Whether the permission list has arrived.
   *
   * A session created before the server sent permissions has none stored, and
   * `AuthProvider` heals it with one refresh. Until that lands every cap is
   * false, which would strip the Members tab from a role entitled to it and
   * then bounce it off that tab — a visible, self-inflicted regression for the
   * one migration case. `tokenStore.permissions` distinguishes "never stored"
   * (null) from "stored and empty" ([]), so hold off until it is known.
   */
  const permissionsSettled = permissions.length > 0 || tokenStore.permissions !== null;

  // A deep link, or a role changed underneath a live session, can leave the
  // shell on a tab this session no longer has. Send it home rather than render
  // the 403 the tab exists to produce.
  useEffect(() => {
    if (!permissionsSettled) return;
    if (!tabs.some((t) => t.id === tab)) open('home');
  }, [permissionsSettled, tabs, tab, open]);

  const value = useMemo<ShellState>(
    () => ({
      tab,
      section,
      setTab,
      open,
      filters,
      setFilters,
      caps,
      modules,
      canDecryptPii: caps.pii,
      unread,
      refreshUnread,
    }),
    [tab, section, open, filters, setFilters, caps, modules, unread, refreshUnread],
  );

  const meta = SECTION_TITLES[section] ?? TITLES[tab];
  const flush = tab === 'map';
  const scopeLabel = regionCodes.length > 0 ? regionCodes.join(' · ') : 'National scope';

  return (
    <ShellCtx.Provider value={value}>
      <div className="app">
        <header className="app-header">
          <button className="brand-btn" onClick={() => open('home')} aria-label="UDF home">
            <Logo size={30} wordmark={false} />
          </button>
          <div className="title-wrap">
            <div className="screen-title">{meta.title}</div>
            <div className="screen-sub">{meta.sub}</div>
          </div>
          <button
            className="icon-btn bell-btn"
            onClick={() => open('engage', 'alerts')}
            aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
          >
            <Icon name="bell" size={19} />
            {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
          </button>
          <button
            className="avatar-btn"
            onClick={() => open('more', 'settings')}
            aria-label="Open settings"
            title={`${email ?? ''} · ${scopeLabel}`}
          >
            {(email ?? 'U')[0]!.toUpperCase()}
          </button>
        </header>

        <main className={`app-body ${flush ? 'flush' : ''}`}>
          {tab === 'home' && <HomeTab />}
          {/*
            Both of these are gated on the cap as well as the tab: the redirect
            above moves the shell off a tab this session no longer has, but an
            effect runs after paint, and ONE render is enough to fire the request
            the role is guaranteed to have refused — `GET /members` for the
            directory. The map is gated on `memberMap` (`geoRead || geoReadOwn`)
            and `MapTab` picks the full or restricted surface, so a member's one
            render fires `/geo/my-ward` (allowed), never `/geo/points` (refused).
          */}
          {tab === 'map' && caps.memberMap && <MapTab />}
          {tab === 'members' && caps.memberRead && <MembersTab />}
          {tab === 'engage' && <EngageTab />}
          {tab === 'more' && <MoreTab />}
        </main>

        <nav className="tabbar" aria-label="Primary">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => open(t.id, t.id === 'engage' ? 'events' : '')}
              aria-current={tab === t.id ? 'page' : undefined}
            >
              <Icon name={t.icon} />
              <span>{t.label}</span>
              {t.id === 'engage' && unread > 0 && (
                <span className="tab-dot" aria-hidden="true" />
              )}
            </button>
          ))}
        </nav>
      </div>
    </ShellCtx.Provider>
  );
}
