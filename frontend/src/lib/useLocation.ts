'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { watchPosition, type Position, type WatchHandle } from './device';
import { api } from './api';
import type { ReverseGeocodeResult } from '../types';

/**
 * A precise-location capture hook shared by the resident report and the patrol
 * "add stop" flow.
 *
 * Rather than take a single (often coarse) GPS reading, it opens a high-accuracy
 * `watchPosition`, keeps the *best* fix seen so far, and shows the live accuracy
 * so the user can see it tighten. It settles automatically the moment the fix is
 * within `targetM` metres (default 4 m), or when the user accepts the current
 * fix, or after `maxWaitMs` as a safety net. On settling it reverse-geocodes the
 * point to a { street, area } label for display. All work is torn down on reset
 * and on unmount so a dismissed form never keeps the GPS awake.
 */
export interface PreciseLocationState {
  /** The best fix so far (updates live while locating). */
  pos: Position | null;
  /** Street + area for the settled fix, or null until resolved / unavailable. */
  place: ReverseGeocodeResult | null;
  /** A fix is actively being tightened. */
  locating: boolean;
  /** The address for the settled fix is being resolved. */
  geocoding: boolean;
  /** A fix has been locked in (target reached, accepted, or timed out). */
  settled: boolean;
  /** The accuracy target in metres. */
  targetM: number;
  /** True once the settled fix meets the accuracy target. */
  accurate: boolean;
  error: string | null;
  /** Begin (or restart) tightening a fix. */
  start: () => void;
  /** Lock in the current best fix now, without waiting for the target. */
  accept: () => void;
  /** Clear the fix, label and any live watch. */
  reset: () => void;
}

export function usePreciseLocation(targetM = 4, maxWaitMs = 45000): PreciseLocationState {
  const [pos, setPos] = useState<Position | null>(null);
  const [place, setPlace] = useState<ReverseGeocodeResult | null>(null);
  const [locating, setLocating] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const watchRef = useRef<WatchHandle | null>(null);
  const bestRef = useRef<Position | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settledRef = useRef(false);
  const sessionRef = useRef(0);

  const teardown = useCallback(() => {
    watchRef.current?.clear();
    watchRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const geocode = useCallback(async (p: Position) => {
    const session = sessionRef.current;
    setGeocoding(true);
    try {
      const result = await api.reverseGeocode(p.lat, p.lng, p.accuracyM);
      if (session === sessionRef.current) setPlace(result);
    } catch {
      // Best-effort: keep the coordinates even if the label lookup fails.
    } finally {
      if (session === sessionRef.current) setGeocoding(false);
    }
  }, []);

  const finish = useCallback(
    (p: Position) => {
      if (settledRef.current) return;
      settledRef.current = true;
      teardown();
      setPos(p);
      setSettled(true);
      setLocating(false);
      void geocode(p);
    },
    [teardown, geocode],
  );

  const start = useCallback(() => {
    const session = ++sessionRef.current;
    teardown();
    setGeocoding(false);
    settledRef.current = false;
    bestRef.current = null;
    setPos(null);
    setPlace(null);
    setError(null);
    setSettled(false);
    setLocating(true);
    void (async () => {
      try {
        const handle = await watchPosition(
          (p) => {
            if (session !== sessionRef.current || settledRef.current) return;
            const prev = bestRef.current;
            // Keep the tightest fix seen; only surface improvements.
            if (!prev || (p.accuracyM ?? 9999) <= (prev.accuracyM ?? 9999)) {
              bestRef.current = p;
              setPos(p);
            }
            if ((p.accuracyM ?? 9999) <= targetM) finish(bestRef.current ?? p);
          },
          (err) => {
            if (session === sessionRef.current && !settledRef.current) setError(err.message || 'Location unavailable');
          },
          { accuracyM: targetM, intervalMs: 1000 },
        );
        // The target may have been hit before the watch handle resolved.
        if (session !== sessionRef.current || settledRef.current) {
          handle.clear();
          return;
        }
        watchRef.current = handle;
        timerRef.current = setTimeout(() => {
          if (bestRef.current) finish(bestRef.current);
          else {
            teardown();
            setLocating(false);
            setError('Could not get a precise fix — try again outdoors.');
          }
        }, maxWaitMs);
      } catch (e: any) {
        if (session !== sessionRef.current) return;
        setLocating(false);
        setError(e?.message ?? 'Location permission denied');
      }
    })();
  }, [teardown, finish, targetM, maxWaitMs]);

  const accept = useCallback(() => {
    if (bestRef.current) finish(bestRef.current);
  }, [finish]);

  const reset = useCallback(() => {
    ++sessionRef.current;
    teardown();
    setGeocoding(false);
    settledRef.current = false;
    bestRef.current = null;
    setPos(null);
    setPlace(null);
    setError(null);
    setSettled(false);
    setLocating(false);
  }, [teardown]);

  useEffect(() => () => {
    ++sessionRef.current;
    teardown();
  }, [teardown]);

  const accurate = settled && pos != null && (pos.accuracyM ?? 9999) <= targetM;

  return { pos, place, locating, geocoding, settled, targetM, accurate, error, start, accept, reset };
}
