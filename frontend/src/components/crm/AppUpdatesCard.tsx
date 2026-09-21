'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { can, Perm } from '../../lib/caps';
import type { PreparedReleases } from '../../lib/appUpdates';
import { CrmCard } from './ui';

export default function AppUpdatesCard() {
  const { role, permissions } = useAuth();
  const allowed = role === 'superadmin' && can(permissions, Perm.APP_RELEASE_MANAGE);
  const [data, setData] = useState<PreparedReleases | null>(null);
  const [selected, setSelected] = useState('');
  const [notes, setNotes] = useState('');
  const [confirm, setConfirm] = useState<'publish' | 'withdraw' | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const submitting = useRef(false);
  const alive = useRef(true);
  const preview = useRef<HTMLDivElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!allowed) return;
    let live = true;
    setBusy(true); setData(null); setConfirm(null);
    api.appReleases().then((result) => { if (live) setData(result); })
      .catch((e) => { if (live) setMessage(e?.message ?? 'Could not load prepared releases.'); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [allowed, reload]);
  useEffect(() => { if (confirm) preview.current?.focus(); }, [confirm]);
  if (!allowed) return null;
  const release = data?.prepared.find((r) => r.artifact.id === selected);
  const active = data?.history.find((n) => n.announcementId === data.activeAnnouncementId);
  const ready = release?.verified && release.artifact.versionCode > (data?.highestVersionCode ?? 0) && notes.trim().length > 0;
  async function submit() {
    if (submitting.current || !data || !confirm) return;
    submitting.current = true; setBusy(true); setMessage('');
    try {
      if (confirm === 'publish' && ready) await api.publishAppRelease(selected, notes.trim(), data.activeAnnouncementId);
      else if (confirm === 'withdraw' && data.activeAnnouncementId) await api.withdrawAppRelease(data.activeAnnouncementId);
      else return;
      if (alive.current) setMessage(confirm === 'publish' ? 'Update notice activated. Older update-enabled Android apps can discover it while open.' : 'Update notice withdrawn.');
    } catch (e) {
      if (alive.current) setMessage(e instanceof Error ? e.message : 'Request failed. Reload before retrying.');
    } finally {
      submitting.current = false;
      if (alive.current) { setConfirm(null); setReload((v) => v + 1); }
    }
  }
  return <CrmCard title="App updates">
    <p>Announce an operator-prepared, signed UDF Party APK. Notices are checked on launch, resume and every minute while the Android app is open and online. This is not closed-app push; downloads do not prove installation or delivery.</p>
    <p>Version 1.0.5 and earlier need one manual installation of the first update-enabled release. Compatible package/signing identity is required; do not uninstall or clear app data.</p>
    {message && <p role="status">{message}</p>}
    {data?.catalogError && <p role="alert">{data.catalogError}</p>}
    <p>Current notice: {active ? `${active.versionName} (build ${active.versionCode})` : data ? 'None' : 'Loading…'}</p>
    <div className="app-release-form">
      <label>Prepared release
        <select value={selected} disabled={busy || !!confirm} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Select a prepared release</option>
          {data?.prepared.map((r) => <option key={r.artifact.id} value={r.artifact.id} disabled={!r.verified || r.artifact.versionCode <= data.highestVersionCode}>
            {r.artifact.versionName} · build {r.artifact.versionCode} · {r.verified ? 'Verified' : 'Unavailable / not publicly verified'}
          </option>)}
        </select>
      </label>
      <label>Release notes (plain text)
        <textarea rows={4} maxLength={2000} value={notes} disabled={busy || !!confirm} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="ward-change-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !ready || !!confirm} onClick={() => setConfirm('publish')}>Preview update notice</button>
        <button type="button" className="btn btn-ghost" disabled={busy || !active || !!confirm} onClick={() => setConfirm('withdraw')}>Withdraw notice</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setReload((v) => v + 1)}>Reload releases</button>
      </div>
      {confirm && <div className="ward-change-confirm" ref={preview} tabIndex={-1} aria-label="Confirm update notice">
        {confirm === 'publish' ? <><h3>Send update notice?</h3><p>Version {release?.artifact.versionName} · build {release?.artifact.versionCode} · {((release?.artifact.bytes ?? 0) / 1_000_000).toFixed(1)} MB</p><p className="app-update-notes">{notes}</p><p>This replaces the current notice for eligible Android installations. Withdrawal does not undo a downloaded APK.</p></> : <p>Withdraw the current update notice? New checks will stop offering it.</p>}
        <div className="ward-change-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void submit(); }}>{busy ? 'Saving…' : confirm === 'publish' ? 'Send update notice' : 'Confirm withdrawal'}</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      </div>}
    </div>
    <h3>Publication history</h3>
    {data?.history.length === 0 && <p>No announcements yet.</p>}
    <ul>{data?.history.map((n) => <li key={n.announcementId}>{n.versionName} · build {n.versionCode} — {n.withdrawnAt ? 'Withdrawn / superseded' : 'Active'} · {new Date(n.publishedAt).toLocaleString()}</li>)}</ul>
  </CrmCard>;
}
