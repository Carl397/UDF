'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { AppLauncher } from '@capacitor/app-launcher';
import { Preferences } from '@capacitor/preferences';
import { API_BASE } from '../lib/api';
import { UpdateController, type UpdateState } from '../lib/appUpdates';

const idle: UpdateState = { available: null, busy: false, message: '' };
const UpdateContext = createContext({ ...idle, native: false, version: '', build: '', check: () => {} });
export const useAppUpdate = () => useContext(UpdateContext);

export default function AppUpdateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(idle);
  const [native, setNative] = useState(false);
  const [info, setInfo] = useState({ version: '', build: '' });
  const [blocked, setBlocked] = useState(true);
  const controller = useRef<UpdateController>();
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;
    let stopped = false;
    let nativeActive = true;
    let stateEvents = 0;
    const handles: PluginListenerHandle[] = [];
    const active = () => controller.current?.setActive(nativeActive && document.visibilityState === 'visible');
    const online = () => { void controller.current?.check(); };
    setNative(true);
    void (async () => {
      try {
        const installed = await App.getInfo();
        if (stopped) return;
        if (installed.id !== 'com.udf.party' || !/^[1-9][0-9]*$/.test(installed.build)) throw new Error('Unknown native identity');
        setInfo({ version: installed.version, build: installed.build });
        const ctl = new UpdateController(Number(installed.build), {
          fetchUpdate: async (signal) => {
            const response = await fetch(`${API_BASE}/public/app-update`, { signal, cache: 'no-store', credentials: 'omit' });
            if (!response.ok) throw new Error('Update check unavailable');
            return response.json();
          },
          getPreference: async (key) => (await Preferences.get({ key })).value,
          setPreference: (key, value) => Preferences.set({ key, value }),
          openUrl: async (url) => (await AppLauncher.openUrl({ url })).completed,
          online: () => navigator.onLine,
          changed: (value) => { if (!stopped) setState(value); },
        });
        controller.current = ctl;
        const handle = await App.addListener('appStateChange', ({ isActive }) => {
          stateEvents++; nativeActive = isActive; active();
        });
        if (stopped) { await handle.remove(); ctl.stop(); return; }
        handles.push(handle);
        const before = stateEvents;
        const current = await App.getState();
        if (stopped) return;
        if (stateEvents === before) nativeActive = current.isActive;
        document.addEventListener('visibilitychange', active);
        window.addEventListener('online', online);
        active();
      } catch {
        if (!stopped) setState({ ...idle, message: 'Native version information is unavailable. Restart the app to check for updates.' });
      }
    })();
    return () => {
      stopped = true; controller.current?.stop(); controller.current = undefined;
      document.removeEventListener('visibilitychange', active); window.removeEventListener('online', online);
      handles.forEach((handle) => { void handle.remove(); });
    };
  }, []);

  useEffect(() => {
    if (!native) return;
    // Wait for existing sheets/dialogs and the startup splash. Never put a
    // release notice on top of a member's current confirmation flow.
    const inspect = () => setBlocked(Boolean(document.querySelector(
      'dialog[open]:not(.app-update-dialog), [aria-modal="true"]:not(.app-update-dialog), [data-app-splash]',
    )));
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal'] });
    inspect();
    return () => observer.disconnect();
  }, [native]);

  return <UpdateContext.Provider value={{ ...state, native, ...info, check: () => { void controller.current?.check(true); } }}>
    {children}
    {native && !blocked && state.available && controller.current && <UpdateDialog state={state} controller={controller.current} />}
  </UpdateContext.Provider>;
}

function UpdateDialog({ state, controller }: { state: UpdateState; controller: UpdateController }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    el.showModal();
    // Register only while this dialog owns Back; removing restores Capacitor's
    // normal history/back behavior. Handle asynchronous registration cleanup.
    let gone = false;
    let handle: PluginListenerHandle | undefined;
    void App.addListener('backButton', () => { void controller.later(); }).then((h) => {
      if (gone) void h.remove(); else handle = h;
    }).catch(() => {});
    return () => {
      gone = true; void handle?.remove(); el.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [controller]);
  const a = state.available!;
  return <dialog ref={ref} className="app-update-dialog" aria-modal="true" aria-labelledby="app-update-title" aria-describedby="app-update-instructions"
    onCancel={(event) => { event.preventDefault(); void controller.later(); }}>
    <h2 id="app-update-title">UDF Party update available</h2>
    <p>Version {a.versionName} · build {a.versionCode} · {(a.bytes / 1_000_000).toFixed(1)} MB</p>
    <p className="app-update-notes">{a.notes}</p>
    <p id="app-update-instructions">Download the official APK, then approve installation in Android. A compatible signed installation updates without uninstalling. Do not uninstall to update.</p>
    {state.message && <p role="status">{state.message}</p>}
    <div className="ward-change-actions">
      <button type="button" className="btn btn-primary" disabled={state.busy} onClick={() => { void controller.download(); }}>Download update</button>
      <button type="button" className="btn btn-ghost" onClick={() => { void controller.later(); }}>Later</button>
    </div>
  </dialog>;
}
