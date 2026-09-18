'use client';

/**
 * Lightweight client preferences, persisted to localStorage.
 * Written by Settings and read by the notification opt-ins.
 */

export interface Prefs {
  pushNotifications: boolean;
  rallyAlerts: boolean;
  weeklyDigest: boolean;
  communityNotes: boolean;
  mandateAlerts: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  pushNotifications: true,
  rallyAlerts: true,
  weeklyDigest: false,
  communityNotes: true,
  mandateAlerts: true,
};

const KEY = 'udf.prefs.v1';

export function loadPrefs(): Prefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable (private mode) — prefs stay in-memory for the session */
  }
  return next;
}
