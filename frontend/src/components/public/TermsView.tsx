'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Terms } from '../../types';
import { Icon } from '../ui';

/**
 * Fetch the live Terms & Conditions document from the public API.
 *
 * The terms are version-stamped server-side (`TERMS_VERSION`), so both the
 * public `/terms` page and the in-app acceptance gate render exactly what the
 * backend will record against the member's account.
 */
export function useTerms(): { terms: Terms | null; error: boolean; reload: () => void } {
  const [terms, setTerms] = useState<Terms | null>(null);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(false);
    api
      .terms()
      .then((t) => {
        if (alive) setTerms(t);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [nonce]);

  return { terms, error, reload: () => setNonce((n) => n + 1) };
}

/**
 * Pure renderer for a `Terms` document — no data fetching, no chrome. Wrapping
 * (public frame vs. in-app gate) is left to the caller.
 */
export default function TermsView({ terms }: { terms: Terms }) {
  return (
    <div className="terms-doc">
      <div className="terms-meta">
        <span className="chip on">Version {terms.version}</span>
        <span className="terms-updated">Updated {terms.updatedAt}</span>
      </div>

      <p className="terms-intro">{terms.intro}</p>

      {terms.sections.map((s) => (
        <section className="terms-section" key={s.heading}>
          <h4>
            <Icon name="doc" size={15} />
            {s.heading}
          </h4>
          <p>{s.body}</p>
        </section>
      ))}
    </div>
  );
}

/** Loading / error placeholders shared by the terms page and the gate. */
export function TermsPlaceholder({ error, onRetry }: { error: boolean; onRetry?: () => void }) {
  if (error) {
    return (
      <div className="banner err" style={{ marginTop: 10 }}>
        <Icon name="alert" size={17} />
        <span>
          Could not load the Terms &amp; Conditions.{' '}
          {onRetry && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
              Try again
            </button>
          )}
        </span>
      </div>
    );
  }
  return (
    <div className="terms-skel" role="status" aria-live="polite">
      Loading the Terms &amp; Conditions…
    </div>
  );
}
