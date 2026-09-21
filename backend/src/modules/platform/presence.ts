import { query } from '../../db/pool.js';
import { logger } from '../../config/logger.js';

/**
 * Live-user presence, derived from sessions (a non-revoked, unexpired refresh
 * token IS a session). No separate presence store and no client polling is
 * required: every authenticated request bumps the session's `last_seen_at`
 * (throttled in-process to ~1/min per user so the hot path stays cheap and the
 * write volume is bounded). "Live" then means "seen inside the presence window"
 * — a single indexed read the dashboard/SSE can run without a scan.
 */

const PRESENCE_WINDOW_MINUTES = 5;
/** Minimum gap between two `last_seen_at` writes for one user. */
const BUMP_INTERVAL_MS = 60_000;

/** userId → ms-since-epoch of the last presence write we issued. */
const lastBump = new Map<string, number>();

/**
 * Best-effort, throttled presence bump. Never throws and never blocks the
 * caller's response: a missed bump only means a user looks offline for up to a
 * minute longer, which is within the 5-minute window's tolerance.
 */
export function recordPresence(
  userId: string,
  ip: string | null,
  deviceId: string | null,
): void {
  const now = Date.now();
  const prev = lastBump.get(userId);
  if (prev != null && now - prev < BUMP_INTERVAL_MS) return;
  lastBump.set(userId, now);
  // Refresh the cache map occasionally so it cannot grow unbounded.
  if (lastBump.size > 5000) {
    for (const [k, t] of lastBump) if (now - t > 15 * 60_000) lastBump.delete(k);
  }
  void bump(userId, ip, deviceId);
}

async function bump(userId: string, ip: string | null, deviceId: string | null): Promise<void> {
  try {
    await query(
      `UPDATE refresh_tokens
          SET last_seen_at = now(),
              last_seen_ip = COALESCE($2::inet, last_seen_ip),
              device_id    = COALESCE($3, device_id)
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [userId, ip, deviceId],
    );
  } catch (err) {
    logger.debug({ err }, 'presence bump failed (ignored)');
  }
}

export interface LiveSnapshot {
  windowMinutes: number;
  liveUsers: number;
  liveSessions: number;
  byRole: Array<{ role: string; users: number }>;
  byDevice: Array<{ device: string; sessions: number }>;
  computedAt: string;
}

/** Distinct live users + sessions, with role and device breakdowns. */
export async function getLiveUsers(): Promise<LiveSnapshot> {
  const [users, byRole, byDevice] = await Promise.all([
    query<{ live_users: string; live_sessions: string }>(
      `SELECT count(DISTINCT rt.user_id)::text AS live_users,
              count(*)::text AS live_sessions
         FROM refresh_tokens rt
        WHERE rt.revoked_at IS NULL AND rt.expires_at > now()
          AND rt.last_seen_at > now() - make_interval(mins => $1)`,
      [PRESENCE_WINDOW_MINUTES],
    ),
    query<{ role: string; users: string }>(
      `SELECT u.role, count(DISTINCT rt.user_id)::text AS users
         FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
        WHERE rt.revoked_at IS NULL AND rt.expires_at > now()
          AND rt.last_seen_at > now() - make_interval(mins => $1)
        GROUP BY u.role ORDER BY users DESC`,
      [PRESENCE_WINDOW_MINUTES],
    ),
    query<{ device: string; sessions: string }>(
      `SELECT COALESCE(device_id,'(unknown)') AS device, count(*)::text AS sessions
         FROM refresh_tokens
        WHERE revoked_at IS NULL AND expires_at > now()
          AND last_seen_at > now() - make_interval(mins => $1)
        GROUP BY device ORDER BY sessions DESC LIMIT 20`,
      [PRESENCE_WINDOW_MINUTES],
    ),
  ]);
  const t = users.rows[0] ?? { live_users: '0', live_sessions: '0' };
  return {
    windowMinutes: PRESENCE_WINDOW_MINUTES,
    liveUsers: Number(t.live_users),
    liveSessions: Number(t.live_sessions),
    byRole: byRole.rows.map((r) => ({ role: r.role, users: Number(r.users) })),
    byDevice: byDevice.rows.map((r) => ({ device: r.device, sessions: Number(r.sessions) })),
    computedAt: new Date().toISOString(),
  };
}
