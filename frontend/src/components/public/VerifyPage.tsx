'use client';

import { useEffect, useState } from 'react';
import { api, API_BASE } from '../../lib/api';
import { usePublicToken, useMounted } from '../../lib/publicLink';
import PublicFrame, { PublicFoot } from '../PublicFrame';
import { Icon } from '../ui';
import QrCode from '../QrCode';
import type { PublicMeta, VerifyCard } from '../../types';

/** Neutral loading screen — identical on the server and the first client render. */
function Pending({ subtitle }: { subtitle?: string }) {
  return (
    <PublicFrame
      title="Verifying party card…"
      subtitle={subtitle ?? 'Checking the party membership register'}
    >
      <div className="pub-card">
        <div className="skeleton" style={{ height: 150 }} />
        <div className="skeleton" style={{ height: 16, marginTop: 12 }} />
        <div className="skeleton" style={{ height: 16, marginTop: 8, width: '55%' }} />
      </div>
    </PublicFrame>
  );
}

/**
 * Public party-card verification page — the target of the QR code printed on a
 * Ward Candidate / member party card.
 *
 * Privacy by design: membership number, ward, offices and status are always
 * shown; personal contact details appear only when the member consented to
 * data sharing, and every decryption is written to the audit log.
 */
export default function VerifyPage() {
  // Accepts both `/v?code=…` and the pretty `/v/UDF-ABC-XYZ` printed on cards.
  const code = usePublicToken('code', '/v').toUpperCase();
  const mounted = useMounted();
  const [card, setCard] = useState<VerifyCard | null>(null);
  const [meta, setMeta] = useState<PublicMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.publicMeta().then(setMeta).catch(() => setMeta(null));
  }, []);

  useEffect(() => {
    if (!mounted || !code) return;
    let cancelled = false;
    api
      .verifyCode(code)
      .then((c) => !cancelled && setCard(c))
      .catch((e: any) => !cancelled && setError(e?.message ?? 'That party code could not be verified.'));
    return () => {
      cancelled = true;
    };
  }, [mounted, code]);

  const party = meta?.party;

  // The code is unknown to the prerender, so nothing code-dependent may be
  // decided until after mount.
  if (!mounted) return <Pending />;

  // Derived, not stored: a missing code must not latch an error that survives
  // the token arriving from the path segment.
  const problem = code ? error : 'No party code was supplied.';

  if (problem) {
    return (
      <PublicFrame title="Code not recognised" foot={<PublicFoot />}>
        <div className="pub-card">
          <div className="pub-status">
            <span className="ring err">
              <Icon name="alert" />
            </span>
            <h2>This party card could not be verified</h2>
            <p>{problem}</p>
          </div>
          <div className="pub-actions">
            <a className="btn btn-primary" href="/register">
              <Icon name="clipboard" size={16} /> Join the UDF instead
            </a>
          </div>
        </div>
      </PublicFrame>
    );
  }

  if (!card) {
    return <Pending subtitle={code || undefined} />;
  }

  const office = card.roles[0];

  return (
    <PublicFrame
      title={card.contact?.fullName ?? 'UDF party card'}
      subtitle={`${card.publicCode} · verified against the party membership register`}
      foot={<PublicFoot />}
    >
      <div className="id-card" style={{ marginBottom: 14 }}>
        <div className="id-flag">
          <span className="id-udf">UDF</span>
          <span className="id-party">PARTY</span>
          <span className="id-tagline">ONE FLAG · ONE MOVEMENT</span>
        </div>
        <div className="id-body">
          <div className="id-name">{card.contact?.fullName ?? 'UDF MEMBER'}</div>
          <div className="id-rule" />
          <div className="id-kv">
            <span>Membership</span>
            <strong>{card.membershipNo ?? '—'}</strong>
          </div>
          <div className="id-kv">
            <span>Office</span>
            <strong>{office?.title ?? office?.name ?? `Member · ${card.tier}`}</strong>
          </div>
          <div className="id-kv">
            <span>Ward</span>
            <strong>{card.ward ? `Ward ${card.ward}` : '—'}</strong>
          </div>
          <div className="id-kv">
            <span>Status</span>
            <strong>
              {card.status}
              {card.joinedAt ? ` since ${new Date(card.joinedAt).getFullYear()}` : ''}
            </strong>
          </div>
        </div>
        <div className="id-qr">
          <QrCode value={card.joinUrl} size={104} label="Join the party QR code" dark="#141414" />
          <code>scan to join</code>
        </div>
      </div>

      <div className="pub-card">
        <div className="card-title">
          Membership <span className="muted">{card.confirmed ? 'confirmed' : 'pending confirmation'}</span>
        </div>
        <div className="kv">
          <span className="k">Membership number</span>
          <span className="v">{card.membershipNo ?? '—'}</span>
        </div>
        <div className="kv">
          <span className="k">Party code</span>
          <span className="v">{card.publicCode}</span>
        </div>
        <div className="kv">
          <span className="k">Membership tier</span>
          <span className="v">{card.tier}</span>
        </div>
        <div className="kv">
          <span className="k">Region</span>
          <span className="v">{card.regionCode ?? 'National'}</span>
        </div>
        <div className="kv">
          <span className="k">Ward</span>
          <span className="v">{card.ward ?? '—'}</span>
        </div>
        <div className="kv">
          <span className="k">Joined</span>
          <span className="v">
            {card.joinedAt ? new Date(card.joinedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—'}
          </span>
        </div>
        {card.mandateAcceptedAt && (
          <div className="kv">
            <span className="k">Mandate accepted</span>
            <span className="v">
              {new Date(card.mandateAcceptedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
            </span>
          </div>
        )}
      </div>

      {card.roles.length > 0 && (
        <div className="pub-card">
          <div className="card-title">Party offices held</div>
          <div className="pub-roles">
            {card.roles.map((r, i) => (
              <div className="pub-role" key={`${r.name}-${i}`}>
                <Icon name="shield" size={17} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b>{r.title ?? r.name}</b>
                  <br />
                  <span>
                    {r.ward ? `Ward ${r.ward} · ` : ''}
                    {r.status}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {card.contact ? (
        <div className="pub-card">
          <div className="card-title">
            Contact <span className="muted">shared by the member</span>
          </div>
          <div className="kv">
            <span className="k">Name</span>
            <span className="v">{card.contact.fullName}</span>
          </div>
          {card.contact.phone && (
            <div className="kv">
              <span className="k">Phone</span>
              <span className="v">
                <a href={`tel:${card.contact.phone}`} style={{ color: 'inherit' }}>
                  {card.contact.phone}
                </a>
              </span>
            </div>
          )}
          {card.contact.email && (
            <div className="kv">
              <span className="k">Email</span>
              <span className="v">
                <a href={`mailto:${card.contact.email}`} style={{ color: 'inherit' }}>
                  {card.contact.email}
                </a>
              </span>
            </div>
          )}
          <div className="pub-actions">
            <a className="btn btn-ghost" href={`${API_BASE}/public/verify/${card.publicCode}/vcard`} download>
              <Icon name="download" size={16} /> Save contact (.vcf)
            </a>
          </div>
        </div>
      ) : (
        <div className="banner">
          <Icon name="lock" size={17} />
          <span>
            This member has not opted to publish personal contact details. Reach them through the
            party contact below — every request is logged.
          </span>
        </div>
      )}

      {party && (
        <div className="pub-card">
          <div className="card-title">{party.fullName}</div>
          <p className="sheet-text" style={{ marginTop: 0 }}>
            {party.slogan} · {party.tagline}
          </p>
          <div className="kv">
            <span className="k">Email</span>
            <span className="v">
              <a href={`mailto:${party.contacts.email}`} style={{ color: 'inherit' }}>
                {party.contacts.email}
              </a>
            </span>
          </div>
          <div className="kv">
            <span className="k">Press desk</span>
            <span className="v">{party.contacts.press}</span>
          </div>
          <div className="kv">
            <span className="k">Hours</span>
            <span className="v">{party.officeHours}</span>
          </div>
          <div className="kv">
            <span className="k">Address</span>
            <span className="v">{party.contacts.address}</span>
          </div>

          <div className="pub-actions">
            <a className="btn btn-primary" href={card.joinUrl}>
              <Icon name="flag" size={17} /> Join the party
            </a>
            <a className="btn btn-gold" href="/register">
              <Icon name="clipboard" size={16} /> Membership registration form
            </a>
          </div>
        </div>
      )}
    </PublicFrame>
  );
}
