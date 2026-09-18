'use client';

import { useEffect, useRef, useState } from 'react';
import { api as clientApi } from '../../lib/api';
import type { MediaPolicy } from '../../types';
import { Icon, useToast } from '../ui';
import {
  captureImage,
  captureVideo,
  createAudioRecorder,
  pickAudio,
  type AudioRecording,
  type Position,
} from '../../lib/device';
import { usePreciseLocation, type PreciseLocationState } from '../../lib/useLocation';
import {
  MEDIA_DATAURL_MAX,
  MEDIA_TOTAL_MAX,
  dataUrlBytes,
  formatBytes,
  mediaLimitError,
} from '../../lib/uploadLimits';
import LocationBox from './LocationBox';

/**
 * Shared on-device capture for the supporter-facing forms.
 *
 * `useMediaDrafts()` owns the state + device calls (photo / video / voice note,
 * the attachment list and the optional GPS fix); `<MediaCapture>` is the
 * presentational control row + attachment chips driven by that state. Factored
 * out of `ReportToCouncillor` so the resident report, the case-log form and the
 * patrol overview report all capture media identically instead of each
 * re-implementing the recorder/cancel/fallback logic.
 *
 * The GPS fix rides along here because it is captured in the same control row
 * and comes from the same `lib/device` module; a form that does not need it
 * (e.g. a patrol, which already has track points) passes `showLocation={false}`.
 */

export type CaptureMode = 'photo' | 'video' | 'voice_note' | 'audio';

/** One captured attachment held in memory until the form submits. */
export interface MediaDraft {
  dataUrl: string;
  contentType: string;
  captureMode: CaptureMode;
}

/** The media payload shape every create/update endpoint accepts. */
export interface MediaPayloadItem {
  dataUrl: string;
  captureMode: CaptureMode;
}

export interface MediaDraftsApi {
  policy: MediaPolicy | null;
  policyError: string | null;
  /** Captured attachments, in capture order. */
  drafts: MediaDraft[];
  /** A voice note is currently recording. */
  recording: boolean;
  /** Per-file wire cap in bytes (mirrors the server's `dataUrl` max). */
  perFileMax: number;
  /** Combined cap for all attachments on one submission. */
  totalMax: number;
  /** How many attachments this form accepts. */
  maxFiles: number;
  /** Wire size of the attachments captured so far. */
  usedBytes: number;
  /** The last GPS fix, or null if location was never attached. */
  pos: Position | null;
  /** A GPS fix is being resolved right now. */
  locating: boolean;
  /** The full precise-location controller (live accuracy + street/area label). */
  location: PreciseLocationState;
  addPhoto: () => void;
  addVideo: () => void;
  toggleRecord: () => void;
  removeAt: (index: number) => void;
  attachLocation: () => void;
  /** Reset drafts + location + recording (call after a successful submit). */
  clear: () => void;
  /** The drafts shaped for an API `media` field. */
  payload: () => MediaPayloadItem[];
}

/**
 * @param maxFiles how many attachments the target endpoint accepts — 6 for a
 *   resident report, 10 for a patrol or a case log. Kept in sync by the caller
 *   because it is the server's `z.array(...).max(n)` that decides.
 */
export function useMediaDrafts(maxFiles = 6): MediaDraftsApi {
  const toast = useToast();
  const [drafts, setDrafts] = useState<MediaDraft[]>([]);
  const draftsRef = useRef<MediaDraft[]>([]);
  const [recording, setRecording] = useState(false);
  const location = usePreciseLocation(4);
  const recorderRef = useRef<AudioRecording | null>(null);
  const [policy, setPolicy] = useState<MediaPolicy | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const active = useRef(true);
  const captureBusy = useRef(false);
  useEffect(() => {
    active.current = true;
    const load = () => clientApi.mediaPolicy().then((p) => { if (active.current) { setPolicy(p); setPolicyError(null); } })
      .catch(() => { if (active.current) { setPolicy(null); setPolicyError('Media controls unavailable. Text reporting is still available.'); } });
    void load();
    window.addEventListener('focus', load);
    return () => { active.current = false; recorderRef.current?.cancel(); window.removeEventListener('focus', load); };
  }, []);
  const usedBytes = drafts.reduce((n, m) => n + dataUrlBytes(m.dataUrl), 0);

  /**
   * Accept a capture only if it fits: the count the endpoint allows, the
   * per-file cap, and the whole-submission budget. Rejecting here is the whole
   * point — an oversized attachment used to be discovered only on submit, as a
   * 413 the user saw as "internal server error".
   */
  function admit(m: { dataUrl: string; contentType: string }, captureMode: CaptureMode): boolean {
    if (!active.current) return false;
    const next = [...draftsRef.current, { ...m, captureMode }];
    const error = mediaLimitError(next.map((item) => dataUrlBytes(item.dataUrl)), maxFiles);
    if (error) {
      toast(error, 'err');
      return false;
    }
    draftsRef.current = next;
    setDrafts(next);
    return true;
  }

  async function addPhoto() {
    if (!policy?.photo || captureBusy.current) return;
    captureBusy.current = true;
    try {
      const m = await captureImage('camera');
      admit(m, 'photo');
    } catch (e: any) {
      if (!/cancel/i.test(e?.message ?? '')) toast(e?.message ?? 'Could not open the camera', 'err');
    } finally { captureBusy.current = false; }
  }

  async function addVideo() {
    if (!policy?.video || captureBusy.current) return;
    captureBusy.current = true;
    try {
      const m = await captureVideo('camera');
      admit(m, 'video');
    } catch (e: any) {
      if (!/cancel/i.test(e?.message ?? '')) toast(e?.message ?? 'Could not capture video', 'err');
    } finally { captureBusy.current = false; }
  }

  async function toggleRecord() {
    if ((!policy?.voice && !recording) || captureBusy.current) return;
    captureBusy.current = true;
    try {
      if (!recording) {
        const rec = createAudioRecorder(120, (media, error) => {
          if (!active.current || recorderRef.current !== rec) return;
          recorderRef.current = null;
          setRecording(false);
          if (media) admit(media, 'voice_note');
          if (error) toast(error.message, 'err');
        });
        if (!rec.supported()) {
          // No in-app recorder on this runtime → choose an existing audio file.
          const m = await pickAudio();
          admit(m, 'voice_note');
          return;
        }
        recorderRef.current = rec;
        try {
          await rec.start();
        } catch (startErr: any) {
          // The WebView may deny microphone access (permission not granted, or
          // no capture route on this de-Googled handset). Rather than dead-end
          // the user, fall back to attaching a recorded file so a voice note is
          // always possible.
          recorderRef.current = null;
          if (/cancel/i.test(startErr?.message ?? '')) return;
          toast('Microphone unavailable — pick a recorded voice note instead', 'err');
          const m = await pickAudio();
          admit(m, 'voice_note');
          return;
        }
        if (!active.current) { rec.cancel(); return; }
        setRecording(true);
        toast('Recording voice note… tap again to stop', 'ok');
      } else {
        const rec = recorderRef.current;
        const m = await rec?.stop();
        if (active.current) setRecording(false);
        if (recorderRef.current === rec) {
          recorderRef.current = null;
          if (m) admit(m, 'voice_note');
        }
      }
    } catch (e: any) {
      setRecording(false);
      recorderRef.current = null;
      if (!/cancel/i.test(e?.message ?? '') && active.current) toast(e?.message ?? 'Could not record audio', 'err');
    } finally { captureBusy.current = false; }
  }

  function removeAt(index: number) {
    draftsRef.current = draftsRef.current.filter((_, j) => j !== index);
    setDrafts(draftsRef.current);
  }

  function clear() {
    recorderRef.current?.cancel();
    draftsRef.current = [];
    setDrafts([]);
    location.reset();
    setRecording(false);
    recorderRef.current = null;
  }

  function payload(): MediaPayloadItem[] {
    if (recording || captureBusy.current) throw new Error('Finish capturing media before submitting.');
    if (draftsRef.current.some((m) => !policy?.[m.captureMode === 'photo' ? 'photo' : m.captureMode === 'video' ? 'video' : 'voice'])) {
      throw new Error('A selected media type is disabled. Remove that attachment to continue.');
    }
    const current = draftsRef.current;
    const error = mediaLimitError(current.map((m) => dataUrlBytes(m.dataUrl)), maxFiles);
    if (error) throw new Error(error);
    return current.map((m) => ({ dataUrl: m.dataUrl, captureMode: m.captureMode }));
  }

  return {
    policy,
    policyError,
    drafts,
    recording,
    perFileMax: MEDIA_DATAURL_MAX,
    totalMax: MEDIA_TOTAL_MAX,
    maxFiles,
    usedBytes,
    pos: location.pos,
    locating: location.locating,
    location,
    addPhoto,
    addVideo,
    toggleRecord,
    removeAt,
    attachLocation: location.start,
    clear,
    payload,
  };
}

export default function MediaCapture({
  api,
  showLocation = true,
}: {
  api: MediaDraftsApi;
  /** Hide the "Attach my location" button + GPS hint (e.g. patrols). */
  showLocation?: boolean;
}) {
  const {
    drafts,
    recording,
    location,
    addPhoto,
    addVideo,
    toggleRecord,
    removeAt,
    perFileMax,
    totalMax,
    maxFiles,
    usedBytes,
  } = api;
  const full = drafts.length >= maxFiles;
  return (
    <>
      {showLocation && <LocationBox loc={location} />}
      {api.policyError && <p role="alert">{api.policyError}</p>}
      {api.policy && (!api.policy.photo || !api.policy.video || !api.policy.voice) && <p className="hint-text">Some media types have been disabled by the administrator.</p>}

      <div className="chip-row" style={{ marginTop: 10 }}>
        <button className="btn btn-ghost btn-sm" onClick={addPhoto} disabled={full || !api.policy?.photo} title={!api.policy?.photo ? 'Photo capture disabled or unavailable' : undefined}>
          <Icon name="plus" size={15} /> Photo
        </button>
        <button className="btn btn-ghost btn-sm" onClick={addVideo} disabled={full || !api.policy?.video} title={!api.policy?.video ? 'Video capture disabled or unavailable' : undefined}>
          <Icon name="plus" size={15} /> Video
        </button>
        <button
          className={`btn btn-ghost btn-sm ${recording ? 'on' : ''}`}
          onClick={toggleRecord}
          disabled={(full || !api.policy?.voice) && !recording}
        >
          <Icon name={recording ? 'check' : 'plus'} size={15} /> {recording ? 'Stop voice note' : 'Voice note'}
        </button>
      </div>

      {/*
        State the caps before the user shoots a 30-second 4K video: the server
        rejects an oversized body outright, and an upload that fails on submit
        loses the whole form. The running total doubles as the progress the user
        needs to judge whether one more attachment will fit.
      */}
      <p className="upload-limit">
        Photo, video &amp; voice note: max {formatBytes(perFileMax)} encoded per file (about 6 MB original),
        {' '}{formatBytes(totalMax)} encoded total, up to {maxFiles} files. Voice recording: up to 2 minutes.
        {drafts.length > 0 && (
          <>
            {' '}
            <strong>
              Used {formatBytes(usedBytes)} of {formatBytes(totalMax)} ({drafts.length}/{maxFiles}).
            </strong>
          </>
        )}
        {full && ' Attachment limit reached — remove one to add another.'}
      </p>

      {drafts.length > 0 && (
        <div className="chip-row" style={{ marginTop: 10 }}>
          {drafts.map((m, i) => (
            <span key={i} className="chip on" style={{ position: 'relative', paddingRight: 26 }}>
              {m.contentType.startsWith('image/') ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={m.dataUrl}
                  alt={`attachment ${i + 1}`}
                  style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 6 }}
                />
              ) : (
                <span style={{ textTransform: 'capitalize' }}>{m.captureMode.replace('_', ' ')}</span>
              )}
              <span className="chip-size">{formatBytes(dataUrlBytes(m.dataUrl))}</span>
              <button
                aria-label="Remove attachment"
                onClick={() => removeAt(i)}
                style={{ position: 'absolute', right: 4, top: 4, border: 0, background: 'transparent', cursor: 'pointer' }}
              >
                <Icon name="x" size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
