/**
 * Client-side view of the module registry.
 *
 * A "module" is a whole feature surface an administrator can switch off per role
 * (CRM → Settings → Module registry). Most modules are permission-backed:
 * disabling one strips its permissions server-side (`effectivePermissions`), so
 * `lib/caps.ts` already flips the matching capability off and the surface hides
 * with no help from this file.
 *
 * This file exists for the ONE module that owns no permission — `id_cards`,
 * which rides on `member:read` — and for an explicit "module disabled"
 * empty-state. Those surfaces must ask `moduleOn(enabledModules, key)` directly,
 * because there is no stripped permission for `deriveCaps` to react to.
 *
 * `enabledModules` is the list the server sent at login/refresh (mirrored in
 * `tokenStore.modules`, healed by `ensureModules()`). Fail closed: an absent or
 * malformed list yields no UI-only modules, exactly as `deriveCaps` fails closed
 * on an absent permission list — a surface stays hidden rather than flashing a
 * control the server would 403.
 */

/**
 * The module keys, mirrored from `backend/src/auth/permissions.ts` `ModuleKey`.
 * Only the UI-only ones are consulted through `moduleOn` today; the full set is
 * mirrored so the registry editor and any future UI-only surface share one
 * vocabulary, and so a typo is a compile error rather than a silent `false`.
 */
export const ModuleKey = {
  MAP: 'map',
  MEMBERS: 'members',
  CASES: 'cases',
  PATROLS: 'patrols',
  REPORTS: 'reports',
  ENGAGE: 'engage',
  BULLETINS: 'bulletins',
  NEWSROOM: 'newsroom',
  JOBS: 'jobs',
  OVERVIEW: 'overview',
  ID_CARDS: 'id_cards',
  MODERATION: 'moderation',
  ADMIN: 'admin',
  RECRUITMENT: 'recruitment',
  SCORECARDS: 'scorecards',
} as const;

export type ModuleKey = (typeof ModuleKey)[keyof typeof ModuleKey];

/**
 * Is `key` enabled for this session? Reads the server-sent `enabledModules`
 * list. Fails closed on null/undefined — a session that has not loaded its list,
 * or one that predates the server sending it, sees no UI-only module until
 * `ensureModules()` resolves.
 */
export function moduleOn(
  enabledModules: readonly string[] | null | undefined,
  key: ModuleKey | string,
): boolean {
  return (enabledModules ?? []).includes(key);
}
