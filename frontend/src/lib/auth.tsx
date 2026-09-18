'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ensureModules, ensurePermissions, onSessionChange, tokenStore } from './api';
import type { Permission, Role } from '../types';

interface Profile {
  role: Role | null;
  email: string | null;
  regionCodes: string[];
  /** Ward this principal is scoped to (member / ward_councillor). */
  wardCode: string | null;
}

interface AuthState extends Profile {
  ready: boolean;
  authenticated: boolean;
  /** Whether the signed-in user has accepted the current Terms version. */
  tcAccepted: boolean;
  tcCurrentVersion: string | null;
  /** Whether the account must set a new password before using the app. */
  mustChangePassword: boolean;
  /**
   * The permissions the server granted this session, sent with the
   * login/refresh response and recomputed on every rotation.
   *
   * This is the authority for what the UI offers: `lib/caps.ts` turns it into
   * the capability flags, and the desktop CRM gates its navigation on it. An
   * empty array means "nothing is authorised yet" — either anonymously, mid-load,
   * or because the server said so — and every consumer fails closed on it.
   */
  permissions: Permission[];
  /**
   * The module keys enabled for this session, sent alongside `permissions`.
   * Permission-backed modules are already reflected in `permissions` (a disabled
   * module's permissions are stripped server-side); this list drives the UI-only
   * surfaces that own no permission (`id_cards`) via `lib/modules.ts` `moduleOn`,
   * and any explicit "module disabled" empty-state. Empty until loaded — every
   * consumer fails closed on it, exactly like `permissions`.
   */
  modules: string[];
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  acceptTerms: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

/** Decode the JWT payload (no verification — the server is the source of truth). */
function decodeProfile(token: string | null): Profile {
  // A silently refreshed token carries role and region scope but no email claim,
  // so fall back to the address this browser signed in with.
  const email = tokenStore.email;
  if (!token) return { role: null, email, regionCodes: [], wardCode: null };
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return {
      role: (payload.role as Role) ?? null,
      email: (payload.email as string) ?? email,
      regionCodes: Array.isArray(payload.regionCodes) ? payload.regionCodes : [],
      wardCode: (payload.wardCode as string) ?? null,
    };
  } catch {
    return { role: null, email, regionCodes: [], wardCode: null };
  }
}

/** T&C state as persisted at last login (the gate is met when the versions match). */
function decodeTc(): { tcAccepted: boolean; tcCurrentVersion: string | null } {
  const current = tokenStore.tcCurrentVersion;
  const accepted = tokenStore.tcAcceptedVersion;
  return { tcAccepted: Boolean(accepted && current && accepted === current), tcCurrentVersion: current };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<Profile>({ role: null, email: null, regionCodes: [], wardCode: null });
  const [authenticated, setAuthenticated] = useState(false);
  const [tc, setTc] = useState<{ tcAccepted: boolean; tcCurrentVersion: string | null }>({
    tcAccepted: false,
    tcCurrentVersion: null,
  });
  const [mustChange, setMustChange] = useState(false);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [modules, setModules] = useState<string[]>([]);

  /**
   * Adopt a permission list without churning array identity when the contents
   * are unchanged. `AppShell` memoises its capability flags on this array, so a
   * new-but-equal array on every session ping would re-render the whole shell —
   * and this is called from two paths at once (an explicit `ensurePermissions`
   * and the session-change listener that the refresh emits), which makes the
   * dedupe load-bearing rather than merely tidy.
   */
  const applyPermissions = useCallback((next: Permission[] | null) => {
    setPermissions((prev) => {
      const value = next ?? [];
      const unchanged =
        prev.length === value.length && prev.every((p, i) => p === value[i]);
      return unchanged ? prev : value;
    });
  }, []);

  /**
   * Adopt an enabled-module list without churning array identity, for the same
   * reason as `applyPermissions`: the shell memoises on it, and two paths (an
   * explicit `ensureModules` and the session-change listener) can set it at once.
   */
  const applyModules = useCallback((next: string[] | null) => {
    setModules((prev) => {
      const value = next ?? [];
      const unchanged =
        prev.length === value.length && prev.every((m, i) => m === value[i]);
      return unchanged ? prev : value;
    });
  }, []);

  useEffect(() => {
    const token = tokenStore.access;
    setProfile(decodeProfile(token));
    setAuthenticated(Boolean(token));
    setTc(decodeTc());
    setMustChange(tokenStore.mustChangePassword);
    applyPermissions(tokenStore.permissions);
    applyModules(tokenStore.modules);
    setReady(true);

    // A session signed in before the server started sending permissions has
    // none stored. Ask for them once instead of failing a valid session closed
    // until its access token happens to lapse. The module list heals the same
    // way, so a pre-existing session is not failed closed on its UI-only
    // surfaces (`id_cards`) either.
    let cancelled = false;
    if (token && tokenStore.permissions === null) {
      void ensurePermissions().then((granted) => {
        if (!cancelled) applyPermissions(granted);
      });
    }
    if (token && tokenStore.modules === null) {
      void ensureModules().then((enabled) => {
        if (!cancelled) applyModules(enabled);
      });
    }

    // The access token can be swapped underneath us: a silent refresh after the
    // 15-minute expiry replaces it, and a refused refresh clears it. Role, email
    // and region scope are claims inside that token, so re-derive them every time
    // it changes — otherwise the shell keeps gating the UI on a stale identity.
    // Permissions and modules ride along: `refreshAccessToken` stores the
    // server's current lists before it emits, so a role or module-registry change
    // lands here without a re-login.
    const unsubscribe = onSessionChange((accessToken) => {
      setProfile(decodeProfile(accessToken));
      setAuthenticated(Boolean(accessToken));
      applyPermissions(accessToken ? tokenStore.permissions : null);
      applyModules(accessToken ? tokenStore.modules : null);
      if (!accessToken) {
        setTc({ tcAccepted: false, tcCurrentVersion: null });
        setMustChange(false);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyPermissions, applyModules]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    setProfile(decodeProfile(res.accessToken));
    setAuthenticated(true);
    setTc({ tcAccepted: res.tcAccepted, tcCurrentVersion: res.tcCurrentVersion });
    setMustChange(res.mustChangePassword);
    applyPermissions(res.permissions);
    applyModules(res.enabledModules);
  }, [applyPermissions, applyModules]);

  const logout = useCallback(async () => {
    await api.logout();
    setProfile({ role: null, email: null, regionCodes: [], wardCode: null });
    setAuthenticated(false);
    setTc({ tcAccepted: false, tcCurrentVersion: null });
    setMustChange(false);
    applyPermissions(null);
    applyModules(null);
  }, [applyPermissions, applyModules]);

  const acceptTerms = useCallback(async () => {
    const res = await api.acceptTerms();
    tokenStore.setTc(res.tcVersion, res.tcVersion);
    setTc({ tcAccepted: true, tcCurrentVersion: res.tcVersion });
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await api.changePassword(currentPassword, newPassword);
    // The server rotated the token pair (a password change revokes the old
    // tokens); api.changePassword already persisted them, so re-derive identity
    // from the new access token and clear the first-login gate.
    setProfile(decodeProfile(res.accessToken));
    setAuthenticated(true);
    setTc({ tcAccepted: res.tcAccepted, tcCurrentVersion: res.tcCurrentVersion });
    setMustChange(false);
    applyPermissions(res.permissions);
    applyModules(res.enabledModules);
  }, [applyPermissions, applyModules]);

  const value = useMemo(
    () => ({
      ready,
      authenticated,
      ...profile,
      ...tc,
      mustChangePassword: mustChange,
      permissions,
      modules,
      login,
      logout,
      acceptTerms,
      changePassword,
    }),
    [ready, authenticated, profile, tc, mustChange, permissions, modules, login, logout, acceptTerms, changePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
