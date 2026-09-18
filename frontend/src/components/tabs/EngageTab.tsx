'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { srStatusBadgeClass, srStatusLabel, followUpBadgeClass, followUpLabel } from '../../lib/caseStatus';
import { useShell } from '../AppShell';
import { EmptyState, Icon, memberRefLabel, useToast } from '../ui';
import FilterBar from './FilterBar';
import EventSheet from './EventSheet';
import AppointmentSheet from './AppointmentSheet';
import CaseSheet from './CaseSheet';
import PatrolSheet from './PatrolSheet';
import JobsSection from './JobsSection';
import ReportToCouncillor from './ReportToCouncillor';
import type { Appointment, AppNotification, PartyEvent, ServiceRequest, WardBulletin, Participation, Patrol, Project } from '../../types';

type Sub = 'events' | 'appointments' | 'alerts' | 'report' | 'cases' | 'bulletins' | 'participations' | 'patrols' | 'projects' | 'jobs' | 'overview';

/** One tile in the Engage grid. `badge` is a live count, hidden when zero. */
interface Tile {
  id: Sub;
  label: string;
  icon: string;
  badge?: number;
}

/** A `.section-label` heading over the tiles that belong together. */
interface TileGroup {
  label: string;
  tiles: Tile[];
}

/** Event kind → icon, shared with the Home dashboard. */
export const KIND_ICON: Record<string, string> = {
  rally: 'megaphone',
  meeting: 'users',
  training: 'clipboard',
  canvass: 'pin',
  debate: 'doc',
  fundraiser: 'star',
  service: 'shield',
  webinar: 'chart',
};

const NOTE_ICON: Record<string, string> = {
  event: 'calendar',
  post: 'megaphone',
  appointment: 'idcard',
  mandate: 'shield',
  member: 'users',
  alert: 'alert',
  info: 'info',
};

export default function EngageTab() {
  const { section, open, filters, caps, unread, refreshUnread } = useShell();
  const toast = useToast();

  const [sub, setSub] = useState<Sub>('events');
  const [events, setEvents] = useState<PartyEvent[] | null>(null);
  const [appointments, setAppointments] = useState<Appointment[] | null>(null);
  const [notes, setNotes] = useState<AppNotification[] | null>(null);
  const [past, setPast] = useState(false);
  const [apptFilter, setApptFilter] = useState<'all' | 'proposed' | 'confirmed'>('all');
  const [openEvent, setOpenEvent] = useState<PartyEvent | null | undefined>(undefined);
  const [openAppt, setOpenAppt] = useState<Appointment | null | undefined>(undefined);
  const [openCase, setOpenCase] = useState<ServiceRequest | null | undefined>(undefined);
  const [openPatrol, setOpenPatrol] = useState<Patrol | null | undefined>(undefined);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [cases, setCases] = useState<ServiceRequest[] | null>(null);
  const [bulletins, setBulletins] = useState<WardBulletin[] | null>(null);
  const [participations, setParticipations] = useState<Participation[] | null>(null);
  const [patrolList, setPatrolList] = useState<Patrol[] | null>(null);
  const [projectList, setProjectList] = useState<Project[] | null>(null);

  // Deep links from Home / notifications: tab:engage#<sub>[:<id>]
  useEffect(() => {
    const valid: string[] = ['events','appointments','alerts','report','cases','bulletins','participations','patrols','projects','jobs','overview'];
    if (valid.includes(section)) setSub(section as Sub);
  }, [section]);

  const loadEvents = useCallback(() => {
    api
      .listEvents({
        upcoming: !past,
        limit: 60,
        regionCode: filters.regionCode || undefined,
      })
      .then((r) => setEvents(r.items))
      .catch(() => setEvents([]));
  }, [past, filters.regionCode]);

  const loadAppointments = useCallback(() => {
    api
      .listAppointments({
        limit: 100,
        regionCode: filters.regionCode || undefined,
        status: apptFilter === 'all' ? undefined : apptFilter,
      })
      .then((r) => setAppointments(r.items))
      .catch(() => setAppointments([]));
  }, [apptFilter, filters.regionCode]);

  const loadNotes = useCallback(() => {
    api
      .listNotifications({ limit: 60 })
      .then((r) => setNotes(r.items))
      .catch(() => setNotes([]));
  }, []);

  const loadCases = useCallback(() => {
    api
      .listServiceRequests({ limit: '50' })
      .then((r) => setCases(r.items))
      .catch(() => setCases([]));
  }, []);

  const loadPatrols = useCallback(() => {
    api
      .listPatrols({ limit: '50' })
      .then((r) => setPatrolList(r.items))
      .catch(() => setPatrolList([]));
  }, []);

  useEffect(() => {
    if (sub === 'events') loadEvents();
    if (sub === 'appointments') loadAppointments();
    if (sub === 'alerts') loadNotes();
    if (sub === 'cases') loadCases();
    if (sub === 'bulletins') api.listBulletins({ limit: '50' }).then(r => setBulletins(r.items)).catch(() => setBulletins([]));
    if (sub === 'participations') api.listParticipations({ limit: '50' }).then(r => setParticipations(r.items)).catch(() => setParticipations([]));
    if (sub === 'patrols') loadPatrols();
    if (sub === 'projects') api.listProjects({ limit: '50' }).then(r => setProjectList(r.items)).catch(() => setProjectList([]));
    // The Metro overview panel prints four counts read straight out of these
    // lists, and Home links to it directly (`open('engage', 'overview')`).
    // Left to the per-tab loads above, a reader who arrived by that link saw
    // "—" for all four, which reads as "no data" rather than "not loaded".
    // Gated on the same caps as the tiles that own these lists, so a role that
    // cannot see the tile does not fire a request the server would refuse.
    if (sub === 'overview' && (caps.caseLog || caps.bulletinWrite)) {
      api.listServiceRequests({ limit: '50' }).then(r => setCases(r.items)).catch(() => setCases([]));
      api.listBulletins({ limit: '50' }).then(r => setBulletins(r.items)).catch(() => setBulletins([]));
      api.listPatrols({ limit: '50' }).then(r => setPatrolList(r.items)).catch(() => setPatrolList([]));
      api.listProjects({ limit: '50' }).then(r => setProjectList(r.items)).catch(() => setProjectList([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, loadEvents, loadAppointments, loadNotes]);

  // Open the record a notification pointed at, once its list has arrived.
  useEffect(() => {
    if (!pendingId) return;
    const ev = events?.find((e) => e.id === pendingId);
    if (ev) {
      setOpenEvent(ev);
      setPendingId(null);
      return;
    }
    const ap = appointments?.find((a) => a.id === pendingId);
    if (ap) {
      setOpenAppt(ap);
      setPendingId(null);
    }
  }, [pendingId, events, appointments]);

  const counts = useMemo(
    () => ({
      events: events?.length ?? 0,
      appointments: appointments?.length ?? 0,
      unread,
    }),
    [events, appointments, unread],
  );

  function followLink(link: string | null) {
    if (!link) return;
    const m = /^tab:(\w+)#([\w]*):?(.*)$/.exec(link);
    if (!m) return;
    const [, tab, sec, id] = m;
    const nextSub = (sec === 'appointments' || sec === 'alerts' || sec === 'jobs' || sec === 'report' ? sec : 'events') as Sub;
    if (tab === 'engage') {
      setSub(nextSub);
      if (id) setPendingId(id);
    } else {
      open(tab as any, (sec as any) ?? '');
    }
  }

  async function markRead(n: AppNotification) {
    if (n.read) return followLink(n.link);
    try {
      await api.markNotificationRead(n.id);
      setNotes((list) => list?.map((x) => (x.id === n.id ? { ...x, read: true } : x)) ?? null);
      refreshUnread();
    } catch {
      /* non-fatal */
    }
    followLink(n.link);
  }

  async function markAll() {
    try {
      const r = await api.markAllNotificationsRead();
      setNotes((list) => list?.map((x) => ({ ...x, read: true })) ?? null);
      refreshUnread();
      toast(`${r.marked} notifications marked read`, 'ok');
    } catch (e: any) {
      toast(e?.message ?? 'Could not update', 'err');
    }
  }

  /**
   * The Engage destinations, grouped by what the user is trying to do.
   *
   * This replaces a ten-item `Segmented`. A segmented row cannot wrap, so on a
   * phone the last items were only reachable by dragging a strip with nothing on
   * screen to say it could be dragged, and a two-word label was clipped
   * mid-word. Tiles wrap, so every destination is visible at once.
   *
   * The capability conditionals are carried over verbatim from the old options
   * array — a group with no tiles the role may see disappears entirely rather
   * than leaving an empty heading behind.
   */
  const fieldWork = caps.caseLog || caps.bulletinWrite;
  // Hoisted because a spread conditional is inferred on its own, outside the
  // `TileGroup[]` annotation, so its `id` literals would widen to `string`.
  const caseTiles: Tile[] = fieldWork
    ? [
        { id: 'cases', label: 'Cases', icon: 'alert' },
        { id: 'bulletins', label: 'Bulletins', icon: 'megaphone' },
      ]
    : [];
  // Annotated on its own statement so each `id` literal is checked against
  // `Sub`: chained through `.filter()` the contextual type is lost and every id
  // widens to `string`, which would let a typo through silently.
  const groups: TileGroup[] = [
    {
      label: "What's on",
      tiles: [
        { id: 'events', label: 'Events', icon: 'calendar', badge: counts.events },
        { id: 'appointments', label: 'Mandates', icon: 'shield' },
        { id: 'alerts', label: 'Alerts', icon: 'bell', badge: counts.unread },
      ],
    },
    {
      label: 'Report & cases',
      tiles: [{ id: 'report', label: 'Report', icon: 'send' }, ...caseTiles],
    },
    {
      label: 'Field',
      tiles: fieldWork
        ? [
            { id: 'participations', label: 'Participate', icon: 'users' },
            { id: 'patrols', label: 'Patrols', icon: 'pin' },
            { id: 'projects', label: 'Projects', icon: 'chart' },
          ]
        : [],
    },
    {
      label: 'Work',
      tiles:
        caps.jobInterest || caps.jobDemand
          ? [{ id: 'jobs', label: 'Jobs', icon: 'briefcase' }]
          : [],
    },
  ];
  const tileGroups = groups.filter((g) => g.tiles.length > 0);

  return (
    <>
      <div className="tile-groups">
        {tileGroups.map((g) => (
          <section key={g.label}>
            <div className="section-label">{g.label}</div>
            <div className="tile-grid" role="tablist" aria-label={g.label}>
              {g.tiles.map((t) => {
                const on = sub === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    aria-label={t.badge ? `${t.label}, ${t.badge}` : t.label}
                    title={t.label}
                    className={`tile ${on ? 'on' : ''}`}
                    onClick={() => setSub(t.id)}
                  >
                    <span className="ico">
                      <Icon name={t.icon} size={19} />
                      {!!t.badge && <span className="tile-badge">{t.badge}</span>}
                    </span>
                    <span className="tile-label">{t.label}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {sub === 'events' && (
        <>
          <FilterBar />
          <div className="chip-row" style={{ marginTop: 8 }}>
            <button className={`chip ${!past ? 'on' : ''}`} onClick={() => setPast(false)}>
              Upcoming
            </button>
            <button className={`chip ${past ? 'on' : ''}`} onClick={() => setPast(true)}>
              Past
            </button>
          </div>

          {events === null ? (
            <div className="skeleton" style={{ height: 92, marginTop: 12 }} />
          ) : events.length === 0 ? (
            <div className="card" style={{ marginTop: 12 }}>
              <EmptyState
                icon="calendar"
                title={past ? 'Nothing in the archive yet' : 'No upcoming events'}
                hint={caps.eventWrite ? 'Publish a rally, meeting or canvass.' : 'Check back soon.'}
              />
            </div>
          ) : (
            <div className="list" style={{ marginTop: 12 }}>
              {events.map((e) => {
                const d = new Date(e.startsAt);
                return (
                  <button key={e.id} className="event-card" onClick={() => setOpenEvent(e)}>
                    <span className="date-chip">
                      <span className="d">{d.getDate()}</span>
                      <span className="m">
                        {d.toLocaleString(undefined, { month: 'short' }).toUpperCase()}
                      </span>
                    </span>
                    <span className="event-main">
                      <span className="event-title">{e.title}</span>
                      <span className="event-sub">
                        {d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                        {e.venue ? ` · ${e.venue}` : ''}
                      </span>
                      <span className="event-meta">
                        <Icon name={KIND_ICON[e.kind] ?? 'calendar'} size={13} />
                        <span className="badge">{e.kind}</span>
                        {e.regionCode && <span className="badge tier">{e.regionCode}</span>}
                        {e.ward && <span className="badge">Ward {e.ward}</span>}
                        {e.rsvpCount > 0 && <span className="badge ok">{e.rsvpCount} going</span>}
                        {e.status === 'cancelled' && <span className="badge danger">cancelled</span>}
                      </span>
                    </span>
                    <Icon name="chev" size={16} />
                  </button>
                );
              })}
            </div>
          )}

          {caps.eventWrite && (
            <button className="fab" onClick={() => setOpenEvent(null)} aria-label="Publish an event">
              <Icon name="plus" size={22} />
            </button>
          )}
        </>
      )}

      {sub === 'appointments' && (
        <>
          <div className="chip-row">
            {(['all', 'proposed', 'confirmed'] as const).map((s) => (
              <button
                key={s}
                className={`chip ${apptFilter === s ? 'on' : ''}`}
                onClick={() => setApptFilter(s)}
              >
                {s === 'all' ? 'All mandates' : s}
              </button>
            ))}
          </div>

          <p className="hint-text">
            Every appointment binds a member to a party office. The appointee accepts the mandate
            through a personal link; acceptance is recorded in the audit log.
          </p>

          {appointments === null ? (
            <div className="skeleton" style={{ height: 76 }} />
          ) : appointments.length === 0 ? (
            <div className="card">
              <EmptyState
                icon="idcard"
                title="No appointments"
                hint={caps.appoint ? 'Appoint a ward chair or candidate.' : 'Mandates appear here once issued.'}
              />
            </div>
          ) : (
            <div className="list">
              {appointments.map((a) => (
                <button key={a.id} className="row" onClick={() => setOpenAppt(a)}>
                  <span className="row-ico">
                    <Icon name="idcard" />
                  </span>
                  <span className="row-main">
                    <span className="row-title">
                      {a.title ?? a.positionName ?? a.positionCode ?? 'Appointment'}
                    </span>
                    <span className="row-sub">
                      {memberRefLabel(a.member, a.memberId)}
                      {a.ward ? ` · Ward ${a.ward}` : a.regionCode ? ` · ${a.regionCode}` : ''}
                      {a.termEnd ? ` · until ${a.termEnd}` : ''}
                    </span>
                  </span>
                  <span
                    className={`badge ${
                      a.status === 'confirmed' ? 'ok' : a.status === 'revoked' ? 'danger' : 'warn'
                    }`}
                  >
                    {a.status}
                  </span>
                </button>
              ))}
            </div>
          )}

          {caps.appoint && (
            <button className="fab" onClick={() => setOpenAppt(null)} aria-label="New appointment">
              <Icon name="plus" size={22} />
            </button>
          )}
        </>
      )}

      {sub === 'alerts' && (
        <>
          <div className="chip-row" style={{ justifyContent: 'space-between' }}>
            <span className="hint-text" style={{ margin: 0 }}>
              {notes?.filter((n) => !n.read).length ?? 0} unread
            </span>
            <button className="btn btn-ghost btn-sm" onClick={markAll}>
              <Icon name="check" size={15} /> Mark all read
            </button>
          </div>

          {notes === null ? (
            <div className="skeleton" style={{ height: 64, marginTop: 10 }} />
          ) : notes.length === 0 ? (
            <div className="card" style={{ marginTop: 10 }}>
              <EmptyState icon="bell" title="No notifications" hint="Alerts land here when events, press or mandates move." />
            </div>
          ) : (
            <div className="rows" style={{ marginTop: 10 }}>
              {notes.map((n) => (
                <button key={n.id} className={`row notif ${n.read ? '' : 'unread'}`} onClick={() => markRead(n)}>
                  <span className="row-ico">
                    <Icon name={NOTE_ICON[n.kind] ?? 'bell'} />
                  </span>
                  <span className="row-main">
                    <span className="row-title">{n.title}</span>
                    {n.body && <span className="row-sub">{n.body}</span>}
                    <span className="row-sub tiny">
                      {new Date(n.createdAt).toLocaleString(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                      {n.regionCode ? ` · ${n.regionCode}` : ''}
                      {n.broadcast ? ' · broadcast' : ''}
                    </span>
                  </span>
                  {!n.read && <span className="dot warn" />}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {sub === 'cases' && (
        <>
          <div className="section-label" style={{marginTop:12}}>Service requests</div>
          {cases === null ? (
            <div className="skeleton" style={{ height: 76 }} />
          ) : cases.length === 0 ? (
            <div className="card"><EmptyState icon="alert" title="No cases yet" hint={caps.caseLog ? 'Log a service request to start tracking community issues.' : 'Cases logged in this ward appear here.'} /></div>
          ) : (
            <div className="rows">
              {cases.map((c) => {
                const fuCls = followUpBadgeClass(c.followUpState);
                return (
                  <button key={c.id} className="row" style={{cursor:'pointer', width:'100%'}} onClick={() => setOpenCase(c)}>
                    <span className="row-ico"><Icon name="alert" /></span>
                    <span className="row-main">
                      <span className="row-title">{c.title}</span>
                      <span className="row-sub">{c.refNo} · {c.category} · {c.severity}</span>
                      <span className="row-sub tiny">{c.wardCode ?? ''} · SLA: {c.slaDueAt ? new Date(c.slaDueAt).toLocaleDateString() : '—'}</span>
                    </span>
                    <span style={{display:'flex', flexDirection:'column', gap:4, alignItems:'flex-end'}}>
                      <span className={srStatusBadgeClass(c.status)}>{srStatusLabel(c.status)}</span>
                      {fuCls && <span className={fuCls}>{followUpLabel(c.followUpState)}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {caps.caseLog && (
            <button className="fab" onClick={() => setOpenCase(null)} aria-label="Log a case">
              <Icon name="plus" size={22} />
            </button>
          )}
        </>
      )}

      {sub === 'bulletins' && (
        <>
          <div className="section-label" style={{marginTop:12}}>Ward bulletins</div>
          {bulletins === null ? (
            <div className="skeleton" style={{ height: 76 }} />
          ) : bulletins.length === 0 ? (
            <div className="card"><EmptyState icon="megaphone" title="No bulletins" hint="Publish ward news, completed work, and vacancies." /></div>
          ) : (
            <div className="rows">
              {bulletins.map((b) => (
                <div key={b.id} className="row" style={{cursor:'default'}}>
                  <span className="row-ico"><Icon name={b.kind === 'completed_work' ? 'check' : b.kind === 'vacancy' ? 'clipboard' : 'megaphone'} /></span>
                  <span className="row-main">
                    <span className="row-title">{b.title}</span>
                    <span className="row-sub">{b.kind.replace(/_/g,' ')} · {b.wardCode}</span>
                    <span className="row-sub tiny">{new Date(b.publishedAt).toLocaleDateString()}</span>
                  </span>
                  <span className="badge">{b.status}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {sub === 'participations' && (
        <>
          <div className="section-label" style={{marginTop:12}}>Public participation</div>
          {participations === null ? (
            <div className="skeleton" style={{ height: 76 }} />
          ) : participations.length === 0 ? (
            <div className="card"><EmptyState icon="users" title="No consultations" hint="Open public participation processes appear here." /></div>
          ) : (
            <div className="rows">
              {participations.map((p) => (
                <div key={p.id} className="row" style={{cursor:'default'}}>
                  <span className="row-ico"><Icon name="users" /></span>
                  <span className="row-main">
                    <span className="row-title">{p.title}</span>
                    <span className="row-sub">{p.scope} · {p.wardCode ?? 'All wards'}</span>
                    <span className="row-sub tiny">Opens {new Date(p.opensAt).toLocaleDateString()} · Closes {new Date(p.closesAt).toLocaleDateString()}</span>
                  </span>
                  <span className={`badge ${p.status === 'open' ? 'ok' : ''}`}>{p.status}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {sub === 'patrols' && (
        <>
          <div className="section-label" style={{marginTop:12}}>Patrols</div>
          {patrolList === null ? (
            <div className="skeleton" style={{ height: 76 }} />
          ) : patrolList.length === 0 ? (
            <div className="card"><EmptyState icon="pin" title="No patrols" hint={caps.patrolWrite ? 'Start a GPS-tracked ward patrol and file its overview report.' : 'Ward patrols appear here.'} /></div>
          ) : (
            <div className="rows">
              {patrolList.map((p) => (
                <button key={p.id} className="row" style={{cursor:'pointer', width:'100%'}} onClick={() => setOpenPatrol(p)}>
                  <span className="row-ico"><Icon name="pin" /></span>
                  <span className="row-main">
                    <span className="row-title">{p.purpose ?? 'Ward patrol'}</span>
                    <span className="row-sub">{p.mode} · {p.wardCode ?? '—'}</span>
                    <span className="row-sub tiny">
                      {p.startedAt ? new Date(p.startedAt).toLocaleString() : 'Not started'}
                      {p.distanceM ? ` · ${p.distanceM >= 1000 ? `${(p.distanceM / 1000).toFixed(2)}km` : `${p.distanceM}m`}` : ''}
                      {p.mediaCount ? ` · ${p.mediaCount} attached` : ''}
                    </span>
                  </span>
                  <span className={`badge ${p.status === 'completed' ? 'ok' : p.status === 'active' ? 'warn' : ''}`}>{p.status}</span>
                </button>
              ))}
            </div>
          )}

          {caps.patrolWrite && (
            <button className="fab" onClick={() => setOpenPatrol(null)} aria-label="Start patrol">
              <Icon name="plus" size={22} />
            </button>
          )}
        </>
      )}

      {sub === 'projects' && (
        <>
          <div className="section-label" style={{marginTop:12}}>Projects</div>
          {projectList === null ? (
            <div className="skeleton" style={{ height: 76 }} />
          ) : projectList.length === 0 ? (
            <div className="card"><EmptyState icon="clipboard" title="No projects" hint="Create ward projects to track delivery programmes." /></div>
          ) : (
            <div className="rows">
              {projectList.map((p) => (
                <div key={p.id} className="row" style={{cursor:'default'}}>
                  <span className="row-ico"><Icon name="clipboard" /></span>
                  <span className="row-main">
                    <span className="row-title">{p.title}</span>
                    <span className="row-sub">{p.stage.replace(/_/g,' ')} · {p.wardCode ?? '—'}</span>
                    <span className="row-sub tiny">{p.budget ? `Budget: R${Number(p.budget).toLocaleString()}` : 'No budget set'}</span>
                  </span>
                  <span className="badge">{p.stage.replace(/_/g,' ')}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {sub === 'report' && <ReportToCouncillor />}

      {sub === 'jobs' && <JobsSection />}

      {sub === 'overview' && (
        <>
          <div className="section-label" style={{marginTop:12}}>Metro overview</div>
          <div className="card">
            <div className="card-title">Cross-ward heat map</div>
            <p className="hint-text">Service request density across all wards. Color-coded by issue category.</p>
            {/* Deep-linkable by anyone (tab:engage#overview), so the entry point
                into the Map tab carries the same `memberMap` gate the tab does
                (`geo:read` for staff, `geo:read_own_ward` for a member's
                restricted own-ward map). */}
            {caps.memberMap && (
              <button className="btn btn-ghost btn-block btn-sm" onClick={() => open('map')}>
                <Icon name="map" size={16} /> Open movement map
              </button>
            )}
          </div>
          <div className="stat-grid" style={{marginTop:12}}>
            <div className="stat accent"><div className="num">{cases?.length ?? '—'}</div><div className="lbl">Open cases</div></div>
            <div className="stat"><div className="num">{bulletins?.length ?? '—'}</div><div className="lbl">Bulletins</div></div>
            <div className="stat"><div className="num">{patrolList?.length ?? '—'}</div><div className="lbl">Patrols</div></div>
            <div className="stat"><div className="num">{projectList?.length ?? '—'}</div><div className="lbl">Projects</div></div>
          </div>
        </>
      )}

      {openEvent !== undefined && (
        <EventSheet
          event={openEvent}
          onClose={() => setOpenEvent(undefined)}
          onSaved={() => loadEvents()}
        />
      )}
      {openAppt !== undefined && (
        <AppointmentSheet
          appointment={openAppt}
          onClose={() => setOpenAppt(undefined)}
          onSaved={() => loadAppointments()}
        />
      )}
      {openCase !== undefined && (
        <CaseSheet
          sr={openCase}
          onClose={() => setOpenCase(undefined)}
          onSaved={() => loadCases()}
        />
      )}
      {openPatrol !== undefined && (
        <PatrolSheet
          patrol={openPatrol}
          onClose={() => setOpenPatrol(undefined)}
          onSaved={() => loadPatrols()}
        />
      )}
    </>
  );
}
