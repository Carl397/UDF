'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useShell } from '../AppShell';
import { EmptyState, Icon, Sheet, useToast } from '../ui';
import MediaCapture, { useMediaDrafts } from '../supporter/MediaCapture';
import { MediaThumb } from '../WardTransparency';
import LocationBox from '../supporter/LocationBox';
import { usePreciseLocation } from '../../lib/useLocation';
import { watchPosition, type Position, type WatchHandle } from '../../lib/device';
import type { Patrol, PatrolStop } from '../../types';

/**
 * Start / run / report a ward patrol (plan §3.4).
 *
 * A small state machine in one sheet:
 *  - **start**  — pick walk/drive + a purpose → `api.createPatrol` (the ward is
 *    filled server-side from the caller's scope).
 *  - **active** — a live GPS tracker (`device.watchPosition`) posts track points
 *    as the councillor walks, tallying the distance; "Add stop" drops a noted
 *    waypoint at the current fix.
 *  - **end**    — the overview report: a summary, the (editable) distance and
 *    on-device photo/video/voice-note attachments → `api.endPatrol`, which
 *    stores the media through the shared pipeline (`patrol_media`).
 *  - **view**   — a completed patrol: its summary, distance and attachment count.
 *
 * Media capture reuses the shared `MediaCapture` with `showLocation={false}` —
 * the patrol's own track already carries the geography, so the attachments need
 * no separate GPS fix.
 */

type Phase = 'start' | 'active' | 'end' | 'view';

/** Great-circle metres between two fixes, for the on-device distance tally. */
function haversine(a: Position, b: Position): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function fmtDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

const CALL_STATUSES = [
  { value: 'call_logged', label: 'Call Logged', tone: '' },
  { value: 'in_progress', label: 'In Progress', tone: 'warn' },
  { value: 'waiting_on_feedback', label: 'Waiting on Feedback', tone: 'info' },
  { value: 'completed', label: 'Completed', tone: 'ok' },
] as const;

function statusLabel(s: string) {
  return CALL_STATUSES.find((c) => c.value === s)?.label ?? s;
}
function statusTone(s: string) {
  return CALL_STATUSES.find((c) => c.value === s)?.tone ?? '';
}

export default function PatrolSheet({
  patrol,
  onClose,
  onSaved,
}: {
  /** A patrol to run/view; null or omitted opens the start form. */
  patrol?: Patrol | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { caps } = useShell();
  const toast = useToast();
  const capture = useMediaDrafts(10);

  const [current, setCurrent] = useState<Patrol | null>(patrol ?? null);
  const [phase, setPhase] = useState<Phase>(
    !patrol ? 'start' : patrol.status === 'active' && caps.patrolWrite ? 'active' : 'view',
  );

  // Start-form state.
  const [mode, setMode] = useState<'walk' | 'drive'>('walk');
  const [purpose, setPurpose] = useState('');

  // Active-tracker state.
  const [tracking, setTracking] = useState(false);
  const [points, setPoints] = useState(0);
  const [distance, setDistance] = useState(0);
  const [stopTitle, setStopTitle] = useState('');
  const [stopNote, setStopNote] = useState('');
  const [stopStatus, setStopStatus] = useState<string>('call_logged');
  const stopRequestRef = useRef<string | null>(null);
  const completionRequestRef = useRef<string | null>(null);
  const trackingGeneration = useRef(0);
  const trackingStarting = useRef(false);
  const trackQueue = useRef<Promise<void>>(Promise.resolve());
  const [trackingError, setTrackingError] = useState<string | null>(null);
  // The ward the device's live GPS fix resolves into (echoed back by the server
  // on each saved track point). Shown as the "which ward am I in" label; a code
  // differing from the patrol's own ward means the patrol crossed into a
  // neighbour and is flagged live there. Display only — the patrol stays filed
  // to its own ward.
  const [liveWard, setLiveWard] = useState<{ code: string | null; name: string | null } | null>(null);
  // A precise (≤4 m) fix for the stop, with a live indicator + street/area box.
  const stopLoc = usePreciseLocation(4);
  const [stopAddress, setStopAddress] = useState<{ pos: Position | null; value: string } | null>(null);
  const resolvedAddress = stopLoc.place?.fullAddress ?? stopLoc.place?.label ?? stopLoc.place?.street ?? '';
  const fullStopAddress = stopAddress?.pos === stopLoc.pos ? stopAddress.value : resolvedAddress;
  const watchRef = useRef<WatchHandle | null>(null);
  const seqRef = useRef(0);
  const lastPosRef = useRef<Position | null>(null);
  const distRef = useRef(0);

  // End-report state.
  const [summary, setSummary] = useState('');
  const [distanceInput, setDistanceInput] = useState('');

  // Call log entries for the view phase.
  const [stops, setStops] = useState<PatrolStop[]>([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [stopsError, setStopsError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [busy, setBusy] = useState(false);
  const saving = useRef(false);

  // Load stops when entering view phase.
  useEffect(() => {
    let cancelled = false;
    if (phase === 'view' && current?.id) {
      setStopsLoading(true);
      setStopsError(null);
      Promise.all([api.listPatrolStops(current.id), api.getPatrol(current.id)])
        .then(([r, detail]) => {
          if (!cancelled) { setStops(r.items); setCurrent(detail); }
        })
        .catch((e) => !cancelled && setStopsError(e?.message ?? 'Could not load patrol details'))
        .finally(() => !cancelled && setStopsLoading(false));
    }
    return () => { cancelled = true; };
  }, [phase, current?.id, reload]);

  // Always tear the watch down on unmount so a dismissed sheet cannot keep
  // posting track points in the background.
  useEffect(() => () => { trackingGeneration.current++; watchRef.current?.clear(); }, []);

  const beginTracking = useCallback(
    async (patrolId: string) => {
      if (!caps.patrolWrite || watchRef.current || trackingStarting.current) return; // already tracking
      trackingStarting.current = true;
      const generation = ++trackingGeneration.current;
      try {
        await trackQueue.current;
        const saved = await api.getPatrol(patrolId);
        if (generation !== trackingGeneration.current) return;
        if (saved.status !== 'active') throw new Error('This patrol is no longer active. Reload it.');
        seqRef.current = saved.nextTrackSeq ?? 0;
        setPoints(saved.trackPointCount ?? 0);
        setTrackingError(null);
        setLiveWard(saved.wardCode ? { code: saved.wardCode, name: null } : null);
        const handle = await watchPosition(
          (pos) => {
            if (generation !== trackingGeneration.current || (pos.accuracyM ?? Infinity) > 100) return;
            const last = lastPosRef.current;
            if (last) distRef.current += haversine(last, pos);
            lastPosRef.current = pos;
            const seq = seqRef.current++;
            const recordedAt = new Date().toISOString();
            // Fire-and-forget: one dropped point must not stall the walk. The
            // schema caps accuracy at 100 m, so a coarse fix is clamped.
            trackQueue.current = trackQueue.current.then(() => api
              .addTrackPoint(patrolId, {
                seq,
                latitude: pos.lat,
                longitude: pos.lng,
                ...(pos.accuracyM != null
                  ? { accuracyM: Math.min(100, Math.round(pos.accuracyM)) }
                  : {}),
                recordedAt,
              })
              .then((r) => {
                setPoints((n) => n + 1);
                setDistance(Math.round(distRef.current));
                // The server resolves the fix against the ward geometry and
                // echoes the ward back — drive the live ward label from it.
                if (r && typeof r.wardCode !== 'undefined') setLiveWard({ code: r.wardCode, name: r.wardName });
              })
              .catch((e) => setTrackingError(e?.message ?? 'A track point was not saved. Distance may be incomplete.')));
          },
          (err) => toast(err.message || 'Location watch failed', 'err'),
          { accuracyM: 10, intervalMs: 4000 },
        );
        if (generation !== trackingGeneration.current) { handle.clear(); return; }
        watchRef.current = handle;
        setTracking(true);
        toast('Tracking started', 'ok');
      } catch (e: any) {
        toast(e?.message ?? 'Could not start tracking', 'err');
      } finally {
        trackingStarting.current = false;
      }
    },
    [toast, caps.patrolWrite],
  );

  const stopTracking = useCallback(() => {
    trackingGeneration.current++;
    lastPosRef.current = null;
    watchRef.current?.clear();
    watchRef.current = null;
    setTracking(false);
  }, []);

  useEffect(() => {
    if (!caps.patrolWrite) { stopTracking(); setPhase('view'); }
  }, [caps.patrolWrite, stopTracking]);

  async function submitCreate() {
    if (!caps.patrolWrite || saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      const created = await api.createPatrol({
        mode,
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
      });
      setCurrent(created);
      setPhase('active');
      toast('Patrol started', 'ok');
      onSaved();
      // Begin walking immediately — the point of "start" is to track.
      void beginTracking(created.id);
    } catch (e: any) {
      toast(e?.message ?? 'Could not start the patrol', 'err');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  async function addStop() {
    if (!caps.patrolWrite || !current || saving.current || stopLoc.locating || stopLoc.geocoding) return;
    if (!stopLoc.pos || !stopLoc.settled) {
      stopLoc.start();
      toast('Confirm the stop location and street details, then tap Add stop.', 'ok');
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      const pos = stopLoc.pos;
      const streetAddress = fullStopAddress.trim();
      if (streetAddress.length > 500) throw new Error('Street details must be 500 characters or fewer.');
      if (stopStatus === 'completed' && !stopNote.trim()) throw new Error('Add a completion outcome in the note.');
      stopRequestRef.current ??= crypto.randomUUID();
      await api.addPatrolStop(current.id, {
        requestId: stopRequestRef.current,
        latitude: pos.lat,
        longitude: pos.lng,
        arrivedAt: new Date().toISOString(),
        ...(streetAddress ? { streetAddress } : {}),
        ...(stopTitle.trim() ? { title: stopTitle.trim() } : {}),
        ...(stopNote.trim() ? { note: stopNote.trim() } : {}),
        callStatus: stopStatus,
      });
      stopRequestRef.current = null;
      setStopTitle('');
      setStopNote('');
      setStopStatus('call_logged');
      setStopAddress(null);
      stopLoc.reset();
      toast('Stop added', 'ok');
    } catch (e: any) {
      toast(e?.message ?? 'Could not add the stop', 'err');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  function openEndReport() {
    if (!caps.patrolWrite || saving.current) return;
    stopTracking();
    setDistanceInput('');
    setPhase('end');
  }

  async function submitEnd() {
    if (!caps.patrolWrite || !current || saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await trackQueue.current;
      const dm = distanceInput.trim() ? Number(distanceInput) : undefined;
      if (dm !== undefined && (!Number.isFinite(dm) || dm < 0)) throw new Error('Enter a valid nonnegative distance.');
      completionRequestRef.current ??= crypto.randomUUID();
      const ended = await api.endPatrol(current.id, {
        requestId: completionRequestRef.current,
        ...(summary.trim() ? { summary: summary.trim() } : {}),
        ...(dm != null ? { distanceM: dm } : {}),
        media: capture.payload(),
      });
      setCurrent(ended);
      capture.clear();
      toast('Patrol report filed', 'ok');
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? 'Could not end the patrol', 'err');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  const title =
    phase === 'start'
      ? 'Start patrol'
      : phase === 'end'
        ? 'End & report'
        : (current?.purpose ?? 'Ward patrol');

  const subtitle =
    phase === 'start'
      ? 'A GPS-tracked ward walkabout or drive, filed with an overview report'
      : current
        ? `${current.mode}${current.wardCode ? ` · Ward ${current.wardCode}` : ''}`
        : undefined;

  return (
    <Sheet
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={
        phase === 'start' ? (
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: 2 }}
              onClick={submitCreate}
              disabled={busy}
            >
              <Icon name="pin" size={16} /> {busy ? 'Starting…' : 'Start patrol'}
            </button>
          </div>
        ) : phase === 'active' ? (
          <button className="btn btn-primary btn-block" onClick={openEndReport} disabled={busy}>
            <Icon name="flag" size={16} /> End &amp; report
          </button>
        ) : phase === 'end' ? (
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setPhase('active')} disabled={busy}>
              Back
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: 2 }}
              onClick={submitEnd}
              disabled={busy}
            >
              <Icon name="send" size={16} /> {busy ? 'Filing…' : 'File report'}
            </button>
          </div>
        ) : (
          <button className="btn btn-ghost btn-block" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      {phase === 'start' && (
        <div className="form-grid">
          <div className="field">
            <div className="mini-label">Mode</div>
            <div className="chip-row" style={{ marginTop: 6 }}>
              {(['walk', 'drive'] as const).map((m) => (
                <button
                  key={m}
                  className={`chip ${mode === m ? 'on' : ''}`}
                  onClick={() => setMode(m)}
                >
                  <Icon name={m === 'walk' ? 'pin' : 'map'} size={14} /> {m}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor="patrol-purpose">Purpose</label>
            <input
              id="patrol-purpose"
              className="input"
              value={purpose}
              maxLength={500}
              placeholder="e.g. Ward walkabout — water outages on Spine Road"
              onChange={(e) => setPurpose(e.target.value)}
            />
          </div>
          <p className="hint-text">
            Tracking begins as soon as you start, and files against your ward. You can
            pause it, drop noted stops, and attach photos, video or a voice note to the
            overview report when you end the patrol.
          </p>
        </div>
      )}

      {phase === 'active' && current && (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-title">
              <span className={`dot ${tracking ? 'ok' : 'warn'}`} style={{ marginRight: 8 }} />
              {tracking ? 'Tracking…' : 'Paused'}
            </div>
            <div className="stat-grid" style={{ marginTop: 10 }}>
              <div className="stat">
                <div className="num">{points}</div>
                <div className="lbl">Saved track points</div>
              </div>
              <div className="stat accent">
                <div className="num">{fmtDistance(distance)}</div>
                <div className="lbl">Session distance estimate</div>
              </div>
            </div>
            <div className="chip-row" style={{ marginTop: 12 }}>
              <button
                className={`btn ${tracking ? 'btn-ghost' : 'btn-primary'} btn-sm`}
                onClick={tracking ? stopTracking : () => void beginTracking(current.id)}
                disabled={busy}
              >
                <Icon name={tracking ? 'x' : 'pin'} size={15} />{' '}
                {tracking ? 'Pause tracking' : 'Start tracking'}
              </button>
            </div>
            <p className="hint-text" style={{ marginTop: 8 }}>
              Started{' '}
              {current.startedAt ? new Date(current.startedAt).toLocaleTimeString() : 'now'}
              {current.wardCode ? ` · Ward ${current.wardCode}` : ''} · {current.mode}
            </p>
            {/* Live GPS ward. Green when still in your own ward, amber once the
                track has moved into a neighbouring ward. */}
            <div className="chip-row" style={{ marginTop: 10 }}>
              <span
                className={`badge ${
                  liveWard?.code && current.wardCode && liveWard.code !== current.wardCode
                    ? 'warn'
                    : tracking
                      ? 'ok'
                      : ''
                }`}
              >
                <span className={`dot ${tracking ? 'ok' : 'warn'}`} style={{ marginRight: 6 }} />
                {tracking ? 'LIVE' : 'PAUSED'} ·{' '}
                {liveWard?.code
                  ? liveWard.name
                    ? `${liveWard.name} (${liveWard.code})`
                    : `Ward ${liveWard.code}`
                  : 'Locating ward…'}
              </span>
            </div>
          </div>

          {trackingError && <p className="banner err" role="alert">{trackingError}</p>}
          {tracking && liveWard?.code && current.wardCode && liveWard.code !== current.wardCode && (
            <p className="banner warn" role="status">
              Patrol is live in{' '}
              {liveWard.name ? `${liveWard.name} (${liveWard.code})` : `Ward ${liveWard.code}`},
              outside your ward {current.wardCode}. It stays filed to {current.wardCode}.
            </p>
          )}
          <div className="card">
            <div className="mini-label">Log a call / Add a stop</div>
            <LocationBox loc={stopLoc} idleLabel="Get precise stop location" fullAddress />
            <div className="field" style={{ marginTop: 10 }}>
              <label htmlFor="patrol-stop-address">Full street details</label>
              <textarea
                id="patrol-stop-address"
                className="input"
                rows={3}
                maxLength={500}
                value={fullStopAddress}
                disabled={!stopLoc.settled || stopLoc.geocoding || busy}
                placeholder="House number, full street name, suburb, city and postal code"
                onChange={(e) => setStopAddress({ pos: stopLoc.pos, value: e.target.value })}
              />
              <p className="hint-text">Confirm or complete the address for this stop. If lookup is unavailable, enter it after the GPS fix settles.</p>
            </div>
            <div className="field" style={{ marginTop: 6 }}>
              <input
                className="input"
                value={stopTitle}
                maxLength={500}
                placeholder="Title — e.g. Broken streetlight, Main Road"
                onChange={(e) => setStopTitle(e.target.value)}
              />
            </div>
            <div className="field" style={{ marginTop: 6 }}>
              <input
                className="input"
                value={stopNote}
                maxLength={2000}
                placeholder="Note for this stop (optional)"
                onChange={(e) => setStopNote(e.target.value)}
              />
            </div>
            <div className="field" style={{ marginTop: 6 }}>
              <select
                className="input"
                value={stopStatus}
                onChange={(e) => setStopStatus(e.target.value)}
              >
                {CALL_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={addStop} disabled={busy || stopLoc.locating || stopLoc.geocoding}>
              <Icon name="flag" size={15} /> Add stop at current position
            </button>
          </div>
        </>
      )}

      {phase === 'end' && (
        <div className="form-grid">
          <div className="field">
            <label htmlFor="patrol-summary">Overview report</label>
            <textarea
              id="patrol-summary"
              className="input"
              rows={6}
              maxLength={5000}
              value={summary}
              placeholder="What you saw, who you spoke to, what needs follow-up…"
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="patrol-distance">Manual distance override (meters, optional)</label>
            <input
              id="patrol-distance"
              className="input"
              type="number"
              min={0}
              value={distanceInput}
              placeholder="Use saved GPS segments"
              onChange={(e) => setDistanceInput(e.target.value)}
            />
          </div>
          <div className="field">
            <div className="mini-label">Attach photos, video or a voice note</div>
            <MediaCapture api={capture} showLocation={false} />
          </div>
          <p className="hint-text">
            {points} track point{points === 1 ? '' : 's'} saved in total · {fmtDistance(distance)} estimated
            this session. Final distance uses saved GPS segments.
          </p>
        </div>
      )}

      {phase === 'view' && current && (
        <>
          <div className="chip-row" style={{ marginBottom: 12 }}>
            <span
              className={`badge ${
                current.status === 'completed'
                  ? 'ok'
                  : current.status === 'active'
                    ? 'warn'
                    : ''
              }`}
            >
              {current.status}
            </span>
            <span className="badge">{current.mode}</span>
            {current.wardCode && <span className="badge">{current.wardCode}</span>}
          </div>

          <div className="rows" style={{ margin: '12px 0' }}>
            <div className="row">
              <span className="row-ico">
                <Icon name="calendar" />
              </span>
              <span className="row-main">
                <span className="row-title">
                  {current.startedAt ? new Date(current.startedAt).toLocaleString() : '—'}
                </span>
                <span className="row-sub">
                  Started
                  {current.endedAt
                    ? ` · ended ${new Date(current.endedAt).toLocaleString()}`
                    : ''}
                </span>
              </span>
            </div>
            <div className="row">
              <span className="row-ico">
                <Icon name="pin" />
              </span>
              <span className="row-main">
                <span className="row-title">
                  {current.distanceM != null ? fmtDistance(current.distanceM) : 'Distance unknown'}
                </span>
                <span className="row-sub">
                  {current.distanceSource === 'manual' ? 'Manually entered' : current.distanceSource === 'gps' ? 'Saved GPS segments' : 'Source unknown'}
                  {current.mediaCount
                    ? ` · ${current.mediaCount} attachment${current.mediaCount === 1 ? '' : 's'}`
                    : ''}
                </span>
              </span>
            </div>
          </div>

          {current.summary ? (
            <div className="card">
              <div className="mini-label">Overview report</div>
              <p className="sheet-text" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>
                {current.summary}
              </p>
            </div>
          ) : (
            <EmptyState
              icon="doc"
              title="No report filed"
              hint="This patrol was closed without an overview report."
            />
          )}

          {current.media?.map((media) => <MediaThumb key={media.mediaId} mediaId={media.mediaId} label="Patrol attachment" />)}
          {/* Wards the GPS track actually passed through; a `crossing` row is a
              neighbouring ward the patrol moved over into. */}
          {current.wardEntries && current.wardEntries.length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="mini-label">Wards walked ({current.wardEntries.length})</div>
              <div className="rows" style={{ marginTop: 6 }}>
                {current.wardEntries.map((w) => (
                  <div key={w.wardCode} className="row" style={{ cursor: 'default' }}>
                    <span className="row-ico"><Icon name="pin" /></span>
                    <span className="row-main">
                      <span className="row-title">{w.wardName ? `${w.wardName} · ${w.wardCode}` : w.wardCode}</span>
                      <span className="row-sub tiny">
                        {new Date(w.firstSeenAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                        {' → '}{new Date(w.lastSeenAt).toLocaleTimeString()}
                        {` · ${w.pointCount} fix${w.pointCount === 1 ? '' : 'es'}`}
                      </span>
                    </span>
                    {w.crossing
                      ? <span className="badge warn">live in other ward</span>
                      : <span className="badge ok">own ward</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {stopsError && <div className="banner err" role="alert">{stopsError} <button className="btn btn-sm" onClick={() => setReload((n) => n + 1)}>Retry</button></div>}
          {/* Call log entries */}
          <div style={{ marginTop: 16 }}>
            <div className="mini-label">Call log ({stopsError || stopsLoading ? '—' : stops.length})</div>
            {stopsLoading ? (
              <p style={{ color: '#64748b', fontSize: 13 }}>Loading calls…</p>
            ) : stopsError ? null : stops.length === 0 ? (
              <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 4 }}>No calls logged for this patrol.</p>
            ) : (
              <div className="rows" style={{ marginTop: 6 }}>
                {stops.map((stop) => (
                  <CallLogEntry
                    key={stop.id}
                    stop={stop}
                    patrolId={current.id}
                    canEdit={!!caps.patrolWrite}
                    onUpdated={(updated: PatrolStop) =>
                      setStops((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
                    }
                  />
                ))}
              </div>
            )}
          </div>

          {!caps.patrolWrite && (
            <p className="hint-text" style={{ marginTop: 8 }}>
              Patrols are started and reported by ward staff. You can view this patrol but
              not change it.
            </p>
          )}
        </>
      )}
    </Sheet>
  );
}

/** A single call log row with inline status editing. */
function CallLogEntry({
  stop,
  patrolId,
  canEdit,
  onUpdated,
}: {
  stop: PatrolStop;
  patrolId: string;
  canEdit: boolean;
  onUpdated: (s: PatrolStop) => void;
}) {
  const toast = useToast();
  const [updating, setUpdating] = useState(false);
  const [next, setNext] = useState(stop.callStatus);
  const [outcome, setOutcome] = useState('');
  const [method, setMethod] = useState(stop.contactMethod ?? '');
  const [due, setDue] = useState('');

  async function changeStatus() {
    if (updating) return;
    if (!outcome.trim()) { toast('Record an outcome for this update', 'err'); return; }
    setUpdating(true);
    try {
      const updated = await api.updatePatrolStop(patrolId, stop.id, {
        callStatus: next,
        note: outcome.trim(),
        ...(method ? { contactMethod: method } : {}),
        ...(due && next !== 'completed' ? { followUpAt: new Date(due).toISOString() } : {}),
      });
      setOutcome('');
      setDue('');
      onUpdated(updated);
    } catch (e: any) {
      toast(e?.message ?? 'Could not update status', 'err');
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <span className="row-ico">
        <Icon name="flag" />
      </span>
      <span className="row-main" style={{ flex: 1 }}>
        <span className="row-title">{stop.title || '(Untitled call)'}</span>
        {stop.note && <span className="row-sub">{stop.note}</span>}
        <span className="row-sub" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
          {stop.streetAddress ? `${stop.streetAddress} · ` : ''}
          {new Date(stop.arrivedAt).toLocaleString()}
        </span>
      </span>
      <div style={{ flex: 1, minWidth: 160 }}>
        <span className={`badge ${statusTone(stop.callStatus)}`}>{statusLabel(stop.callStatus)}</span>
        {stop.contactMethod && <p className="hint-text">Contact: {stop.contactMethod.replace(/_/g, ' ')}</p>}
        {stop.followUpAt && <p className="hint-text">Next follow-up: {new Date(stop.followUpAt).toLocaleString()}</p>}
        {stop.completedAt && <p className="hint-text">Completed: {new Date(stop.completedAt).toLocaleString()}</p>}
        {canEdit && <details>
          <summary>Update / follow up</summary>
          <fieldset disabled={updating} style={{ border: 0, padding: 0 }}>
            <label>Status<select className="input" value={next} onChange={(e) => setNext(e.target.value as PatrolStop['callStatus'])}>
              {CALL_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select></label>
            <label>Contact method<select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="">No new contact</option>
              {['phone','email','sms','whatsapp','in_person','service_portal','other'].map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}
            </select></label>
            <label>Outcome<textarea className="input" maxLength={2000} value={outcome} onChange={(e) => setOutcome(e.target.value)} /></label>
            {next !== 'completed' && <label>Next follow-up<input className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></label>}
            <button className="btn btn-sm" onClick={changeStatus}>Save update</button>
          </fieldset>
        </details>}
      </div>
    </div>
  );
}
