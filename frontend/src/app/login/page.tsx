'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import Logo from '../../components/Logo';
import './login.css';

/**
 * UDF member sign-in — a clean corporate card.
 * Also the Capacitor app's sign-in route (the native shell loads `/`).
 */
export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpMsg, setOtpMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      router.replace('/');
    } catch (err: any) {
      setError(err?.message ?? 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Re-send the onboarding sign-in code (FR-P). A newly-registered member's OTP
   * expires after 10 minutes, and a backfilled account is provisioned without an
   * email — either way this asks the server to send a fresh code + starter pack.
   * The endpoint is enumeration-safe, so the success copy never confirms whether
   * the address maps to a real account.
   */
  async function onResendCode() {
    const addr = email.trim();
    if (!addr) {
      setOtpMsg({ kind: 'err', text: 'Enter your email above, then request a code.' });
      return;
    }
    setOtpBusy(true);
    setOtpMsg(null);
    try {
      const res = await api.resendOtp(addr);
      setOtpMsg({ kind: 'ok', text: res.message });
    } catch (err: any) {
      setOtpMsg({ kind: 'err', text: err?.message ?? 'Could not send a code — please try again shortly.' });
    } finally {
      setOtpBusy(false);
    }
  }

  return (
    <div className="udf-login">
      <form className="udf-login-card" onSubmit={onSubmit}>
        <Logo size={132} wordmark={false} className="udf-login-logo" />
        <h1 className="udf-login-title">Member sign in</h1>
        <p className="udf-login-sub">
          Access your dashboard to organise, map and reach your members.
        </p>

        <div className="udf-field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            autoComplete="username"
            inputMode="email"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="udf-field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <span className="udf-otp-hint">
            Just joined? Use the 6-digit code from your starter-pack email here —
            you&apos;ll choose a private password next.
          </span>
        </div>

        {error && <div className="udf-login-error">{error}</div>}

        <button className="udf-login-submit" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <button
          type="button"
          className="udf-login-resend"
          onClick={onResendCode}
          disabled={otpBusy}
        >
          {otpBusy ? 'Sending code…' : 'Email me a sign-in code'}
        </button>
        {otpMsg && <div className={`udf-otp-msg ${otpMsg.kind}`}>{otpMsg.text}</div>}

        <div className="udf-login-alt">
          Not a member yet? <a href="/register">Become a member</a>
        </div>

      </form>
    </div>
  );
}
