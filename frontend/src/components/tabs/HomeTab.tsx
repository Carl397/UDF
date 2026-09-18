'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Perm, can } from '../../lib/caps';
import { srStatusBadgeClass, srStatusLabel } from '../../lib/caseStatus';
import { useShell } from '../AppShell';
import { EmptyState, Icon, memberLabel, memberRefLabel } from '../ui';
import { WardDetailPanel } from '../WardTransparency';
import { KIND_ICON } from './EngageTab';
import RateCouncillor from './RateCouncillor';
import type { Appointment, Member, PartyEvent, Post, ServiceRequest, WardBulletin } from '../../types';

const ROLE_LABEL: Record<string, string> = {
  national_admin: 'National Admin',
  regional_organizer: 'Regional Organizer',
  local_coordinator: 'Local Coordinator',
  ward_councillor: 'Ward Councillor',
  analyst: 'Analyst',
  member: 'Member',
};

const POST_LABEL: Record<string, string> = {
  news: 'News',
  press_release: 'Press release',
  highlight: 'Highlight',
  statement: 'Statement',
  community_note: 'Community note',
  service_delivery: 'Service delivery',
};

/**
 * The numbers behind the "Movement at a glance" tiles.
 *
 * Each one is a server-side `count(*)` over the caller's own scope, never the
 * length of a preview page. Counting the fetched array saturates at the
 * `limit` and reports a filtered subset as though it were the whole
 * population: a movement of 4 000 members read as "Members 500", and
 * "Volunteers" only ever counted those inside the newest 500 rows.
 *
 * `null` means "not known yet, or this session may not ask"; a real `0` means
 * the server counted zero. The two must never render identically.
 */
type CountKey = 'members' | 'active' | 'volunteers' | 'cases' | 'events' | 'posts';
type HomeCounts = Record<CountKey, number | null>;

const EMPTY_COUNTS: HomeCounts = {
  members: null,
  active: null,
  volunteers: null,
  cases: null,
  events: null,
  posts: null,
};

/**
 * A tile number. `null` — not known yet, or this session may not ask — renders
 * an em dash, never a `0`. A zero this screen could not have counted is exactly
 * the fabrication D51 was raised for.
 */
function TileCount({ value }: { value: number | null }) {
  return <div className="num">{value === null ? '—' : value}</div>;
}

export default function HomeTab() {
  const { role, regionCodes, wardCode, permissions } = useAuth();
  const { open, canDecryptPii, caps, unread } = useShell();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [events, setEvents] = useState<PartyEvent[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [proposed, setProposed] = useState<Appointment[] | null>(null);
  const [cases, setCases] = useState<ServiceRequest[]>([]);
  const [bulletins, setBulletins] = useState<WardBulletin[]>([]);
  const [counts, setCounts] = useState<HomeCounts>(EMPTY_COUNTS);

  /**
   * Whether the member-derived numbers on this screen can be real.
   *
   * `GET /members` is gated on `member:read`, which `member` and `analyst` do
   * not hold. This screen used to call it unconditionally and swallow the 403
   * into an empty array, so those two roles were shown "Members 0 · Active 0 ·
   * Volunteers 0" — figures that look like data and are not. A zero that cannot
   * be distinguished from a real zero is worse than no number at all, so the
   * call is not made and the tiles are replaced with ones this session can
   * actually populate.
   */
  const memberStatsAvailable = caps.memberRead;
  const bulletinsAvailable = can(permissions, Perm.BULLETIN_READ);
  // FR-O2: the member/councillor "Invite & grow" surface — gated on the same
  // permission the API enforces, so the shortcut never opens a guaranteed 403.
  const recruitRead = can(permissions, Perm.RECRUITMENT_READ);
  // FR-S4: the monthly councillor scorecard — a MEMBER-only surface, gated on the
  // same write permission the API enforces (no staff role holds it), so the card
  // never renders for a session whose submit would be refused.
  const canRate = can(permissions, Perm.RATING_SCORECARD_WRITE);

  useEffect(() => {
    let cancelled = false;
    const put = (key: CountKey, value: number) => {
      if (!cancelled) setCounts((prev) => ({ ...prev, [key]: value }));
    };

    if (memberStatsAvailable) {
      // `limit: 4` because exactly four sign-ups are rendered below and the
      // server already orders by `created_at DESC`; the page *is* the newest
      // four. The tile reads `res.total`, so the count stays exact however
      // large the directory gets.
      api
        .listMembers({ limit: 4 })
        .then((res) => {
          if (cancelled) return;
          setMembers(res.items);
          put('members', res.total);
        })
        .catch(() => !cancelled && setMembers([]));
      api
        .listMembers({ status: 'active', limit: 1 })
        .then((res) => put('active', res.total))
        .catch(() => undefined);
      // "Volunteers" has always meant the two activist tiers together, and the
      // filter takes one value at a time, so it is two counts summed.
      Promise.all([
        api.listMembers({ tier: 'volunteer', limit: 1 }),
        api.listMembers({ tier: 'activist', limit: 1 }),
      ])
        .then(([volunteer, activist]) => put('volunteers', volunteer.total + activist.total))
        .catch(() => undefined);
    }

    // Public to every authenticated role, so these tiles are always real.
    api
      .listEvents({ upcoming: true, limit: 3 })
      .then((r) => {
        if (cancelled) return;
        setEvents(r.items);
        put('events', r.total);
      })
      .catch(() => !cancelled && setEvents([]));
    api
      .listPosts({ limit: 3 })
      .then((r) => {
        if (cancelled) return;
        setPosts(r.items);
        put('posts', r.total);
      })
      .catch(() => !cancelled && setPosts([]));
    if (caps.appoint) {
      api
        .listAppointments({ status: 'proposed', limit: 3 })
        .then((r) => !cancelled && setProposed(r.items))
        .catch(() => !cancelled && setProposed([]));
    }
    return () => {
      cancelled = true;
    };
  }, [caps.appoint, memberStatsAvailable]);

  // Load service delivery data
  useEffect(() => {
    let cancelled = false;
    api
      .listServiceRequests({ limit: '5' })
      .then((r) => {
        if (cancelled) return;
        setCases(r.items);
        setCounts((prev) => ({ ...prev, cases: r.total }));
      })
      .catch(() => !cancelled && setCases([]));
    // `bulletin:read` is held by members but not by analysts; without this the
    // analyst's home screen opened with a guaranteed-refused request.
    if (bulletinsAvailable) {
      api.listBulletins({ limit: '5' }).then((r) => !cancelled && setBulletins(r.items)).catch(() => !cancelled && setBulletins([]));
    }
    return () => { cancelled = true; };
  }, [bulletinsAvailable]);

  // The server returns members newest-first and the page is capped at four, so
  // the fetched page already *is* the latest sign-ups — no client-side re-sort.
  const recent = members ?? [];

  const next = events[0];

  return (
    <>
      {/* Scope hero. No greeting: the reader knows who they are, and the useful
          line is what this session can actually see. */}
      <div className="card hero-card">
        <span className="eyebrow">{ROLE_LABEL[role ?? ''] ?? 'Member'}</span>
        <p>
          {regionCodes.length > 0 ? `Scope: ${regionCodes.join(', ')}` : 'National scope'} ·{' '}
          {canDecryptPii ? 'PII access granted' : 'PII sealed for your role'}
        </p>
      </div>

      {unread > 0 && (
        <button className="banner alert-strip" onClick={() => open('engage', 'alerts')}>
          <Icon name="bell" size={17} />
          <span>
            <strong>{unread} unread</strong> movement alert{unread === 1 ? '' : 's'} — tap to review
          </span>
          <Icon name="chev" size={16} />
        </button>
      )}

      {/* Stats */}
      <div className="section-label">Movement at a glance</div>
      {!memberStatsAvailable ? (
        /*
         * D51 — this session holds no `member:read`, so the member tiles are
         * not rendered at all rather than rendered as zeros. Every tile below
         * is fed by a call this role is actually permitted to make: service
         * requests need `case:read` (all six roles hold it), events and posts
         * are public, and the unread alert count is per-session.
         */
        <div className="stat-grid">
          <div className="stat accent">
            <TileCount value={counts.cases} />
            <div className="lbl">Service requests</div>
          </div>
          <div className="stat">
            <TileCount value={counts.events} />
            <div className="lbl">Upcoming events</div>
          </div>
          <div className="stat">
            <TileCount value={counts.posts} />
            <div className="lbl">Newsroom posts</div>
          </div>
          <div className="stat">
            <div className="num">{unread}</div>
            <div className="lbl">Unread alerts</div>
          </div>
        </div>
      ) : members === null ? (
        <div className="stat-grid">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 66 }} />
          ))}
        </div>
      ) : (
        <div className="stat-grid">
          <div className="stat accent">
            <TileCount value={counts.members} />
            <div className="lbl">Members</div>
          </div>
          <div className="stat">
            <TileCount value={counts.active} />
            <div className="lbl">Active</div>
          </div>
          <div className="stat">
            <TileCount value={counts.volunteers} />
            <div className="lbl">Volunteers</div>
          </div>
          <div className="stat">
            <TileCount value={counts.events} />
            <div className="lbl">Next up</div>
          </div>
        </div>
      )}

      {/* PRD FR-D: members see the transparency detail for their own ward only.
          Staff roles keep their existing service-delivery surfaces below. */}
      {role === 'member' && wardCode && (
        <>
          <div className="section-label">My ward transparency</div>
          <WardDetailPanel wardCode={wardCode} />
        </>
      )}

      {/* PRD-growth FR-S4: the monthly councillor scorecard sits on the front of
          the member's app so their ward councillor can be rated "at all times".
          The 1–2 ⇒ 100-word reason rule (FR-S3) and the acknowledgement freeze
          (FR-S2) live inside the panel. */}
      {canRate && (
        <>
          <div className="section-label">Rate your councillor</div>
          <RateCouncillor />
        </>
      )}

      {/* Service Delivery Quick Actions */}
      {(caps.caseLog || caps.bulletinWrite || caps.patrolWrite || caps.overviewRead) && (
        <>
          <div className="section-label">Service delivery</div>
          <div className="qa-grid">
            {caps.caseLog && (
              <button className="qa" onClick={() => open('engage', 'cases')}>
                <span className="ico"><Icon name="alert" /></span>
                Log Issue
              </button>
            )}
            {caps.bulletinWrite && (
              <button className="qa gold" onClick={() => open('engage', 'bulletins')}>
                <span className="ico"><Icon name="megaphone" /></span>
                Ward Bulletin
              </button>
            )}
            {caps.patrolWrite && (
              <button className="qa dark" onClick={() => open('engage', 'patrols')}>
                <span className="ico"><Icon name="pin" /></span>
                Start Patrol
              </button>
            )}
            {caps.overviewRead && (
              <button className="qa" onClick={() => open('engage', 'overview')}>
                <span className="ico"><Icon name="chart" /></span>
                Metro Overview
              </button>
            )}
          </div>
        </>
      )}

      {/* Ward Bulletins Feed */}
      {bulletins.length > 0 && (
        <>
          <div className="section-label">Ward bulletins</div>
          <div className="rows">
            {bulletins.slice(0, 3).map((b) => (
              <button key={b.id} className="row" onClick={() => open('engage', 'bulletins')}>
                <span className="row-ico"><Icon name={b.kind === 'completed_work' ? 'check' : b.kind === 'vacancy' ? 'clipboard' : 'megaphone'} /></span>
                <span className="row-main">
                  <span className="row-title">{b.title}</span>
                  <span className="row-sub tiny">
                    {b.kind.replace(/_/g, ' ')} · {new Date(b.publishedAt).toLocaleDateString()}
                  </span>
                </span>
                <span className="badge">{b.wardCode}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Open Cases */}
      {cases.length > 0 && (
        <>
          <div className="section-label">Recent service requests</div>
          <div className="rows">
            {cases.slice(0, 3).map((c) => (
              <button key={c.id} className="row" onClick={() => open('engage', 'cases')}>
                <span className="row-ico"><Icon name="alert" /></span>
                <span className="row-main">
                  <span className="row-title">{c.title}</span>
                  <span className="row-sub tiny">
                    {c.refNo} · {c.category} · {c.severity}
                  </span>
                </span>
                <span className={srStatusBadgeClass(c.status)}>{srStatusLabel(c.status)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Quick actions */}
      <div className="section-label">Quick actions</div>
      <div className="qa-grid">
        {/*
          Both map shortcuts need the Map tab to exist for this session: they
          land on a tab gated by `memberMap` (`geo:read` for staff, or
          `geo:read_own_ward` for a member's restricted own-ward map). Without
          the gate the shell would bounce a role holding neither straight back
          home — a button that appears to do nothing.
        */}
        {caps.memberMap && (
          <button className="qa" onClick={() => open('map')}>
            <span className="ico"><Icon name="map" /></span>
            Member Map
          </button>
        )}
        <button className="qa dark" onClick={() => open('engage', 'events')}>
          <span className="ico"><Icon name="calendar" /></span>
          Events
        </button>
        <button className="qa" onClick={() => open('more', 'posts')}>
          <span className="ico"><Icon name="megaphone" /></span>
          Newsroom
        </button>
        {recruitRead && (
          <button className="qa gold" onClick={() => open('more', 'invite')}>
            <span className="ico"><Icon name="users" /></span>
            Invite &amp; grow
          </button>
        )}
        {caps.memberWrite && (
          <button className="qa" onClick={() => open('more', 'register')}>
            <span className="ico"><Icon name="clipboard" /></span>
            Register
          </button>
        )}
      </div>

      {/* Next event */}
      <div className="section-label">Next on the calendar</div>
      {next ? (
        <button className="event-card" onClick={() => open('engage', 'events')}>
          <span className="date-chip">
            <span className="d">{new Date(next.startsAt).getDate()}</span>
            <span className="m">
              {new Date(next.startsAt).toLocaleString(undefined, { month: 'short' }).toUpperCase()}
            </span>
          </span>
          <span className="event-main">
            <span className="event-title">{next.title}</span>
            <span className="event-sub">
              {new Date(next.startsAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
              {next.venue ? ` · ${next.venue}` : ''}
            </span>
            <span className="event-meta">
              <Icon name={KIND_ICON[next.kind] ?? 'calendar'} size={13} />
              <span className="badge">{next.kind}</span>
              {next.regionCode && <span className="badge tier">{next.regionCode}</span>}
              {next.rsvpCount > 0 && <span className="badge ok">{next.rsvpCount} going</span>}
            </span>
          </span>
          <Icon name="chev" size={16} />
        </button>
      ) : (
        <div className="card">
          <EmptyState
            icon="calendar"
            title="Nothing scheduled"
            hint={caps.eventWrite ? 'Publish a rally, meeting or canvass from Engage.' : 'Events appear here once published.'}
          />
        </div>
      )}

      {/* Mandates awaiting acceptance */}
      {proposed && proposed.length > 0 && (
        <>
          <div className="section-label">Mandates awaiting acceptance</div>
          <div className="rows">
            {proposed.map((a) => (
              <button key={a.id} className="row" onClick={() => open('engage', 'appointments')}>
                <span className="row-ico"><Icon name="shield" /></span>
                <span className="row-main">
                  <span className="row-title">{a.title ?? a.positionName ?? 'Appointment'}</span>
                  <span className="row-sub">
                    {memberRefLabel(a.member, a.memberId)}
                    {a.ward ? ` · Ward ${a.ward}` : a.regionCode ? ` · ${a.regionCode}` : ''}
                  </span>
                </span>
                <span className="badge warn">proposed</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Newsroom */}
      <div className="section-label">Latest from the newsroom</div>
      {posts.length === 0 ? (
        <div className="card">
          <EmptyState icon="megaphone" title="Nothing published yet" hint="Press releases and community notes land here." />
        </div>
      ) : (
        <div className="rows">
          {posts.map((p) => (
            <button key={p.id} className="row" onClick={() => open('more', 'posts')}>
              <span className="row-ico">
                <Icon name={p.kind === 'community_note' ? 'alert' : p.kind === 'press_release' ? 'megaphone' : 'doc'} />
              </span>
              <span className="row-main">
                <span className="row-title">{p.title}</span>
                <span className="row-sub tiny">
                  {POST_LABEL[p.kind] ?? p.kind} ·{' '}
                  {new Date(p.publishedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                  {p.regionCode ? ` · ${p.regionCode}` : ''}
                </span>
              </span>
              <Icon name="chev" size={16} />
            </button>
          ))}
        </div>
      )}

      {/* Recent members — D51: rendered only for sessions that can actually
          read the directory. Its empty state used to tell `member` and
          `analyst` to "Add your first member from the Members tab": a tab those
          roles do not have, and an action `member:write` would have refused. */}
      {memberStatsAvailable && (
        <>
          <div className="section-label">Latest sign-ups</div>
          {recent.length === 0 ? (
            <div className="card">
              <EmptyState
                icon="users"
                title="No members yet"
                hint={
                  caps.memberWrite
                    ? 'Add your first member from the Members tab.'
                    : 'New sign-ups in your scope will appear here.'
                }
              />
            </div>
          ) : (
            <div className="rows">
              {recent.map((m) => (
                <button key={m.id} className="row" onClick={() => open('members')}>
                  <span className="row-ico"><Icon name="pin" /></span>
                  <span className="row-main">
                    <span className="row-title">{memberLabel(m)}</span>
                    <span className="row-sub">
                      {m.tier} · {m.regionCode ?? '—'} · {new Date(m.createdAt).toLocaleDateString()}
                    </span>
                  </span>
                  <span className={`dot ${m.status === 'active' ? 'ok' : m.status === 'suspended' ? 'danger' : 'mute'}`} />
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <div style={{ height: 12 }} />
    </>
  );
}
