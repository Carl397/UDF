'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import type { PlatformJobs } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { can, Perm } from '../../../lib/caps';
import { usePlatformLive } from '../../../lib/liveStatus';
import { CrmPageHeader, CrmCard, CrmStatGrid, CrmTable, CrmBadge } from '../../../components/crm/ui';

/**
 * Platform → Ops Overview (SuperAdmin).
 *
 * One live, battery-safe view of the running system: process/DB health, who is
 * online right now, and the cron scheduler's recent behaviour. It reads the
 * server's SSE snapshot while the tab is visible and falls back to a one-shot
 * snapshot fetch on first paint so the tiles are never blank.
 *
 * Truthfulness rule carried from the backend: anything the unprivileged API
 * process cannot actually observe (nginx/mail/DNS) is reported as an honest
 * "not introspected", never a fabricated green light.
 */

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function PlatformOps() {
  const { permissions } = useAuth();
  const allowed = can(permissions, Perm.PLATFORM_READ);
  const live = usePlatformLive(allowed);
  const [jobs, setJobs] = useState<PlatformJobs | null>(null);

  useEffect(() => {
    if (!allowed) return;
    api.getPlatformJobs(30).then(setJobs).catch(() => setJobs(null));
  }, [allowed]);

  if (!allowed) {
    return (
      <div>
        <CrmPageHeader title="Ops Overview" subtitle="Platform operations." />
        <CrmCard>
          <p style={{ color: '#8a817b', margin: 0 }}>
            You do not have access to platform operations.
          </p>
        </CrmCard>
      </div>
    );
  }

  const snap = live.snapshot;
  const server = snap?.server;
  const liveUsers = snap?.live;
  const realtime = snap?.realtime;
  const jobHealth = snap?.jobs ?? jobs?.health ?? [];

  const dbOk = server?.db.reachable;
  const stale = live.lastAt != null && Date.now() - live.lastAt > 45_000;

  return (
    <div>
      <CrmPageHeader
        title="Ops Overview"
        subtitle="Live platform health: process, database, sessions and scheduled jobs."
        actions={
          <span style={{ fontSize: 12, alignSelf: 'center' }}>
            <CrmBadge value={live.connected && !stale ? 'live' : 'pending'} />
            {snap ? ` · updated ${new Date(snap.at).toLocaleTimeString()}` : ''}
          </span>
        }
      />

      <CrmStatGrid
        stats={[
          { label: 'API process', value: server ? (server.node.uptimeSec > 0 ? 'up' : 'up') : '—', tone: server ? 'success' : 'default' },
          { label: 'Uptime', value: server ? fmtUptime(server.node.uptimeSec) : '—' },
          { label: 'Live users', value: liveUsers ? liveUsers.liveUsers : '—', tone: liveUsers && liveUsers.liveUsers > 0 ? 'success' : 'default' },
          { label: 'Live sessions', value: liveUsers ? liveUsers.liveSessions : '—' },
          { label: 'Website visitors (5m)', value: realtime ? realtime.visitorsNow : '—' },
          { label: 'DB', value: dbOk == null ? '—' : dbOk ? 'reachable' : 'down', tone: dbOk ? 'success' : dbOk == null ? 'default' : 'danger' },
        ]}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 20 }}>
        <CrmCard title="Server & process">
            {server ? (
              <dl style={{ margin: 0, fontSize: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
                <Metric k="Node" v={server.node.version} />
                <Metric k="PID" v={String(server.node.pid)} />
                <Metric k="Memory (RSS)" v={`${server.memory.rssMb} MB`} />
                <Metric k="Heap used" v={`${server.memory.heapUsedMb} / ${server.memory.heapTotalMb} MB`} />
                <Metric k="Event-loop lag" v={`${server.eventLoopLagMs} ms`} tone={server.eventLoopLagMs > 100 ? 'warn' : undefined} />
                <Metric k="DB latency" v={server.db.latencyMs != null ? `${server.db.latencyMs} ms` : '—'} />
                <Metric k="DB pool" v={`${server.db.pool.total} total · ${server.db.pool.idle} idle · ${server.db.pool.waiting} waiting`} tone={server.db.pool.waiting > 0 ? 'warn' : undefined} />
                <Metric k="Disk free" v={server.disk.freeMb != null ? `${Math.round(server.disk.freeMb / 1024)} GB of ${server.disk.totalMb != null ? Math.round(server.disk.totalMb / 1024) : '?'} GB` : 'unknown'} />
                <Metric k="Schema head" v={server.schema.head ?? '—'} />
              </dl>
            ) : (
              <p style={{ color: '#8a817b', margin: 0 }}>Waiting for first snapshot…</p>
            )}
            <p style={{ color: '#8a817b', fontSize: 12, marginTop: 14, marginBottom: 0 }}>
              {server?.externalServices.note}
            </p>
          </CrmCard>

        <CrmCard title="Who is online">
            {liveUsers ? (
              <>
                <p style={{ marginTop: 0, color: '#8a817b', fontSize: 13 }}>
                  Distinct users active in the last {liveUsers.windowMinutes} minutes.
                </p>
                <CrmTable
                  columns={['Role', 'Users']}
                  rows={liveUsers.byRole.map((r) => [r.role.replace(/_/g, ' '), <strong key={r.role}>{r.users}</strong>])}
                  empty="No sessions in the window."
                />
              </>
            ) : (
              <p style={{ color: '#8a817b', margin: 0 }}>Waiting for first snapshot…</p>
            )}
          </CrmCard>
      </div>

      <CrmCard title="Scheduled jobs">
        <CrmTable
          columns={['Job', 'Last status', 'Last ran', 'Duration', 'Success rate', 'Runs (7d)']}
          rows={jobHealth.map((j) => [
            <code key={j.jobName}>{j.jobName}</code>,
            <CrmBadge key={j.jobName + '-s'} value={j.lastStatus === 'ok' ? 'active' : j.lastStatus === 'running' ? 'pending' : 'sla_breach'} />,
            j.lastStartedAt ? new Date(j.lastStartedAt).toLocaleString() : '—',
            j.lastDurationMs != null ? `${j.lastDurationMs} ms` : '—',
            j.successRatePct != null ? `${j.successRatePct}%` : '—',
            j.recentRuns,
          ])}
          empty="No job runs recorded yet."
        />
      </CrmCard>

      <CrmCard title="Realtime pages (last 5 min)">
        <CrmTable
          columns={['Path', 'Visitors']}
          rows={(realtime?.topPaths ?? []).map((p) => [p.path, <strong key={p.path}>{p.visitors}</strong>])}
          empty="No pageviews in the last 5 minutes."
        />
      </CrmCard>
    </div>
  );
}

function Metric({ k, v, tone }: { k: string; v: string; tone?: 'warn' }) {
  return (
    <>
      <dt style={{ color: '#8a817b', fontWeight: 500 }}>{k}</dt>
      <dd style={{ margin: 0, fontWeight: 600, color: tone === 'warn' ? '#d97706' : '#1c1917' }}>{v}</dd>
    </>
  );
}
