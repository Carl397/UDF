'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import { EmptyState, Icon, ToastProvider, useToast } from '../ui';
import Logo from '../Logo';
import { WardFinder } from '../WardTransparency';
import CmsPage from '../CmsPage';
import type { Manifesto, Petition } from '../../types';

/**
 * Public, non-member home — the first screen a visitor sees at `/` when they
 * are not signed in. Corporate hero with the party mission, a primary
 * "Become a member" call to action, and the open petitions that anyone can
 * read. Confirmed members sign a petition with their public party code
 * (members have no staff login); everyone else is invited to join.
 */
export default function PublicHome() {
  return (
    <ToastProvider>
      <PublicHomeInner />
    </ToastProvider>
  );
}

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function PublicHomeInner() {
  const [manifesto, setManifesto] = useState<Manifesto | null>(null);
  const [petitions, setPetitions] = useState<Petition[] | null>(null);

  useEffect(() => {
    api.manifesto().then(setManifesto).catch(() => setManifesto(null));
    api
      .publicPetitions()
      .then((r) => setPetitions(r.items))
      .catch(() => setPetitions([]));
  }, []);

  const party = manifesto?.party;
  const name = party?.name ?? 'UDF';
  const mission =
    manifesto?.mission ?? party?.tagline ?? 'Accountable, community-first governance.';

  const bump = (id: string, count: number) =>
    setPetitions((prev) => (prev ? prev.map((p) => (p.id === id ? { ...p, signatureCount: count } : p)) : prev));

  return (
    <div className="pub ph">
      <header className="ph-hero">
        {/* The <h1> below already prints the party name, so suppress the logo
            wordmark here to avoid a duplicated "UDF" in the hero. */}
        <Logo size={126} variant="light" wordmark={false} />
        <h1>{name}</h1>
        <p className="ph-mission">{mission}</p>
        <div className="ph-cta">
          <Link href="/register" className="btn btn-solid btn-block">
            Become a member
          </Link>
          <Link href="/login" className="btn btn-line btn-block">
            Member sign in
          </Link>
        </div>
      </header>

      <main className="pub-body">
        {/* Published CMS landing page (slider + sections); renders nothing until
            an admin publishes the `home` page, leaving the static content below
            as the fallback. */}
        <CmsPage slug="home" />

        {/* Campaign poster */}
        <div className="pub-card" style={{ padding: 0, overflow: 'hidden' }}>
          <img
            src="/brand/president-poster.jpg"
            alt="Andhor Grey Marks — UDF President campaign poster"
            style={{ width: '100%', display: 'block' }}
          />
        </div>

        {manifesto?.standsFor?.length ? (
          <div className="pub-card">
            <div className="section-label" style={{ margin: '0 0 10px' }}>
              What we stand for
            </div>
            <div className="chip-row">
              {manifesto.standsFor.map((s) => (
                <span key={s} className="chip on">
                  {s}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {/* PRD FR-A/B/C: public ward lookup — location tap → councillor + overview. */}
        <WardFinder />

        <div className="section-label">Open petitions</div>

        {petitions === null ? (
          <div className="pub-card">
            <div className="skeleton" style={{ height: 18, width: '60%', marginBottom: 12 }} />
            <div className="skeleton" style={{ height: 8, marginBottom: 18 }} />
            <div className="skeleton" style={{ height: 40 }} />
          </div>
        ) : petitions.length === 0 ? (
          <div className="pub-card">
            <EmptyState
              icon="doc"
              title="No open petitions"
              hint="When a campaign is live it will appear here for members to sign."
            />
          </div>
        ) : (
          petitions.map((p) => <PetitionCard key={p.id} petition={p} onSigned={bump} />)
        )}

        <footer className="pub-foot">
          <strong>{party?.fullName ?? name}</strong>
          {party?.contacts?.email ? (
            <>
              <br />
              <a href={`mailto:${party.contacts.email}`}>{party.contacts.email}</a>
            </>
          ) : null}
          <br />
          <Link href="/register">Become a member</Link> · <Link href="/login">Member sign in</Link>
        </footer>
      </main>
    </div>
  );
}

function PetitionCard({
  petition,
  onSigned,
}: {
  petition: Petition;
  onSigned: (id: string, count: number) => void;
}) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [signed, setSigned] = useState(false);

  const goal = petition.signatureGoal ?? 0;
  const count = petition.signatureCount;
  const pct = goal > 0 ? Math.min(100, Math.round((count / goal) * 100)) : 0;
  const closes = fmtDate(petition.closesAt);

  async function sign() {
    const value = code.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const r = await api.signPetition(petition.id, value);
      onSigned(petition.id, r.signatureCount);
      setSigned(true);
      toast(r.alreadySigned ? 'You had already signed this petition' : 'Signature recorded — thank you', 'ok');
    } catch (e: any) {
      toast(e?.message ?? 'Could not sign this petition', 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pub-card ph-petition">
      <div className="ph-pet-top">
        <span className="ph-scope">{petition.scope}</span>
        {closes && <span className="ph-closes">Closes {closes}</span>}
      </div>

      <h3 className="ph-pet-title">{petition.title}</h3>
      <div className="ph-pet-target">
        <Icon name="flag" size={14} />
        <span>{petition.target}</span>
      </div>
      {petition.body && <p className="ph-pet-body">{petition.body}</p>}

      <div className="ph-progress">
        <div className="ph-progress-bar">
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="ph-progress-meta">
          <strong>{count.toLocaleString()}</strong>
          {goal > 0 ? <span>of {goal.toLocaleString()} signatures</span> : <span>signatures</span>}
        </div>
      </div>

      {signed ? (
        <div className="banner ok" style={{ marginTop: 14 }}>
          <Icon name="checkCircle" size={16} />
          <span>Signed. Thank you for standing with us.</span>
        </div>
      ) : (
        <>
          <div className="ph-sign">
            <input
              className="ph-sign-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Party code (UDF-XXX-XXX)"
              autoCapitalize="characters"
              autoComplete="off"
              aria-label="Your public party code"
            />
            <button className="btn btn-primary" onClick={sign} disabled={busy || !code.trim()}>
              {busy ? 'Signing…' : 'Sign'}
            </button>
          </div>
          <div className="ph-sign-hint">
            Members sign with their public party code. <Link href="/register">Join to sign</Link>.
          </div>
        </>
      )}
    </div>
  );
}
