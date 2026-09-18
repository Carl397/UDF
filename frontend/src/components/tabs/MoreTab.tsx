'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useShell } from '../AppShell';
import { useAuth } from '../../lib/auth';
import { moduleOn, ModuleKey } from '../../lib/modules';
import { Perm, can } from '../../lib/caps';
import { Icon } from '../ui';
import SettingsTab from './SettingsTab';
import Newsroom from './Newsroom';
import ManifestoView from './ManifestoView';
import RegisterForm from './RegisterForm';
import SupporterSection from './SupporterSection';
import InviteGrow from './InviteGrow';
import type { PublicMeta } from '../../types';

/**
 * The "More" hub: newsroom, mission & vision guide, membership registration,
 * party offices, and the settings screen. Sub-views render inline with a back
 * row so the header title stays meaningful.
 */
export default function MoreTab() {
  const { section, open } = useShell();

  if (section === 'posts') return <Newsroom />;
  if (section === 'manifesto') return <ManifestoView />;
  if (section === 'register') return <RegisterForm />;
  if (section === 'invite') {
    return (
      <>
        <BackRow label="More" onClick={() => open('more', '')} />
        <InviteGrow />
      </>
    );
  }
  if (section === 'supporter') {
    return (
      <>
        <BackRow label="More" onClick={() => open('more', '')} />
        <SupporterSection />
      </>
    );
  }
  if (section === 'settings') {
    return (
      <>
        <BackRow label="More" onClick={() => open('more', '')} />
        <SettingsTab />
      </>
    );
  }
  return <Hub />;
}

export function BackRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="row back-row" onClick={onClick}>
      <span className="back-ico"><Icon name="chev" size={16} /></span>
      <span className="row-main">
        <span className="row-title">Back to {label}</span>
      </span>
    </button>
  );
}

function Hub() {
  const { open, caps, modules } = useShell();
  const { permissions, role } = useAuth();
  const recruitRead = can(permissions, Perm.RECRUITMENT_READ);
  const [meta, setMeta] = useState<PublicMeta | null>(null);
  const [counts, setCounts] = useState<{ posts: number; notes: number; events: number } | null>(null);

  useEffect(() => {
    api.publicMeta().then(setMeta).catch(() => setMeta(null));
    Promise.all([
      api.listPosts({ limit: 1 }).then((r) => r.total),
      api.listPosts({ kind: 'community_note', limit: 1 }).then((r) => r.total),
      api.listEvents({ upcoming: true, limit: 1 }).then((r) => r.total),
    ])
      .then(([posts, notes, events]) => setCounts({ posts, notes, events }))
      .catch(() => setCounts({ posts: 0, notes: 0, events: 0 }));
  }, []);

  const party = meta?.party;

  return (
    <>
      <div className="card hero-card compact">
        <span className="eyebrow">{party?.fullName ?? 'United Democratic Front'}</span>
        {/* Tagline and slogan read as ONE line, joined the same way the starter-pack
            email and the public verify card already join them. Split across a
            heading and a paragraph they read as two unrelated fragments, and the
            movement's line is the whole phrase. */}
        <h2>
          {party?.tagline ?? 'One flag · One movement'} · {party?.slogan ?? 'Service before self'}
        </h2>
      </div>

      <div className="section-label">Newsroom</div>
      <div className="rows">
        <button className="row" onClick={() => open('more', 'posts')}>
          <span className="row-ico"><Icon name="megaphone" /></span>
          <span className="row-main">
            <span className="row-title">News, press & highlights</span>
            <span className="row-sub">
              {counts ? `${counts.posts} published items` : 'Loading…'} · statements and press releases
            </span>
          </span>
          <Icon name="chev" size={16} />
        </button>

        <button className="row" onClick={() => open('more', 'posts')}>
          <span className="row-ico"><Icon name="alert" /></span>
          <span className="row-main">
            <span className="row-title">Community notes & service delivery</span>
            <span className="row-sub">
              {counts ? `${counts.notes} notes logged` : 'Loading…'} · water, power, roads, health
            </span>
          </span>
          <span className={`badge ${caps.moderate ? 'warn' : ''}`}>{caps.moderate ? 'moderate' : 'view'}</span>
        </button>

        {caps.postWrite && (
          <button className="row" onClick={() => open('more', 'posts')}>
            <span className="row-ico"><Icon name="edit" /></span>
            <span className="row-main">
              <span className="row-title">Issue a press release</span>
              <span className="row-sub">Draft, publish and — if needed — take down with a reason</span>
            </span>
            <Icon name="chev" size={16} />
          </button>
        )}
      </div>

      <div className="section-label">The party</div>
      <div className="rows">
        <button className="row" onClick={() => open('more', 'manifesto')}>
          <span className="row-ico"><Icon name="flag" /></span>
          <span className="row-main">
            <span className="row-title">Mission, vision & what we stand for</span>
            <span className="row-sub">Values, five policy pillars and the member guide</span>
          </span>
          <Icon name="chev" size={16} />
        </button>

        <button className="row" onClick={() => open('more', 'manifesto')}>
          <span className="row-ico"><Icon name="idcard" /></span>
          <span className="row-main">
            <span className="row-title">Roles & party structures</span>
            <span className="row-sub">
              {meta ? `${meta.positions.length} offices from branch to national` : 'Loading…'}
            </span>
          </span>
          <Icon name="chev" size={16} />
        </button>

        <button className="row" onClick={() => open('engage', 'appointments')}>
          <span className="row-ico"><Icon name="shield" /></span>
          <span className="row-main">
            <span className="row-title">Appointments & mandates</span>
            <span className="row-sub">Ward chairs, candidates, mobilizers, observers</span>
          </span>
          <Icon name="chev" size={16} />
        </button>

        <button className="row" onClick={() => open('engage', 'events')}>
          <span className="row-ico"><Icon name="calendar" /></span>
          <span className="row-main">
            <span className="row-title">Events calendar</span>
            <span className="row-sub">{counts ? `${counts.events} upcoming` : 'Loading…'}</span>
          </span>
          <Icon name="chev" size={16} />
        </button>

        <button className="row" onClick={() => open('more', 'supporter')}>
          <span className="row-ico"><Icon name="heart" /></span>
          <span className="row-main">
            <span className="row-title">Supporter card</span>
            <span className="row-sub">Add your photo &amp; share that you back the UDF</span>
          </span>
          <Icon name="chev" size={16} />
        </button>
      </div>

      <div className="section-label">Membership</div>
      <div className="rows">
        {recruitRead && (
          <button className="row" onClick={() => open('more', 'invite')}>
            <span className="row-ico"><Icon name="users" /></span>
            <span className="row-main">
              <span className="row-title">Invite &amp; grow</span>
              <span className="row-sub">Your reference number, join link &amp; recruitment tree</span>
            </span>
            <Icon name="chev" size={16} />
          </button>
        )}
        <button className="row" onClick={() => open('more', 'register')}>
          <span className="row-ico"><Icon name="clipboard" /></span>
          <span className="row-main">
            <span className="row-title">Member registration form</span>
            <span className="row-sub">Capture an application, issue the confirmation link</span>
          </span>
          <Icon name="chev" size={16} />
        </button>

        {/*
          Opens the Members tab, which only exists for a session holding
          `member:read`. Left ungated this row was a dead click for members and
          analysts: it set the tab, the shell bounced them back to Home, and the
          label promised a party ID card they could never reach. It is ALSO gated
          on the `id_cards` module: this row exists to reach party ID cards, so
          when an administrator switches that module off the shortcut hides even
          though the member directory itself (the `members` module) stays open.
        */}
        {role && role !== 'ward_councillor' && caps.memberRead && moduleOn(modules, ModuleKey.ID_CARDS) && (
          <button className="row" onClick={() => open('members')}>
            <span className="row-ico"><Icon name="qr" /></span>
            <span className="row-main">
              <span className="row-title">Party ID cards &amp; QR</span>
              <span className="row-sub">Open a member → “Party ID card” to print or share</span>
            </span>
            <Icon name="chev" size={16} />
          </button>
        )}

        {role && role !== 'ward_councillor' && (
          <a className="row" href="/register" style={{ textDecoration: 'none', color: 'inherit' }}>
            <span className="row-ico"><Icon name="link" /></span>
            <span className="row-main">
              <span className="row-title">Public join page</span>
              <span className="row-sub">The page a QR code or poster link opens</span>
            </span>
            <Icon name="chev" size={16} />
          </a>
        )}

        <button className="row" onClick={() => open('more', 'settings')}>
          <span className="row-ico"><Icon name="gear" /></span>
          <span className="row-main">
            <span className="row-title">Settings</span>
            <span className="row-sub">Account, notifications, map defaults, security</span>
          </span>
          <Icon name="chev" size={16} />
        </button>
      </div>

      {party && (
        <>
          <div className="section-label">Contact the party</div>
          <div className="card">
            <div className="kv"><span className="k">Email</span><span className="v">{party.contacts.email}</span></div>
            <div className="kv"><span className="k">Press desk</span><span className="v">{party.contacts.press}</span></div>
            <div className="kv"><span className="k">Hours</span><span className="v">{party.officeHours}</span></div>
            <div className="kv"><span className="k">Address</span><span className="v">{party.contacts.address}</span></div>
          </div>
        </>
      )}

      <div style={{ height: 12 }} />
    </>
  );
}
