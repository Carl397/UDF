'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { PublicMeta, WardChangeStatus } from '../../types';

/** Registered membership ward, deliberately separate from map navigation/GPS. */
export default function WardSettings() {
  const id = useId();
  const [status, setStatus] = useState<WardChangeStatus | null>(null);
  const [regions, setRegions] = useState<PublicMeta['regions']>([]);
  const [selected, setSelected] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [retry, setRetry] = useState(0);
  const saving = useRef(false);
  const alive = useRef(false);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);

  useEffect(() => {
    alive.current = true;
    let live = true;
    setStatus(null);
    setError('');
    Promise.all([api.ownWardChanges(), api.publicMeta()]).then(([value, meta]) => {
      if (!live) return;
      setStatus(value);
      setRegions(meta.regions);
      setSelected('');
    }).catch((e) => {
      if (live) setError(e?.message ?? 'Unable to load your registered ward. Please try again.');
    });
    return () => { live = false; alive.current = false; };
  }, [retry]);

  useEffect(() => {
    if (confirming) confirmation.current?.focus();
  }, [confirming]);

  const wards = regions.filter((r) => r.level === 'ward' && r.parentCode)
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const target = wards.find((r) => r.code === selected);
  const remaining = status?.changesRemaining ?? 0;
  const unavailable = !status || remaining === 0 || busy;

  async function save() {
    if (saving.current || !status || !target || unavailable || selected === status.wardCode) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api.changeOwnWard(selected, status.wardCode);
      if (!alive.current) return;
      setStatus(result);
      setSelected('');
      setConfirming(false);
      setMessage(result.changed ? 'Your registered ward has been updated.' : 'Your ward is already up to date.');
    } catch (e: unknown) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : 'Unable to change your ward. Please try again.');
      setConfirming(false);
      setSelected('');
      // A lost response may hide a successful save. Fetch the authoritative
      // count before allowing another attempt; never decrement optimistically.
      setStatus(null);
      try {
        const current = await api.ownWardChanges();
        if (alive.current) setStatus(current);
      } catch { /* Retry is offered; no stale allowance is shown. */ }
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <section className="card ward-settings" aria-labelledby={`${id}-title`} aria-busy={busy}>
      <h3 id={`${id}-title`}>Registered ward</h3>
      {status && <p>{status.wardName ?? status.wardCode ?? 'No ward selected'}{status.wardName && ` · ${status.wardCode}`}</p>}
      <p id={`${id}-limit`} role="status">
        {status ? `${remaining} of ${status.maxChanges} ward changes remaining` : error ? 'Remaining changes unavailable' : 'Checking remaining changes…'}
      </p>
      <p className="field-hint">You can change your registered ward a maximum of 3 times in total. Browsing the map does not use a change.</p>
      {status && !status.wardCode && <p className="field-hint">Choosing your first ward does not use a change.</p>}
      {status && remaining === 0 && <p className="banner">Limit reached. You have used all 3 ward changes.</p>}
      {message && <p role="status">{message}</p>}
      {error && <p className="banner err" role="alert">{error}</p>}
      {!status && error && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setRetry((n) => n + 1)}>Retry</button>}
      {status && remaining > 0 && (
        <form onSubmit={(e) => { e.preventDefault(); if (target) setConfirming(true); }}>
          <fieldset disabled={unavailable || confirming}>
            <div className="field">
              <label htmlFor={`${id}-ward`}>New registered ward</label>
              <select id={`${id}-ward`} className="input" value={selected} required
                aria-describedby={`${id}-limit`} onChange={(e) => { setSelected(e.target.value); setMessage(''); }}>
                <option value="">Choose a ward</option>
                {wards.filter((w) => w.code !== status.wardCode).map((w) => (
                  <option key={w.code} value={w.code}>{w.name} · {w.code} · {regions.find((r) => r.code === w.parentCode)?.name ?? w.parentCode}</option>
                ))}
              </select>
            </div>
            <button ref={reviewButton} className="btn btn-primary" type="submit" disabled={!target}>Review ward change</button>
          </fieldset>
          {confirming && target && (
            <div className="ward-change-confirm" ref={confirmation} tabIndex={-1}>
              <p>Change your registered ward to <strong>{target.name} · {target.code}</strong>?</p>
              <p>{status.wardCode ? `This uses 1 change. You will have ${remaining - 1} remaining. Changing back also uses a change.` : 'This sets your first ward and keeps all remaining changes.'}</p>
              <div className="ward-change-actions">
                <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Confirm ward change'}</button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => {
                  setConfirming(false);
                  requestAnimationFrame(() => reviewButton.current?.focus());
                }}>Cancel</button>
              </div>
            </div>
          )}
        </form>
      )}
    </section>
  );
}
