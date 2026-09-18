'use client';

import PublicFrame, { PublicFoot } from '../PublicFrame';
import TermsView, { TermsPlaceholder, useTerms } from './TermsView';

/**
 * Public Terms & Conditions page (`/terms`).
 *
 * Opened from the registration checkbox and the in-app acceptance gate by
 * people who may not be signed in, so it uses the standalone public chrome
 * (no app shell, no auth guard) and renders the live, version-stamped document.
 */
export default function TermsPage() {
  const { terms, error, reload } = useTerms();

  return (
    <PublicFrame
      title={terms?.title ?? 'Terms & Conditions'}
      subtitle="How membership, acceptable use and your privacy work on the UDF platform."
      foot={<PublicFoot />}
    >
      <div className="pub-card">
        {terms ? <TermsView terms={terms} /> : <TermsPlaceholder error={error} onRetry={reload} />}
      </div>
    </PublicFrame>
  );
}
