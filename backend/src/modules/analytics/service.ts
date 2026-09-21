import type { Request } from 'express';
import { query } from '../../db/pool.js';
import { logger } from '../../config/logger.js';
import { parseUserAgent } from './uaParser.js';
import { visitorHash, downloadIpHash, geoFromRequest, currentDayKey } from './identity.js';
import type { CollectInput } from './schemas.js';

/**
 * First-party analytics + download accounting.
 *
 * Writes are fire-and-forget best-effort (an analytics hiccup must never break
 * a page or a download). Reads aggregate over the raw, time-indexed event table
 * bounded to the requested window — cheap at this data volume and always fresh.
 * The daily rollup tables are still maintained by the scheduler so the
 * dashboard can move to reading them (instead of scanning) once volume grows.
 */

/** Host of a referrer URL, or null for direct/none. Never stores the full URL. */
function referrerHost(referrer?: string): string | null {
  if (!referrer) return null;
  try {
    const h = new URL(referrer).hostname.toLowerCase();
    return h ? h.slice(0, 255) : null;
  } catch {
    return null;
  }
}

export interface CollectContext {
  ip: string | null;
  userAgent: string | null;
  userId: string | null;
}

/** Insert one pageview/event row derived from a beacon + request metadata. */
export async function collectEvent(input: CollectInput, ctx: CollectContext): Promise<void> {
  const ua = parseUserAgent(ctx.userAgent);
  // Geo for anonymous beacons is resolved from proxy headers by the caller and
  // left null here (dev/nginx-without-geoip simply yields no geo split).
  const geo = { country: null, region: null, city: null };
  const vhash = visitorHash({ ip: ctx.ip, userAgent: ctx.userAgent, site: input.site });
  try {
    await query(
      `INSERT INTO analytics_events (
         site, event_type, path, referrer_host, utm_source, utm_medium, utm_campaign,
         country, region, city, device_type, os, browser, screen, lang, duration_ms,
         visitor_hash, session_id, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        input.site,
        input.eventType,
        input.path ?? null,
        referrerHost(input.referrer),
        input.utmSource ?? null,
        input.utmMedium ?? null,
        input.utmCampaign ?? null,
        geo.country,
        geo.region,
        geo.city,
        ua.deviceType,
        ua.os,
        ua.browser,
        input.screen ?? null,
        input.lang ?? null,
        input.durationMs ?? null,
        vhash,
        input.sessionId ?? null,
        ctx.userId,
      ],
    );
  } catch (err) {
    logger.warn({ err }, 'analytics collectEvent failed (ignored)');
  }
}

/**
 * Insert one analytics event from an authenticated request (used for CRM/app
 * server-side signals such as presence-driven session events and logins).
 */
export async function collectServerEvent(opts: {
  site: 'app' | 'crm';
  eventType: string;
  path?: string | null;
  req: Request;
  userId: string | null;
}): Promise<void> {
  const ua = parseUserAgent(opts.req.get('user-agent'));
  const geo = geoFromRequest(opts.req);
  const vhash = visitorHash({
    ip: opts.req.ip ?? null,
    userAgent: opts.req.get('user-agent') ?? null,
    site: opts.site,
  });
  try {
    await query(
      `INSERT INTO analytics_events (
         site, event_type, path, country, region, city, device_type, os, browser,
         lang, visitor_hash, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        opts.site,
        opts.eventType,
        opts.path ?? null,
        geo.country,
        geo.region,
        geo.city,
        ua.deviceType,
        ua.os,
        ua.browser,
        null,
        vhash,
        opts.userId,
      ],
    );
  } catch (err) {
    logger.warn({ err }, 'analytics collectServerEvent failed (ignored)');
  }
}

export interface DownloadContext {
  ip: string | null;
  userAgent: string | null;
  referrer: string | null;
  version: string | null;
}

/** Log one APK/AAB download (device breakdown), then the caller redirects. */
export async function recordDownload(
  artifact: 'apk' | 'aab',
  ctx: DownloadContext,
): Promise<void> {
  const ua = parseUserAgent(ctx.userAgent);
  const ipHash = downloadIpHash({ ip: ctx.ip });
  try {
    await query(
      `INSERT INTO app_downloads (
         artifact, version, ip_hash, user_agent, device_type, os, browser, referrer, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        artifact,
        ctx.version,
        ipHash,
        (ctx.userAgent ?? '').slice(0, 512) || null,
        ua.deviceType,
        ua.os,
        ua.browser,
        ctx.referrer ? ctx.referrer.slice(0, 255) : null,
        null,
      ],
    );
  } catch (err) {
    logger.warn({ err }, 'analytics recordDownload failed (ignored)');
  }
}

// ── Read APIs (superadmin, ANALYTICS_READ) ────────────────────────────────

interface SiteFilter {
  site?: 'marketing' | 'app' | 'crm';
}

function siteClause(site?: string, idx = 1): { sql: string; param?: string } {
  return site ? { sql: ` AND site = $${idx}`, param: site } : { sql: '' };
}

/** Core traffic for a window plus the equivalent previous window (for delta). */
export async function getOverview(days: number, filter: SiteFilter) {
  // The agg query binds $1=days and $2=offset, so the optional site filter is
  // parameter $3 — a wrong index here compares `site` (text) to an integer.
  const sc = siteClause(filter.site, 3);
  const agg = async (offsetDays: number) => {
    const { rows } = await query<{
      pageviews: string;
      visitors: string;
      sessions: string;
      duration_sum: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE event_type = 'pageview')::text AS pageviews,
         count(DISTINCT visitor_hash)::text AS visitors,
         count(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL)::text AS sessions,
         COALESCE(sum(duration_ms), 0)::text AS duration_sum
       FROM analytics_events
       WHERE ts >= now() - make_interval(days => $1::int + $2::int)
         AND ts <  now() - make_interval(days => $2::int)${sc.sql}`,
      [days, offsetDays, ...(sc.param ? [sc.param] : [])],
    );
    const r = rows[0] ?? { pageviews: '0', visitors: '0', sessions: '0', duration_sum: '0' };
    return {
      pageviews: Number(r.pageviews),
      visitors: Number(r.visitors),
      sessions: Number(r.sessions),
      durationMs: Number(r.duration_sum),
    };
  };
  const [current, previous] = await Promise.all([agg(0), agg(days)]);

  const bySite = await query<{ site: string; pageviews: string; visitors: string }>(
    `SELECT site,
       count(*) FILTER (WHERE event_type='pageview')::text AS pageviews,
       count(DISTINCT visitor_hash)::text AS visitors
     FROM analytics_events
     WHERE ts >= now() - make_interval(days => $1)
     GROUP BY site ORDER BY pageviews DESC`,
    [days],
  );

  const daily = await dailySeries(days, filter.site);

  return {
    windowDays: days,
    timezone: 'Africa/Johannesburg',
    current,
    previous,
    deltas: {
      pageviews: pct(current.pageviews, previous.pageviews),
      visitors: pct(current.visitors, previous.visitors),
      sessions: pct(current.sessions, previous.sessions),
    },
    avgPageviewsPerSession:
      current.sessions > 0 ? round(current.pageviews / current.sessions, 2) : null,
    bySite: bySite.rows.map((r) => ({
      site: r.site,
      pageviews: Number(r.pageviews),
      visitors: Number(r.visitors),
    })),
    daily,
  };
}

function pct(cur: number, prev: number): number | null {
  if (prev <= 0) return cur > 0 ? 100 : 0;
  return round(((cur - prev) / prev) * 100, 1);
}
function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

async function dailySeries(days: number, site?: string) {
  const sc = siteClause(site, 2);
  const { rows } = await query<{ day: string; pageviews: string; visitors: string }>(
    `SELECT to_char((ts AT TIME ZONE 'Africa/Johannesburg')::date, 'YYYY-MM-DD') AS day,
       count(*) FILTER (WHERE event_type='pageview')::text AS pageviews,
       count(DISTINCT visitor_hash)::text AS visitors
     FROM analytics_events
     WHERE ts >= now() - make_interval(days => $1)${sc.sql}
     GROUP BY day ORDER BY day`,
    site ? [days, site] : [days],
  );
  return rows.map((r) => ({
    day: r.day,
    pageviews: Number(r.pageviews),
    visitors: Number(r.visitors),
  }));
}

/** Traffic detail: daily series, top pages, referrers, UTM, landing pages. */
export async function getTraffic(days: number, filter: SiteFilter) {
  // $1 is the window (days); the optional site filter binds to $2.
  const sc = siteClause(filter.site, 2);
  const [daily, topPages, referrers, utm] = await Promise.all([
    dailySeries(days, filter.site),
    query<{ path: string; views: string; visitors: string }>(
      `SELECT COALESCE(path,'(unknown)') AS path,
         count(*)::text AS views, count(DISTINCT visitor_hash)::text AS visitors
       FROM analytics_events
       WHERE event_type='pageview' AND ts >= now() - make_interval(days => $1)${sc.sql}
       GROUP BY path ORDER BY views DESC LIMIT 20`,
      filter.site ? [days, filter.site] : [days],
    ),
    query<{ host: string; views: string }>(
      `SELECT referrer_host AS host, count(*)::text AS views
       FROM analytics_events
       WHERE referrer_host IS NOT NULL AND ts >= now() - make_interval(days => $1)${sc.sql}
       GROUP BY host ORDER BY views DESC LIMIT 15`,
      filter.site ? [days, filter.site] : [days],
    ),
    query<{ source: string; medium: string; campaign: string; views: string }>(
      `SELECT COALESCE(utm_source,'(none)') AS source,
         COALESCE(utm_medium,'(none)') AS medium,
         COALESCE(utm_campaign,'(none)') AS campaign,
         count(*)::text AS views
       FROM analytics_events
       WHERE ts >= now() - make_interval(days => $1)${sc.sql}
       GROUP BY source, medium, campaign ORDER BY views DESC LIMIT 15`,
      filter.site ? [days, filter.site] : [days],
    ),
  ]);
  return {
    windowDays: days,
    daily,
    topPages: topPages.rows.map((r) => ({
      path: r.path,
      views: Number(r.views),
      visitors: Number(r.visitors),
    })),
    referrers: referrers.rows.map((r) => ({ host: r.host, views: Number(r.views) })),
    utm: utm.rows.map((r) => ({
      source: r.source,
      medium: r.medium,
      campaign: r.campaign,
      views: Number(r.views),
    })),
  };
}

/** Device / OS / browser / language / screen breakdown. */
export async function getDevices(days: number, filter: SiteFilter) {
  // Each `dim` query binds $1=days and $2=site.
  const sc = siteClause(filter.site, 2);
  const params = filter.site ? [days, filter.site] : [days];
  const dim = async (col: string) => {
    const { rows } = await query<{ key: string; views: string; visitors: string }>(
      `SELECT COALESCE(${col},'(unknown)') AS key,
         count(*)::text AS views, count(DISTINCT visitor_hash)::text AS visitors
       FROM analytics_events
       WHERE ts >= now() - make_interval(days => $1)${sc.sql}
       GROUP BY key ORDER BY views DESC LIMIT 12`,
      params,
    );
    return rows.map((r) => ({
      key: r.key,
      views: Number(r.views),
      visitors: Number(r.visitors),
    }));
  };
  const [deviceType, os, browser, lang, screen] = await Promise.all([
    dim('device_type'),
    dim('os'),
    dim('browser'),
    dim('lang'),
    dim('screen'),
  ]);
  return { windowDays: days, deviceType, os, browser, lang, screen };
}

/** Live visitors over the last 5 minutes (raw, index-backed, cheap). */
export async function getRealtime() {
  const [totals, bySite, byPath] = await Promise.all([
    query<{ visitors: string; pageviews: string }>(
      `SELECT count(DISTINCT visitor_hash)::text AS visitors,
         count(*) FILTER (WHERE event_type='pageview')::text AS pageviews
       FROM analytics_events WHERE ts > now() - interval '5 minutes'`,
    ),
    query<{ site: string; visitors: string }>(
      `SELECT site, count(DISTINCT visitor_hash)::text AS visitors
       FROM analytics_events WHERE ts > now() - interval '5 minutes'
       GROUP BY site ORDER BY visitors DESC`,
    ),
    query<{ path: string; visitors: string }>(
      `SELECT COALESCE(path,'(unknown)') AS path, count(DISTINCT visitor_hash)::text AS visitors
       FROM analytics_events
       WHERE event_type='pageview' AND ts > now() - interval '5 minutes'
       GROUP BY path ORDER BY visitors DESC LIMIT 10`,
    ),
  ]);
  const t = totals.rows[0] ?? { visitors: '0', pageviews: '0' };
  return {
    computedAt: new Date().toISOString(),
    windowMinutes: 5,
    visitorsNow: Number(t.visitors),
    pageviewsNow: Number(t.pageviews),
    bySite: bySite.rows.map((r) => ({ site: r.site, visitors: Number(r.visitors) })),
    topPaths: byPath.rows.map((r) => ({ path: r.path, visitors: Number(r.visitors) })),
  };
}

/** Download counts + device/country/version breakdowns. */
export async function getDownloads(days: number) {
  const [totals, daily, byDim] = await Promise.all([
    query<{ downloads: string; unique: string }>(
      `SELECT count(*)::text AS downloads,
         count(DISTINCT ip_hash)::text AS unique
       FROM app_downloads WHERE ts >= now() - make_interval(days => $1)`,
      [days],
    ),
    query<{ day: string; downloads: string }>(
      `SELECT to_char((ts AT TIME ZONE 'Africa/Johannesburg')::date,'YYYY-MM-DD') AS day,
         count(*)::text AS downloads
       FROM app_downloads WHERE ts >= now() - make_interval(days => $1)
       GROUP BY day ORDER BY day`,
      [days],
    ),
    Promise.all(
      ['os', 'device_type', 'browser', 'country', 'version', 'referrer'].map(async (col) => {
        const { rows } = await query<{ key: string; n: string }>(
          `SELECT COALESCE(${col},'(unknown)') AS key, count(*)::text AS n
           FROM app_downloads WHERE ts >= now() - make_interval(days => $1)
           GROUP BY key ORDER BY n DESC LIMIT 12`,
          [days],
        );
        return { metric: col, values: rows.map((r) => ({ key: r.key, n: Number(r.n) })) };
      }),
    ),
  ]);
  const t = totals.rows[0] ?? { downloads: '0', unique: '0' };
  return {
    windowDays: days,
    total: Number(t.downloads),
    uniqueIps: Number(t.unique),
    daily: daily.rows.map((r) => ({ day: r.day, downloads: Number(r.downloads) })),
    breakdowns: Object.fromEntries(
      byDim.map((d) => [d.metric === 'device_type' ? 'deviceType' : d.metric, d.values]),
    ),
  };
}

// ── Rollup jobs (invoked by the scheduler; keep daily tables warm) ─────────

/** Recompute a single day's analytics rollups from the raw events (idempotent). */
export async function rollupAnalyticsDay(day: string): Promise<void> {
  await query(
    `WITH ev AS (
       SELECT * FROM analytics_events
        WHERE (ts AT TIME ZONE 'Africa/Johannesburg')::date = $1::date
     )
     INSERT INTO analytics_daily (day, site, metric, key, pageviews, visitors, sessions, duration_ms_sum)
     SELECT $1::date, site, 'total', 'all',
       count(*) FILTER (WHERE event_type='pageview'),
       count(DISTINCT visitor_hash),
       count(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL),
       COALESCE(sum(duration_ms),0)
     FROM ev GROUP BY site
     ON CONFLICT (day, site, metric, key) DO UPDATE SET
       pageviews = EXCLUDED.pageviews, visitors = EXCLUDED.visitors,
       sessions = EXCLUDED.sessions, duration_ms_sum = EXCLUDED.duration_ms_sum`,
    [day],
  );
  // Dimension rollups (path/country/device_type/os/browser/referrer_host).
  for (const col of ['path', 'country', 'device_type', 'os', 'browser', 'referrer_host']) {
    await query(
      `WITH ev AS (
         SELECT site, COALESCE(${col},'(unknown)') AS key, visitor_hash, event_type
           FROM analytics_events
          WHERE (ts AT TIME ZONE 'Africa/Johannesburg')::date = $1::date
       )
       INSERT INTO analytics_daily (day, site, metric, key, pageviews, visitors)
       SELECT $1::date, site, $2, key,
         count(*) FILTER (WHERE event_type='pageview'),
         count(DISTINCT visitor_hash)
       FROM ev GROUP BY site, key
       ON CONFLICT (day, site, metric, key) DO UPDATE SET
         pageviews = EXCLUDED.pageviews, visitors = EXCLUDED.visitors`,
      [day, col],
    );
  }
}

/** Recompute a single day's download rollups from raw rows (idempotent). */
export async function rollupDownloadDay(day: string): Promise<void> {
  await query(
    `WITH dl AS (
       SELECT artifact FROM app_downloads
        WHERE (ts AT TIME ZONE 'Africa/Johannesburg')::date = $1::date
     )
     INSERT INTO download_daily (day, artifact, metric, key, downloads)
     SELECT $1::date, artifact, 'total', 'all', count(*) FROM dl GROUP BY artifact
     ON CONFLICT (day, artifact, metric, key) DO UPDATE SET downloads = EXCLUDED.downloads`,
    [day],
  );
  for (const col of ['os', 'device_type', 'browser', 'country', 'version', 'referrer']) {
    await query(
      `WITH dl AS (
         SELECT artifact, COALESCE(${col},'(unknown)') AS key FROM app_downloads
          WHERE (ts AT TIME ZONE 'Africa/Johannesburg')::date = $1::date
       )
       INSERT INTO download_daily (day, artifact, metric, key, downloads)
       SELECT $1::date, artifact, $2, key, count(*) FROM dl GROUP BY artifact, key
       ON CONFLICT (day, artifact, metric, key) DO UPDATE SET downloads = EXCLUDED.downloads`,
      [day, col],
    );
  }
}

/**
 * Refresh the short-TTL realtime singleton so the SSE snapshot is a single read.
 *
 * NB: `json_object_agg` and `json_agg` both return `json`, while the target
 * columns are `jsonb`. COALESCEing a `json` value against a `'{}'::jsonb`
 * literal has no common type and PostgreSQL rejects the whole statement
 * (`42846 COALESCE could not convert type jsonb to json`), which silently killed
 * this job every minute in production. The aggregates are therefore cast to
 * `jsonb` at the source, so the COALESCE operands and the columns all agree.
 */
export async function refreshRealtime(): Promise<void> {
  await query(
    `WITH win AS (
       SELECT site, path, visitor_hash, event_type FROM analytics_events
        WHERE ts > now() - interval '5 minutes'
     ), tot AS (SELECT count(DISTINCT visitor_hash) AS v FROM win),
     bs AS (SELECT json_object_agg(site, v)::jsonb AS j FROM (
              SELECT site, count(DISTINCT visitor_hash) AS v FROM win GROUP BY site) x),
     bp AS (SELECT COALESCE(json_agg(t ORDER BY t.visitors DESC)::jsonb,'[]'::jsonb) AS j FROM (
              SELECT COALESCE(path,'(unknown)') AS path, count(DISTINCT visitor_hash) AS visitors
                FROM win WHERE event_type='pageview' GROUP BY path ORDER BY visitors DESC LIMIT 10) t)
     UPDATE analytics_realtime
        SET computed_at = now(), visitors_now = tot.v, by_site = COALESCE(bs.j,'{}'::jsonb),
            by_path = bp.j
       FROM tot, bs, bp WHERE id = 1`,
  );
}

export { currentDayKey };
