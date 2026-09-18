'use client';

import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { Icon } from './ui';
import Logo from './Logo';
import TermsView, { TermsPlaceholder, useTerms } from './public/TermsView';

/**
 * In-app Terms & Conditions gate.
 *
 * Rendered instead of the app shell when a signed-in user has not accepted the
 * current terms version (fresh login that reports `tcAccepted: false`, or a
 * terms bump since their last visit). Accepting calls `POST /auth/terms/accept`,
 * which stamps `users.tc_version` + `tc_accepted_at` and clears the gate.
 */
export default function TermsGate() {
  const { acceptTerms } = useAuth();
  const { terms, error, reload } = useTerms();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onAccept() {
    setErr(null);
    setBusy(true);
    try {
      await acceptTerms();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not record your acceptance — please try again');
    } finally {
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
        <h1>Terms &amp; Conditions</h1>
        <p>Please read and accept the current terms to continue into the UDF app.</p>
      </header>
      <div className="pub-stripe" />

      <div className="terms-gate-scroll">
        <div className="pub-card">
          {terms ? <TermsView terms={terms} /> : <TermsPlaceholder error={error} onRetry={reload} />}
        </div>
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
          onClick={onAccept}
          disabled={busy || !terms}
        >
          <Icon name="check" size={17} />
          {busy ? 'Recording…' : terms?.acceptance ?? 'I accept the Terms & Conditions'}
        </button>
        <a className="terms-gate-alt" href="/terms" target="_blank" rel="noreferrer">
          Open the terms in a new tab
        </a>
      </footer>
    </div>
  );
}
