'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { usePublicToken, useMounted } from '../../lib/publicLink';
import PublicFrame, { PublicFoot } from '../PublicFrame';
import { Icon } from '../ui';
import QrCode from '../QrCode';
import type { ConfirmResult, PublicMeta } from '../../types';

type State =
  | { phase: 'loading' }
  | { phase: 'done'; result: ConfirmResult }
  | { phase: 'error'; message: string };

/** Shared rejection screen — used for a missing token and for a refused one. */
function Rejected({ message, deskEmail }: { message: string; deskEmail?: string | null }) {
  return (
    <PublicFrame title="Link not accepted" foot={<PublicFoot />}>
      <div className="pub-card">
        <div className="pub-status">
          <span className="ring err">
            <Icon name="alert" />
          </span>
          <h2>We could not confirm that link</h2>
          <p>{message}</p>
        </div>
        <div className="pub-actions">
          <a className="btn btn-primary" href="/register">
            <Icon name="clipboard" size={16} /> Start a new membership application
          </a>
          {deskEmail && (
            <a className="btn btn-ghost" href={`mailto:${deskEmail}`}>
              <Icon name="send" size={16} /> Contact the membership desk
            </a>
          )}
        </div>
      </div>
    </PublicFrame>
  );
}

/** Neutral loading screen — identical on the server and the first client render. */
function Pending() {
  return (
    <PublicFrame title="Confirming…" subtitle="Please keep this page open for a moment.">
      <div className="pub-card">
        <div className="skeleton" style={{ height: 90 }} />
        <div className="skeleton" style={{ height: 16, marginTop: 12 }} />
        <div className="skeleton" style={{ height: 16, marginTop: 8, width: '60%' }} />
      </div>
    </PublicFrame>
  );
}

/**
 * Public confirmation page — the target of both link types the party issues:
 *   • membership confirmation (`kind: 'register'`) activates a pending member;
 *   • mandate acceptance (`kind: 'mandate'`) confirms a party office and stamps
 *     `mandate_accepted_at`.
 *
 * Links are single-use: re-opening one reports that it was already used rather
 * than failing, so a member who taps twice is not told they made a mistake.
 */
export default function ConfirmPage() {
  // Accepts both `/confirm?token=…` and the pretty `/confirm/<token>` the party
  // prints in emails and SMS invites.
  const token = usePublicToken('token', '/confirm');
  const mounted = useMounted();
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [meta, setMeta] = useState<PublicMeta | null>(null);

  useEffect(() => {
    api.publicMeta().then(setMeta).catch(() => setMeta(null));
  }, []);

  useEffect(() => {
    if (!mounted || !token) return;
    let cancelled = false;
    api
      .confirmLink(token)
      .then((result) => !cancelled && setState({ phase: 'done', result }))
      .catch((e: any) =>
        !cancelled && setState({ phase: 'error', message: e?.message ?? 'This link could not be confirmed.' }),
      );
    return () => {
      cancelled = true;
    };
  }, [mounted, token]);

  const deskEmail = meta?.party?.contacts.email ?? null;

  // The token is unknown to the prerender, so nothing token-dependent may be
  // decided until after mount.
  if (!mounted) return <Pending />;

  // Derived rather than stored in `state`, so a token that only arrives from the
  // path segment is not pre-empted by a latched "incomplete link" error.
  if (!token) {
    return (
      <Rejected
        message="This confirmation link is incomplete — the token is missing."
        deskEmail={deskEmail}
      />
    );
  }

  if (state.phase === 'loading') {
    return <Pending />;
  }

  if (state.phase === 'error') {
    return <Rejected message={state.message} deskEmail={deskEmail} />;
  }

  const r = state.result;
  const mandate = r.kind === 'mandate';

  return (
    <PublicFrame
      title={mandate ? 'Mandate accepted' : 'Membership confirmed'}
      subtitle={
        r.alreadyUsed
          ? 'This link was already used — here is the current status.'
          : mandate
            ? 'Your appointment to a party office is now on record.'
            : 'Welcome to the movement. Your membership is active.'
      }
      foot={<PublicFoot />}
    >
      <div className="pub-card">
        <div className="pub-status">
          <span className={`ring ${r.alreadyUsed ? 'warn' : ''}`}>
            <Icon name={r.alreadyUsed ? 'info' : 'checkCircle'} />
          </span>
          <h2>{r.alreadyUsed ? 'Already confirmed' : mandate ? 'You hold the mandate' : 'You are a member'}</h2>
          <p>
            {mandate
              ? `${r.position ?? 'Party office'}${r.ward ? ` · Ward ${r.ward}` : ''}${
                  r.regionCode ? ` · ${r.regionCode}` : ''
                }`
              : `Membership ${r.membershipNo} is now ${r.status}.`}
          </p>
        </div>

        <div style={{ marginTop: 16 }}>
          <div className="kv">
            <span className="k">Membership</span>
            <span className="v">{r.membershipNo}</span>
          </div>
          <div className="kv">
            <span className="k">Status</span>
            <span className="v">{r.status}</span>
          </div>
          {mandate && (
            <>
              <div className="kv">
                <span className="k">Office</span>
                <span className="v">{r.position ?? '—'}</span>
              </div>
              <div className="kv">
                <span className="k">Ward</span>
                <span className="v">{r.ward ?? '—'}</span>
              </div>
              <div className="kv">
                <span className="k">Region</span>
                <span className="v">{r.regionCode ?? 'National'}</span>
              </div>
            </>
          )}
          <div className="kv">
            <span className="k">Mandate</span>
            <span className="v">{r.mandateAccepted ? 'accepted' : 'not applicable'}</span>
          </div>
        </div>
      </div>

      {r.verifyUrl && (
        <div className="pub-card" style={{ textAlign: 'center' }}>
          <div className="mini-label">Your public party card</div>
          <QrCode value={r.verifyUrl} size={160} label="Public party card QR code" />
          <p className="hint-text" style={{ margin: '10px 0 0' }}>
            Anyone scanning this code sees your membership number, ward, offices and party contact
            details — and can join the movement from the same page.
          </p>
          <div className="pub-actions">
            <a className="btn btn-primary" href={r.verifyUrl}>
              <Icon name="qr" size={16} /> Open my party card
            </a>
            <a className="btn btn-ghost" href="/register">
              <Icon name="flag" size={16} /> Invite someone to join
            </a>
          </div>
        </div>
      )}
    </PublicFrame>
  );
}
