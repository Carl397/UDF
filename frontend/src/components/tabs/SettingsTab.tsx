'use client';

import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { loadPrefs, savePrefs, type Prefs } from '../../lib/prefs';
import { useShell } from '../AppShell';
import { Icon, Toggle, useToast } from '../ui';

const ROLE_LABEL: Record<string, string> = {
  national_admin: 'National Admin',
  regional_organizer: 'Regional Organizer',
  local_coordinator: 'Local Coordinator',
  analyst: 'Analyst',
  member: 'Member',
};

const APP_VERSION = '1.0.0';

export default function SettingsTab() {
  const { email, role, regionCodes, logout } = useAuth();
  const { unread, open } = useShell();
  const toast = useToast();
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());

  function update(patch: Partial<Prefs>) {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(patch);
      return next;
    });
  }

  return (
    <>
      {/* Profile */}
      <div className="card profile-card">
        <span className="avatar-btn" style={{ width: 52, height: 52, fontSize: 19 }}>
          {(email ?? 'U')[0]!.toUpperCase()}
        </span>
        <div className="pc-main">
          <div className="pc-email">{email}</div>
          <div className="pc-sub">
            {ROLE_LABEL[role ?? ''] ?? 'Member'} ·{' '}
            {regionCodes.length > 0 ? regionCodes.join(', ') : 'National scope'}
          </div>
        </div>
        <div className="pc-badge">
          <span className="badge tier">{role ?? '—'}</span>
        </div>
      </div>

      {/* Notifications */}
      <div className="section-label">Notifications</div>
      <div className="rows centred">
        <ToggleRow label="Push notifications" sub="Alerts on this device" on={prefs.pushNotifications} onChange={(v) => update({ pushNotifications: v })} />
        <ToggleRow label="Rally & event alerts" sub="When an event is posted near you" on={prefs.rallyAlerts} onChange={(v) => update({ rallyAlerts: v })} />
        <ToggleRow label="Weekly digest" sub="Movement summary every Monday" on={prefs.weeklyDigest} onChange={(v) => update({ weeklyDigest: v })} />
        <ToggleRow
          icon="alert"
          label="Community notes & service delivery"
          sub="When a ward reports a service failure"
          on={prefs.communityNotes}
          onChange={(v) => update({ communityNotes: v })}
        />
        <ToggleRow
          icon="shield"
          label="Mandate & appointment alerts"
          sub="When you are appointed or a mandate is accepted"
          on={prefs.mandateAlerts}
          onChange={(v) => update({ mandateAlerts: v })}
        />
        <button className="row" onClick={() => open('engage', 'alerts')}>
          <span className="row-ico"><Icon name="bell" /></span>
          <span className="row-main">
            <span className="row-title">Notification centre</span>
            <span className="row-sub">{unread > 0 ? `${unread} unread alerts` : 'All caught up'}</span>
          </span>
          {unread > 0 && <span className="badge warn">{unread}</span>}
          <Icon name="chev" size={16} />
        </button>
      </div>

      {/* About */}
      <div className="section-label">About</div>
      <div className="rows centred">
        <div className="row">
          <span className="row-ico"><Icon name="info" /></span>
          <span className="row-main">
            <span className="row-title">UDF Party</span>
            <span className="row-sub">Version {APP_VERSION} · build mobile-web</span>
          </span>
        </div>
      </div>

      {/* Sign out */}
      <div style={{ marginTop: 18 }}>
        <button
          className="btn btn-danger btn-block"
          onClick={async () => {
            await logout();
            toast('Signed out', 'ok');
          }}
        >
          <Icon name="logout" size={17} /> Sign out
        </button>
      </div>

      <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-3)', margin: '16px 0 4px' }}>
        One movement · Protected by design
      </p>
    </>
  );
}

function ToggleRow({
  label,
  sub,
  on,
  onChange,
  icon = 'bell',
}: {
  label: string;
  sub: string;
  on: boolean;
  onChange: (v: boolean) => void;
  icon?: string;
}) {
  return (
    <div className="row">
      <span className="row-ico"><Icon name={icon} /></span>
      <span className="row-main">
        <span className="row-title">{label}</span>
        <span className="row-sub">{sub}</span>
      </span>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}
