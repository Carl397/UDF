'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, API_BASE } from '../lib/api';
import { Icon } from './ui';
import type { WardDetail, WardLookupResult, WardOverview } from '../types';

/**
 * Ward transparency & accountability surface (PRD Phase 4.5).
 *
 *  - WardFinder: public "use my location" → ward + councillor + overview (FR-A/B/C).
 *  - WardDetailPanel: member-gated patrols / projects / logs + rating (FR-D).
 *
 * Only aggregate, PII-free data is rendered here; media is fetched with the
 * bearer token so the privacy tier is enforced server-side.
 */

/** Authenticated thumbnail: <img> cannot send an Authorization header. */
export function MediaThumb({ mediaId, label }: { mediaId: string; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [contentType, setContentType] = useState('');
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    api.transparencyMediaBlob(mediaId, controller.signal)
      .then((blob) => {
        if (cancelled) return;
        if (!blob) throw new Error('Media unavailable');
        objectUrl = URL.createObjectURL(blob);
        setContentType(blob.type);
        setUrl(objectUrl);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mediaId, attempt]);

  if (!url) {
    return (
      <span className="chip" style={{ textTransform: 'capitalize' }}>
        {failed ? `${label}: unavailable` : `Loading ${label}…`}
        {failed && <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>Retry</button>}
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
      {contentType.startsWith('audio/') ? <audio controls src={url} preload="metadata" style={{ maxWidth: '100%' }} />
        : contentType.startsWith('video/') ? <video controls playsInline src={url} preload="metadata" style={{ maxWidth: '100%', width: 320 }} />
        : <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={label} style={{ width: 100, height: 100, objectFit: 'cover', borderRadius: 10 }} /></a>}
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'capitalize', color: '#57534e' }}>{label}</span>
    </span>
  );
}

/**
 * Published ward-councillor portrait. Deliberately NOT the authenticated
 * `MediaThumb`: this photo is public by design (the server only answers for
 * media attached to an `is_public` leader row), and the ward finder is used by
 * residents with no account, who have no bearer token to send.
 */
function LeaderPhoto({ photoId, name }: { photoId: string; name: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${API_BASE}/public/media/${photoId}`}
      alt={`${name}, ward councillor`}
      style={{
        width: 64,
        height: 64,
        objectFit: 'cover',
        borderRadius: '50%',
        border: '2px solid #ece5e1',
        background: '#faf7f5',
        flex: 'none',
      }}
    />
  );
}

/** FR-D5: 1-5 rating with mandatory reason when <=2. */
function RatingControl({
  targetType,
  targetId,
  onDone,
}: {
  targetType: 'service_request' | 'project' | 'patrol';
  targetId: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (rating < 1) return;
    if (rating <= 2 && !reason.trim()) {
      setError('Please tell us why (required for ratings of 2 or below).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.rateTransparencyWork({ targetType, targetId, rating, reason: reason.trim() || undefined });
      setOpen(false);
      setRating(0);
      setReason('');
      onDone();
    } catch (e: any) {
      setError(e?.message ?? 'Could not save rating');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn btn-line" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => setOpen(true)}>
        Rate
      </button>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            className={rating === n ? 'btn btn-solid' : 'btn btn-line'}
            style={{ padding: '4px 10px', fontSize: 13 }}
            onClick={() => setRating(n)}
          >
            {n}
          </button>
        ))}
      </div>
      {rating <= 2 && rating > 0 && (
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="What went wrong? (required)"
          rows={2}
          style={{ borderRadius: 10, border: '1px solid #e3d9d5', padding: 8, fontSize: 13 }}
        />
      )}
      {error && <div style={{ color: '#a00d24', fontSize: 12 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-solid" style={{ padding: '6px 14px', fontSize: 13 }} disabled={busy} onClick={submit}>
          {busy ? 'Saving…' : 'Submit'}
        </button>
        <button className="btn btn-line" style={{ padding: '6px 14px', fontSize: 13 }} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function OverviewGrid({ o }: { o: WardOverview }) {
  const cells: Array<[string, string | number]> = [
    ['Patrols (30d)', o.patrols30d],
    ['Patrols (90d)', o.patrols90d],
    ['Open cases', o.casesActive],
    ['Resolved', o.casesResolved],
    ['Projects', `${o.projectsActive} active / ${o.projectsDelivered} done`],
    ['Bulletins', o.bulletins],
    ['Rating', o.ratingMean == null ? '—' : `${o.ratingMean} / 5 (${o.ratingCount})`],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginTop: 10 }}>
      {cells.map(([label, value]) => (
        <div key={label} style={{ background: '#faf7f5', border: '1px solid #ece5e1', borderRadius: 10, padding: '8px 10px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#8a817b', textTransform: 'uppercase', letterSpacing: 0.6 }}>
            {label}
          </div>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#1c1917' }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

/** FR-A/B/C: public geolocation ward + councillor + overview. */
export function WardFinder() {
  const [state, setState] = useState<'idle' | 'locating' | 'loading' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<WardLookupResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const locate = useCallback((attempt: number) => {
    if (!('geolocation' in navigator)) {
      setState('error');
      setMessage('This device has no location service. Browse wards from the map instead.');
      return;
    }
    setState(attempt === 0 ? 'locating' : 'locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        // FR-B2: target 3-5m. Retry twice when the fix is coarser, then accept.
        if (accuracy > 5 && attempt < 2) {
          locate(attempt + 1);
          return;
        }
        setState('loading');
        api
          .wardLookup(latitude, longitude, accuracy)
          .then((r) => {
            setResult(r);
            setState('done');
          })
          .catch((e) => {
            setState('error');
            setMessage(e?.message ?? 'Could not resolve your ward');
          });
      },
      () => {
        setState('error');
        setMessage('Location permission denied. You can still browse a ward from the map.');
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  }, []);

  return (
    <div className="pub-card">
      <div className="section-label" style={{ margin: '0 0 10px' }}>
        Who represents me?
      </div>
      <p style={{ fontSize: 13, color: '#57534e', margin: '0 0 12px' }}>
        Tap to use your current location (accurate to a few metres). We show your ward, your ward
        councillor and an overview of their work — no account needed.
      </p>
      <button className="btn btn-solid btn-block" disabled={state === 'locating' || state === 'loading'} onClick={() => locate(0)}>
        {state === 'locating' ? 'Getting your location…' : state === 'loading' ? 'Finding your ward…' : 'Use my location'}
      </button>

      {state === 'error' && message && (
        <div className="banner" style={{ marginTop: 12 }}>
          <Icon name="flag" size={16} />
          <span>{message}</span>
        </div>
      )}

      {state === 'done' && result && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <strong style={{ fontSize: 16 }}>Ward {result.ward.name}</strong>
            <span style={{ fontSize: 11, color: '#8a817b' }}>
              {result.accuracyM != null ? `±${Math.round(result.accuracyM)} m` : 'location'}
              {!result.accurate ? ' (low accuracy)' : ''}
            </span>
          </div>
          {result.vacant || !result.councillor ? (
            <div className="banner" style={{ marginTop: 10 }}>
              <Icon name="flag" size={16} />
              {/* An empty ward has two honest explanations and they are not
                  interchangeable. A contested seat that is currently empty will
                  be filled; a ward the party never stood anyone in had no seat
                  to fill, and calling that "vacant" promises something that
                  cannot happen. Unknown (`contested` absent) stays neutral. */}
              <span>
                {result.contested === false
                  ? 'UDF did not field a candidate in this ward at the 2026 local elections, so there is no ward councillor here. Your regional leadership represents the ward in the meantime.'
                  : 'The councillor seat for this ward is currently vacant. Watch ward bulletins for updates.'}
              </span>
            </div>
          ) : (
            <div style={{ marginTop: 6, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {result.councillor.photoId && (
                <LeaderPhoto photoId={result.councillor.photoId} name={result.councillor.fullName} />
              )}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: '#8a817b' }}>Your ward councillor</div>
                <div style={{ fontSize: 15, fontWeight: 800 }}>{result.councillor.fullName}</div>
                {result.councillor.bio && <div style={{ fontSize: 13, color: '#57534e' }}>{result.councillor.bio}</div>}
              </div>
            </div>
          )}
          <OverviewGrid o={result.overview} />
          <p style={{ fontSize: 11.5, color: '#8a817b', margin: '10px 0 0' }}>
            Members of this ward see full patrol, project and case detail after signing in.
          </p>
        </div>
      )}
    </div>
  );
}

/** FR-D: member-gated ward detail with rating. */
export function WardDetailPanel({ wardCode }: { wardCode: string }) {
  const [detail, setDetail] = useState<WardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    api
      .wardDetail(wardCode)
      .then(setDetail)
      .catch((e) => setError(e?.message ?? 'Could not load ward detail'));
  }, [wardCode, reload]);

  if (error) return <div className="banner">{error}</div>;
  if (!detail) return <div className="skeleton" style={{ height: 120 }} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="pub-card">
        <div className="section-label" style={{ margin: '0 0 10px' }}>
          Councillor patrols — {detail.ward.name}
        </div>
        {detail.patrols.length === 0 ? (
          <p style={{ fontSize: 13, color: '#8a817b' }}>No completed patrols published yet.</p>
        ) : (
          detail.patrols.map((p) => (
            <div key={p.id} style={{ borderBottom: '1px solid #ece5e1', padding: '10px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontSize: 14, textTransform: 'capitalize' }}>{p.purpose ?? p.mode}</strong>
                <span style={{ fontSize: 12, color: '#8a817b' }}>{p.date?.slice(0, 10)}</span>
              </div>
              {p.remarks && <p style={{ fontSize: 13, color: '#57534e', margin: '4px 0' }}>{p.remarks}</p>}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, color: '#8a817b' }}>
                {p.distanceM != null && <span>{(p.distanceM / 1000).toFixed(1)} km</span>}
                <span>
                  {p.ratingMean == null ? 'Not rated' : `★ ${p.ratingMean} (${p.ratingCount})`}
                </span>
                <RatingControl targetType="patrol" targetId={p.id} onDone={() => setReload((n) => n + 1)} />
              </div>
            </div>
          ))
        )}
      </div>

      <div className="pub-card">
        <div className="section-label" style={{ margin: '0 0 10px' }}>
          Projects & progress
        </div>
        {detail.projects.length === 0 ? (
          <p style={{ fontSize: 13, color: '#8a817b' }}>No published projects yet.</p>
        ) : (
          detail.projects.map((pr) => (
            <div key={pr.id} style={{ borderBottom: '1px solid #ece5e1', padding: '10px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontSize: 14 }}>{pr.title}</strong>
                <span style={{ fontSize: 12, color: '#8a817b', textTransform: 'capitalize' }}>{pr.stage}</span>
              </div>
              {pr.progressPct != null && (
                <div style={{ height: 6, background: '#ece5e1', borderRadius: 3, margin: '6px 0' }}>
                  <div style={{ height: 6, width: `${pr.progressPct}%`, background: '#c8102e', borderRadius: 3 }} />
                </div>
              )}
              {pr.media.length > 0 && (
                <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
                  {pr.media.map((m) => (
                    <MediaThumb key={m.mediaId} mediaId={m.mediaId} label={m.stage} />
                  ))}
                </div>
              )}
              <div style={{ marginTop: 6 }}>
                <RatingControl targetType="project" targetId={pr.id} onDone={() => setReload((n) => n + 1)} />
              </div>
            </div>
          ))
        )}
      </div>

      <div className="pub-card">
        <div className="section-label" style={{ margin: '0 0 10px' }}>
          Service logs & reference numbers
        </div>
        {detail.logs.length === 0 ? (
          <p style={{ fontSize: 13, color: '#8a817b' }}>No service logs published yet.</p>
        ) : (
          detail.logs.map((l) => (
            <div key={l.id} style={{ borderBottom: '1px solid #ece5e1', padding: '10px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontSize: 14 }}>{l.title}</strong>
                <span style={{ fontSize: 12, color: '#8a817b', textTransform: 'capitalize' }}>{l.status}</span>
              </div>
              <div style={{ fontSize: 12, color: '#57534e', margin: '4px 0' }}>
                Ref <code>{l.refNo}</code> · {l.category} · opened {l.createdAt.slice(0, 10)}
                {l.resolvedAt ? ` · resolved ${l.resolvedAt.slice(0, 10)}` : ''}
              </div>
              {l.media.length > 0 && (
                <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
                  {l.media.map((m) => (
                    <MediaThumb key={m.mediaId} mediaId={m.mediaId} label="reported" />
                  ))}
                </div>
              )}
              <div style={{ marginTop: 6 }}>
                <RatingControl targetType="service_request" targetId={l.id} onDone={() => setReload((n) => n + 1)} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
