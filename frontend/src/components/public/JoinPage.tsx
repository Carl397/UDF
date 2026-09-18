'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '../../lib/api';
import { useMounted } from '../../lib/publicLink';
import RegisterPanel from '../RegisterPanel';
import PublicFrame, { PublicFoot } from '../PublicFrame';
import { Icon } from '../ui';
import type { PublicMeta } from '../../types';

/**
 * Public join page — the URL a party QR card, poster or referral link opens.
 * `?ref=<party code>` attributes the new member to whoever recruited them.
 */
export default function JoinPage() {
  const params = useSearchParams();
  const ref = params.get('ref');
  const mounted = useMounted();
  const [meta, setMeta] = useState<PublicMeta | null>(null);

  useEffect(() => {
    api.publicMeta().then(setMeta).catch(() => setMeta(null));
  }, []);

  const party = meta?.party;
  // The page is statically prerendered, so the referral code is invisible to the
  // server. Hold the referral-dependent parts back until after mount, otherwise
  // the invitation heading and banner mismatch the prerendered HTML.
  const invitedBy = mounted ? ref : null;

  return (
    <PublicFrame
      title={invitedBy ? 'You are invited to join' : 'Join the UDF'}
      subtitle={
        party?.tagline ??
        'Register once, get a membership number and a QR party card you can verify anywhere.'
      }
      foot={<PublicFoot />}
    >
      {invitedBy && (
        <div className="banner">
          <Icon name="flag" size={17} />
          <span>
            Referred by party code <strong>{invitedBy.toUpperCase()}</strong> — they will be credited
            when your membership is confirmed.
          </span>
        </div>
      )}

      <div className="pub-card">
        <RegisterPanel referralCode={invitedBy} />
      </div>
    </PublicFrame>
  );
}
