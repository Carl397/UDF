'use client';

import { useEffect, useRef, useState } from 'react';
import { API_BASE, tokenStore } from './api';
import type { PlatformSnapshot } from './api';

/**
 * Battery-safe live status for the SuperAdmin ops dashboard.
 *
 * The ops surface is a supervised screen, not something to leave burning a phone
 * battery overnight, so this hook deliberately:
 *   - opens the SSE stream ONLY while the tab is visible (Page Visibility API),
 *     aborting the request the moment it is hidden and reconnecting when shown;
 *   - uses `fetch` + a `ReadableStream` rather than `EventSource`, because the
 *     stream is gated on a bearer token and `EventSource` cannot set headers;
 *   - treats a drop as normal and reconnects with exponential backoff, staying
 *     quiet (no error banner) for a transient blip on a screen that is designed
 *     to be always-implicit.
 *
 * `enabled` lets the caller (a page gated on `platform:read`) hold the connection
 * closed entirely until it knows the session may view it.
 */
export interface LiveState {
  snapshot: PlatformSnapshot | null;
  connected: boolean;
  /** Epoch ms of the last frame, so the UI can flag a stale panel. */
  lastAt: number | null;
}

const MAX_BACKOFF_MS = 30_000;

export function usePlatformLive(enabled: boolean): LiveState {
  const [snapshot, setSnapshot] = useState<PlatformSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let backoff = 1_000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const parseFrames = (buffer: string): { rest: string; payloads: string[] } => {
      // SSE frames are separated by a blank line. Keep the trailing partial.
      const parts = buffer.split('\n\n');
      const rest = parts.pop() ?? '';
      const payloads: string[] = [];
      for (const frame of parts) {
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) payloads.push(line.slice(5).trim());
        }
      }
      return { rest, payloads };
    };

    const open = async () => {
      if (disposed || document.visibilityState !== 'visible') return;
      const token = tokenStore.access;
      if (!token) return;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(`${API_BASE}/crm/superadmin/stream`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        setConnected(true);
        backoff = 1_000; // a successful open resets the backoff ladder
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { rest, payloads } = parseFrames(buffer);
          buffer = rest;
          for (const p of payloads) {
            try {
              setSnapshot(JSON.parse(p) as PlatformSnapshot);
              setLastAt(Date.now());
            } catch {
              /* a malformed frame is dropped; the next tick self-heals */
            }
          }
        }
      } catch {
        /* aborted on hide/unmount, or a network drop — both retried below */
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
        setConnected(false);
        if (!disposed && document.visibilityState === 'visible') {
          const wait = backoff;
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          reconnectTimer = setTimeout(() => void open(), wait);
        }
      }
    };

    const close = () => {
      abortRef.current?.abort();
      abortRef.current = null;
      setConnected(false);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        backoff = 1_000;
        void open();
      } else {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        close();
      }
    };

    if (document.visibilityState === 'visible') void open();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      close();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);

  return { snapshot, connected, lastAt };
}
