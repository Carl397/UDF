import { performance } from 'node:perf_hooks';
import { pool, checkDb } from '../../db/pool.js';
import { query } from '../../db/pool.js';

/**
 * Truthful server/process status for the SuperAdmin dashboard.
 *
 * Reports only what the unprivileged Node API process can actually observe:
 * process uptime, memory, event-loop lag, DB reachability + latency, pool
 * saturation, the migration head, and (best-effort) disk. OS-level services
 * (nginx/postfix/dovecot) are NOT introspected from here, so we report them as
 * `notIntrospected` rather than fabricate a green light — a fake-healthy badge
 * is worse than an honest unknown.
 */

// Rolling event-loop lag: schedule a 0ms timer and measure overshoot. A cheap
// approximation of a monotonic drift detector with no native dependency.
let lastLagCheck = performance.now();
let lagMs = 0;
const lagTimer = setInterval(() => {
  const now = performance.now();
  lagMs = Math.max(0, now - lastLagCheck - 200); // nominal 200ms interval
  lastLagCheck = now;
}, 200);
lagTimer.unref();

let diskCache: { at: number; freeBytes: number | null; totalBytes: number | null } = {
  at: 0,
  freeBytes: null,
  totalBytes: null,
};

async function diskStats(): Promise<{ freeBytes: number | null; totalBytes: number | null }> {
  // statfs landed in Node 19.6; fall back to "unknown" rather than exec df.
  const fs = await import('node:fs/promises');
  const statfs = (fs as unknown as {
    statfs?: (p: string) => Promise<{ bavail: number; blocks: number; bsize: number }>;
  }).statfs;
  if (typeof statfs !== 'function') return { freeBytes: null, totalBytes: null };
  if (Date.now() - diskCache.at < 30_000) {
    return { freeBytes: diskCache.freeBytes, totalBytes: diskCache.totalBytes };
  }
  try {
    const s = await statfs(process.cwd());
    diskCache = {
      at: Date.now(),
      freeBytes: s.bavail * s.bsize,
      totalBytes: s.blocks * s.bsize,
    };
  } catch {
    // leave prior cache
  }
  return { freeBytes: diskCache.freeBytes, totalBytes: diskCache.totalBytes };
}

async function migrationHead(): Promise<string | null> {
  try {
    const { rows } = await query<{ id: string }>(
      'SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1',
    );
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

export interface ServerStatus {
  collectedAt: string;
  node: { version: string; uptimeSec: number; pid: number };
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  eventLoopLagMs: number;
  db: { reachable: boolean; latencyMs: number | null; pool: { total: number; idle: number; waiting: number } };
  disk: { freeMb: number | null; totalMb: number | null };
  schema: { head: string | null };
  externalServices: { status: 'notIntrospected'; note: string };
}

/** Assemble one server-status snapshot. */
export async function getServerStatus(): Promise<ServerStatus> {
  const mem = process.memoryUsage();
  const dbStart = performance.now();
  const reachable = await checkDb();
  const dbLatency = reachable ? Math.round(performance.now() - dbStart) : null;
  const disk = await diskStats();
  return {
    collectedAt: new Date().toISOString(),
    node: { version: process.version, uptimeSec: Math.round(process.uptime()), pid: process.pid },
    memory: {
      rssMb: Math.round(mem.rss / 1e6),
      heapUsedMb: Math.round(mem.heapUsed / 1e6),
      heapTotalMb: Math.round(mem.heapTotal / 1e6),
    },
    eventLoopLagMs: Math.round(lagMs),
    db: {
      reachable,
      latencyMs: dbLatency,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    },
    disk: {
      freeMb: disk.freeBytes != null ? Math.round(disk.freeBytes / 1e6) : null,
      totalMb: disk.totalBytes != null ? Math.round(disk.totalBytes / 1e6) : null,
    },
    schema: { head: await migrationHead() },
    externalServices: {
      status: 'notIntrospected',
      note: 'nginx/mail/DNS run outside this process; not reported to avoid false health.',
    },
  };
}
