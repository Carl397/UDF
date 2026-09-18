import { Capacitor } from '@capacitor/core';
import { MEDIA_DATAURL_MAX, formatBytes } from './uploadLimits';

/**
 * Cross-platform device primitives: a stable device id (for device-level
 * bans), geolocation, camera/mic/gallery capture, and native share.
 *
 * On a native (Capacitor) shell these use the native plugins; on the web they
 * fall back to standard browser APIs so the same UI code runs in both. All
 * plugin imports are dynamic so nothing native is pulled into the web/SSR
 * bundle, and callers stay in `'use client'` components.
 */

export interface Position {
  lat: number;
  lng: number;
  accuracyM?: number;
}

export interface CapturedMedia {
  /** RFC2397 data URL — safe to hand straight to an upload or a canvas. */
  dataUrl: string;
  contentType: string;
}

const DEVICE_ID_KEY = 'udf.device.id';

export function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * A stable per-install identifier. Sent as `x-device-id` on auth calls so a
 * banned device cannot simply re-register with a new account. Persisted in
 * native Preferences (survives app restart) or localStorage on the web.
 */
export async function getDeviceId(): Promise<string> {
  try {
    if (isNative()) {
      const { Preferences } = await import('@capacitor/preferences');
      const { value } = await Preferences.get({ key: DEVICE_ID_KEY });
      if (value) return value;
      const id = uuid();
      await Preferences.set({ key: DEVICE_ID_KEY, value: id });
      return id;
    }
    if (typeof localStorage !== 'undefined') {
      const existing = localStorage.getItem(DEVICE_ID_KEY);
      if (existing) return existing;
      const id = uuid();
      localStorage.setItem(DEVICE_ID_KEY, id);
      return id;
    }
  } catch {
    // fall through to an ephemeral id
  }
  return uuid();
}

/**
 * The Capacitor Geolocation plugin talks to Google Play Services
 * (FusedLocationProviderClient). On de-Googled handsets, most emulator images,
 * and Huawei/AOSP builds that fix throws "Google Play services not available".
 * The WebView's own `navigator.geolocation` uses the Android LocationManager
 * directly — no Play Services needed — and Capacitor's WebChromeClient grants
 * it the geolocation permission from the app's ACCESS_FINE/COARSE_LOCATION
 * grants. So when the native plugin fails we fall back to the WebView path,
 * which works on exactly the devices the plugin can't serve.
 */
function isPlayServicesError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e ?? '')).toLowerCase();
  return (
    msg.includes('play services') ||
    msg.includes('play service') ||
    msg.includes('google play') ||
    msg.includes('googleplay') ||
    msg.includes('not available') ||
    msg.includes('unavailable')
  );
}

/** WebView/browser geolocation fix via `navigator.geolocation` (no Play Services). */
function getCurrentPositionWeb(): Promise<Position> {
  return new Promise<Position>((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      reject(new Error('Geolocation is not available on this device'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy }),
      (e) => reject(new Error(e?.message || 'Location permission denied')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

/** High-accuracy geolocation fix (ward lookup / tagging a report). */
export async function getCurrentPosition(): Promise<Position> {
  if (isNative()) {
    try {
      const { Geolocation } = await import('@capacitor/geolocation');
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 30000,
      });
      return {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyM: pos.coords.accuracy ?? undefined,
      };
    } catch (e) {
      // Play Services missing → the WebView LocationManager path still works.
      if (!isPlayServicesError(e)) throw e;
      return getCurrentPositionWeb();
    }
  }
  return getCurrentPositionWeb();
}

/** A live geolocation subscription handle. Call `clear()` to stop watching. */
export interface WatchHandle {
  clear(): void;
}

/**
 * A continuous geolocation watch for the patrol live-tracker. Native uses the
 * Capacitor Geolocation plugin's `watchPosition`; the web uses
 * `navigator.geolocation.watchPosition`. Resolves once the watch is registered
 * and returns a handle whose `clear()` stops it (idempotent). Each fix is fed
 * to `onPosition`; `onError` receives permission/unavailable failures without
 * tearing down the watch (the runtime may recover).
 */
export async function watchPosition(
  onPosition: (pos: Position) => void,
  onError?: (err: Error) => void,
  opts?: { accuracyM?: number; intervalMs?: number },
): Promise<WatchHandle> {
  const enableHighAccuracy = (opts?.accuracyM ?? 25) <= 50;
  if (isNative()) {
    try {
      const { Geolocation } = await import('@capacitor/geolocation');
      let cleared = false;
      let fellBack = false;
      let webHandle: WatchHandle | null = null;
      const id = await Geolocation.watchPosition(
        { enableHighAccuracy, timeout: 20000, maximumAge: (opts?.intervalMs ?? 5000) },
        (pos, err) => {
          if (cleared || fellBack) return;
          if (err) {
            // Play Services dropped out mid-watch → swap to the WebView watch,
            // which uses the LocationManager and keeps tracking.
            if (isPlayServicesError(err)) {
              fellBack = true;
              void Geolocation.clearWatch({ id });
              void watchPositionWeb(onPosition, onError, opts).then((h) => {
                if (cleared) h.clear();
                else webHandle = h;
              });
              return;
            }
            onError?.(new Error(err.message || 'Location watch failed'));
            return;
          }
          if (pos?.coords) {
            onPosition({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              accuracyM: pos.coords.accuracy ?? undefined,
            });
          }
        },
      );
      return {
        clear() {
          if (cleared) return;
          cleared = true;
          if (webHandle) webHandle.clear();
          else void Geolocation.clearWatch({ id });
        },
      };
    } catch (e) {
      // Play Services unavailable at registration → use the WebView watch.
      if (!isPlayServicesError(e)) throw e;
      return watchPositionWeb(onPosition, onError, opts);
    }
  }
  return watchPositionWeb(onPosition, onError, opts);
}

/** WebView/browser continuous watch via `navigator.geolocation` (no Play Services). */
function watchPositionWeb(
  onPosition: (pos: Position) => void,
  onError?: (err: Error) => void,
  opts?: { accuracyM?: number; intervalMs?: number },
): Promise<WatchHandle> {
  const enableHighAccuracy = (opts?.accuracyM ?? 25) <= 50;
  return new Promise<WatchHandle>((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      reject(new Error('Geolocation is not available on this device'));
      return;
    }
    let cleared = false;
    const id = navigator.geolocation.watchPosition(
      (p) =>
        onPosition({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy }),
      (e) => {
        const err = new Error(e?.message || 'Location permission denied');
        if (onError) onError(err);
        else reject(err);
      },
      { enableHighAccuracy, timeout: 20000, maximumAge: (opts?.intervalMs ?? 5000) },
    );
    resolve({
      clear() {
        if (cleared) return;
        cleared = true;
        navigator.geolocation.clearWatch(id);
      },
    });
  });
}

/** Read a File/Blob as a data URL. */
export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('Could not read the file'));
    fr.readAsDataURL(file);
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',');
  const mime = /data:(.*?);/.exec(head ?? '')?.[1] ?? 'application/octet-stream';
  const bin = atob(b64 ?? '');
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Open the system file picker / camera via an <input type="file">. */
function pickFileWeb(accept: string, capture?: 'user' | 'environment'): Promise<CapturedMedia> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('File capture is not available here'));
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    if (capture) input.setAttribute('capture', capture);
    input.style.display = 'none';
    input.onchange = async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) {
        reject(new Error('No file was selected'));
        return;
      }
      try {
        const encodedSize = `data:${file.type || 'application/octet-stream'};base64,`.length + 4 * Math.ceil(file.size / 3);
        if (encodedSize > MEDIA_DATAURL_MAX) {
          throw new Error(`Maximum ${formatBytes(MEDIA_DATAURL_MAX)} encoded per file (about 6 MB original). Choose a smaller file or shorter recording.`);
        }
        resolve({ dataUrl: await fileToDataUrl(file), contentType: file.type || accept });
      } catch (error) {
        reject(error);
      }
    };
    // If the user dismisses the picker, don't hang forever.
    input.oncancel = () => {
      input.remove();
      reject(new Error('Capture cancelled'));
    };
    document.body.appendChild(input);
    input.click();
  });
}

/** Take or choose a photo. Native uses the Camera plugin; web uses a file input. */
export async function captureImage(source: 'camera' | 'gallery' = 'camera'): Promise<CapturedMedia> {
  if (isNative()) {
    const { Camera, CameraSource, CameraResultType } = await import('@capacitor/camera');
    const photo = await Camera.getPhoto({
      source: source === 'camera' ? CameraSource.Camera : CameraSource.Photos,
      resultType: CameraResultType.DataUrl,
      quality: 82,
      correctOrientation: true,
      width: 1600,
    });
    if (!photo.dataUrl) throw new Error('No image was returned');
    return { dataUrl: photo.dataUrl, contentType: `image/${photo.format ?? 'jpeg'}` };
  }
  return pickFileWeb('image/*', source === 'camera' ? 'environment' : undefined);
}

/** Record or choose a video. Uses the system picker/camera on both platforms. */
export async function captureVideo(source: 'camera' | 'gallery' = 'camera'): Promise<CapturedMedia> {
  return pickFileWeb('video/*', source === 'camera' ? 'environment' : undefined);
}

/** Choose an audio file (voice note). In-browser recording is `recordAudio`. */
export async function pickAudio(): Promise<CapturedMedia> {
  return pickFileWeb('audio/*');
}

export interface AudioRecording {
  start(): Promise<void>;
  stop(): Promise<CapturedMedia>;
  cancel(): void;
  supported(): boolean;
}

/**
 * A minimal MediaRecorder-based voice-note recorder. Works in the WebView
 * (RECORD_AUDIO permission) and in the browser. `supported()` reports whether
 * the runtime can record at all so callers can fall back to `pickAudio()`.
 */
export function createAudioRecorder(maxSeconds = 120, onAutoStop?: (media: CapturedMedia | null, error?: Error) => void): AudioRecording {
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let stopping: Promise<CapturedMedia> | null = null;
  const release = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };
  const cancel = () => {
    cancelled = true;
    if (recorder?.state === 'recording') recorder.stop();
    release();
  };

  const supported = () =>
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';

  /** The first container/codec this runtime can actually record, or ''. */
  const pickMimeType = (): string => {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return '';
    }
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/aac'];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  };

  const stop = (): Promise<CapturedMedia> => {
    if (stopping) return stopping;
    stopping = new Promise<CapturedMedia>((resolve, reject) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!recorder || recorder.state === 'inactive') {
        release();
        reject(new Error('Recording was not started'));
        return;
      }
      recorder.onstop = async () => {
        release();
        try {
          if (cancelled) throw new Error('Recording cancelled');
          const type = (recorder?.mimeType || 'audio/webm').split(';')[0]!;
          const blob = new Blob(chunks, { type });
          if (!blob.size) throw new Error('No audio was captured');
          if (4 * Math.ceil(blob.size / 3) + 100 > MEDIA_DATAURL_MAX) throw new Error('Voice note is too large. Record a shorter note.');
          resolve({ dataUrl: await fileToDataUrl(blob), contentType: type });
        } catch (error) { reject(error); }
      };
      recorder.onerror = () => { release(); reject(new Error('Audio recording failed')); };
      try { recorder.stop(); } catch (error) { release(); reject(error); }
    });
    return stopping;
  };

  const start = async (): Promise<void> => {
    if (!supported()) throw new Error('Audio recording is not supported on this device');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cancelled) throw new Error('Recording cancelled');
      chunks = [];
      const mimeType = pickMimeType();
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onerror = () => { release(); onAutoStop?.(null, new Error('Audio recording failed')); };
    // A 1s timeslice makes `ondataavailable` fire progressively, so a very short
    // note (stopped almost immediately) still yields a chunk on WebViews that
    // otherwise only flush on stop.
    recorder.start(1000);
      if (maxSeconds > 0) timer = setTimeout(() => {
        void stop().then((media) => { if (!cancelled) onAutoStop?.(media); },
          (error) => { if (!cancelled) onAutoStop?.(null, error); });
      }, maxSeconds * 1000);
    } catch (error) { release(); throw error; }
  };

  return { supported, start, stop, cancel };
}

/**
 * Share an image (e.g. the supporter card) via the native share sheet or the
 * Web Share API. Returns true if a share path was available. WhatsApp /
 * Facebook appear automatically in the OS share sheet on the device.
 */
export async function shareImage(dataUrl: string, text: string, title?: string): Promise<boolean> {
  const shareTitle = title ?? 'I support the UDF';
  if (isNative()) {
    const [{ Share }, { Filesystem, Directory }] = await Promise.all([
      import('@capacitor/share'),
      import('@capacitor/filesystem'),
    ]);
    const base64 = dataUrl.split(',')[1] ?? '';
    const path = `udf-share-${Date.now()}.png`;
    await Filesystem.writeFile({ path, data: base64, directory: Directory.Cache });
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    await Share.share({ title: shareTitle, text, url: uri, dialogTitle: shareTitle });
    return true;
  }
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    const blob = dataUrlToBlob(dataUrl);
    const file = new File([blob], 'udf-support.png', { type: blob.type });
    const canShareFile =
      typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
    await navigator.share(canShareFile ? { files: [file], text, title: shareTitle } : { text, title: shareTitle });
    return true;
  }
  return false;
}

/**
 * Persist an image to the device (the consented "save" path for the supporter
 * card). Native writes to the public Documents directory (a `UDF/` subfolder,
 * visible to other apps); the web triggers a download. Returns true if a save
 * path was available.
 */
export async function saveImage(dataUrl: string, filename: string): Promise<boolean> {
  if (isNative()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const base64 = dataUrl.split(',')[1] ?? '';
    await Filesystem.writeFile({
      path: `UDF/${filename}`,
      data: base64,
      directory: Directory.Documents,
      recursive: true,
    });
    return true;
  }
  if (typeof document !== 'undefined') {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }
  return false;
}
