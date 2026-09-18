'use client';

import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { Icon } from './ui';
import Logo from './Logo';

/**
 * Forced password-change gate.
 *
 * Rendered instead of the app shell when the signed-in account still carries
 * `must_change_password` — i.e. it was provisioned with a shared/bootstrap
 * password (the seeded super-admin) that must be rotated to a private one
 * before the app is usable. Submitting calls `POST /auth/change-password`,
 * which clears the flag, revokes every other session and hands back a fresh
 * token pair; the gate then unmounts reactively. Mirrors the T&C gate, and is
 * deliberately placed ahead of it (a compromised bootstrap password is the more
 * urgent thing to fix).
 */
export default function ChangePasswordGate() {
  const { changePassword, logout, role, mustChangePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // An OTP-onboarded member (role 'member' still behind this first-login gate)
  // signed in with a one-time code and never had a password, so there is no
  // "current password" to re-type — hide the field and send an empty one. The
  // server waives the re-check for exactly this case (auth/service.ts). Staff and
  // the seeded super-admin keep the field: they rotate a password they know.
  const otpMode = mustChangePassword && role === 'member';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (next.length < 10) return setErr('New password must be at least 10 characters.');
    if (!otpMode && next === current) return setErr('New password must differ from the current one.');
    if (next !== confirm) return setErr('The two new passwords do not match.');
    setBusy(true);
    try {
      await changePassword(otpMode ? '' : current, next);
      // On success `mustChangePassword` flips false and this gate unmounts.
    } catch (e: any) {
      setErr(e?.message ?? 'Could not change password — please try again');
      setBusy(false);
    }
  }

  return (
    <div className="terms-gate">
      <header className="pub-head">
        <span className="pub-flag">
          <Logo size={34} wordmark={false} />
          <span>Party</span>
        </span>
        <h1>{otpMode ? 'Set your password' : 'Choose a new password'}</h1>
        <p>
          {otpMode
            ? 'Welcome to the UDF! You signed in with the code we emailed you. Now choose a private password to secure your account and continue into the app.'
            : 'This account was set up with a temporary password. For your security, choose a private one to continue into the UDF app.'}
        </p>
      </header>
      <div className="pub-stripe" />

      <div className="terms-gate-scroll">
        <form id="pw-change-form" className="pub-card pw-form" onSubmit={onSubmit}>
          {!otpMode && (
            <div className="pw-field">
              <label htmlFor="cp-current">Current password</label>
              <input
                id="cp-current"
                type="password"
                value={current}
                autoComplete="current-password"
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </div>
          )}
          <div className="pw-field">
            <label htmlFor="cp-next">New password</label>
            <input
              id="cp-next"
              type="password"
              value={next}
              autoComplete="new-password"
              minLength={10}
              onChange={(e) => setNext(e.target.value)}
              required
            />
            <span className="pw-hint">At least 10 characters, and different from the current one.</span>
          </div>
          <div className="pw-field">
            <label htmlFor="cp-confirm">Confirm new password</label>
            <input
              id="cp-confirm"
              type="password"
              value={confirm}
              autoComplete="new-password"
              minLength={10}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
        </form>
      </div>

      <footer className="terms-gate-foot">
        {err && (
          <div className="banner err">
            <Icon name="alert" size={17} />
            <span>{err}</span>
          </div>
        )}
        <button
          className="btn btn-primary btn-block"
          type="submit"
          form="pw-change-form"
          disabled={busy}
        >
          <Icon name="lock" size={17} />
          {busy ? 'Updating…' : 'Set new password'}
        </button>
        <button
          type="button"
          className="terms-gate-alt"
          style={{ background: 'none', border: 'none', cursor: 'pointer', font: 'inherit' }}
          onClick={() => void logout()}
        >
          Sign out instead
        </button>
      </footer>
    </div>
  );
}
