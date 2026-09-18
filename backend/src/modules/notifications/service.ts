import { query } from '../../db/pool.js';
import type { PoolClient } from 'pg';
import { logger } from '../../config/logger.js';

/**
 * In-app notification centre.
 *
 * A notification is either targeted (`user_id` set) or a broadcast
 * (`user_id` NULL, visible to every signed-in user). Read state lives in
 * `notification_reads` so broadcasts can be read independently per user.
 */

export interface NotifyInput {
  kind?: string;
  title: string;
  body?: string | null;
  /** In-app deep link, e.g. `tab:engage#events`. */
  link?: string | null;
  regionCode?: string | null;
  /** Omit / null ⇒ broadcast to all signed-in users. */
  userId?: string | null;
  /**
   * Broadcast audience (ignored when `userId` is set — a targeted notification
   * always reaches its user). `'all'` (default) is seen by members + staff;
   * `'staff'` keeps workflow noise (new applications, mandates, moderation,
   * appointments) out of members' bells. See migration 026.
   */
  audience?: 'all' | 'staff';
}

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  regionCode: string | null;
  broadcast: boolean;
  read: boolean;
  createdAt: string;
}

interface Row {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  region_code: string | null;
  user_id: string | null;
  created_at: string;
  read: boolean;
}

const toView = (r: Row): NotificationView => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  link: r.link,
  regionCode: r.region_code,
  broadcast: r.user_id === null,
  read: !!r.read,
  createdAt: r.created_at,
});

/**
 * Build the WHERE fragment selecting the notifications a caller may see.
 * Staff see every broadcast; a non-staff caller (member/analyst) sees only
 * `audience = 'all'` broadcasts plus notifications targeted at them. `$1` is
 * the caller's user id in every query below.
 */
function visibleClause(isStaff: boolean): string {
  return isStaff
    ? '(n.user_id IS NULL OR n.user_id = $1)'
    : "(n.user_id = $1 OR (n.user_id IS NULL AND n.audience = 'all'))";
}

/** Best-effort: notification failures must never break the primary action. */
export async function notify(input: NotifyInput, client?: PoolClient): Promise<void> {
  const run = client ? client.query.bind(client) : query;
  try {
    await run(
      `INSERT INTO notifications (user_id, kind, title, body, link, region_code, audience)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.userId ?? null,
        input.kind ?? 'info',
        input.title,
        input.body ?? null,
        input.link ?? null,
        input.regionCode ?? null,
        input.audience ?? 'all',
      ],
    );
  } catch (err) {
    if (client) throw err;
    logger.warn({ err }, 'Failed to enqueue notification');
  }
}

export async function list(
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number; offset?: number; isStaff?: boolean } = {},
): Promise<{ items: NotificationView[]; total: number; unread: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const visible = visibleClause(!!opts.isStaff);
  const unreadFilter = opts.unreadOnly ? ' AND r.read_at IS NULL' : '';

  const res = await query<Row & { total: string; unread: string }>(
    `SELECT n.id, n.kind, n.title, n.body, n.link, n.region_code, n.user_id, n.created_at,
            (r.read_at IS NOT NULL) AS read,
            count(*) OVER ()::text AS total
     FROM notifications n
     LEFT JOIN notification_reads r
       ON r.notification_id = n.id AND r.user_id = $1
     WHERE ${visible}${unreadFilter}
     ORDER BY n.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );

  const unreadRes = await query<{ c: string }>(
    `SELECT count(*)::text AS c
     FROM notifications n
     LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $1
     WHERE ${visible} AND r.read_at IS NULL`,
    [userId],
  );

  return {
    items: res.rows.map(toView),
    total: Number(res.rows[0]?.total ?? 0),
    unread: Number(unreadRes.rows[0]?.c ?? 0),
  };
}

export async function markRead(userId: string, id: string, isStaff = false): Promise<boolean> {
  const res = await query(
    `INSERT INTO notification_reads (user_id, notification_id)
     SELECT $1, n.id FROM notifications n
     WHERE n.id = $2 AND ${visibleClause(isStaff)}
     ON CONFLICT DO NOTHING`,
    [userId, id],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function markAllRead(userId: string, isStaff = false): Promise<number> {
  const res = await query(
    `INSERT INTO notification_reads (user_id, notification_id)
     SELECT $1, n.id FROM notifications n
     LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $1
     WHERE ${visibleClause(isStaff)} AND r.read_at IS NULL
     ON CONFLICT DO NOTHING`,
    [userId],
  );
  return res.rowCount ?? 0;
}

export async function unreadCount(userId: string, isStaff = false): Promise<number> {
  const res = await query<{ c: string }>(
    `SELECT count(*)::text AS c
     FROM notifications n
     LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $1
     WHERE ${visibleClause(isStaff)} AND r.read_at IS NULL`,
    [userId],
  );
  return Number(res.rows[0]?.c ?? 0);
}
