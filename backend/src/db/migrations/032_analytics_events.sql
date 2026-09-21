-- First-party, cookieless website + app analytics.
--
-- No third-party tags: a tiny beacon POSTs to /api/public/collect, which writes
-- one row here. There is deliberately NO raw IP and NO cookie. `visitor_hash` is
-- HMAC(daily-rotating-salt, ip + user_agent + site) so the same visitor is
-- stable within a day for unique/return counts, but is not reversible and not
-- linkable across days (POPIA-friendly). Country/region/city are coarse geo
-- only. `user_id` is set only for authenticated app/CRM events.
CREATE TABLE analytics_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts            timestamptz NOT NULL DEFAULT now(),
  site          text NOT NULL CHECK (site IN ('marketing','app','crm')),
  event_type    text NOT NULL DEFAULT 'pageview'
                  CHECK (char_length(event_type) BETWEEN 1 AND 64),
  path          text CHECK (char_length(path) <= 512),
  referrer_host text CHECK (char_length(referrer_host) <= 255),
  utm_source    text CHECK (char_length(utm_source) <= 128),
  utm_medium    text CHECK (char_length(utm_medium) <= 128),
  utm_campaign  text CHECK (char_length(utm_campaign) <= 128),
  country       text CHECK (char_length(country) <= 2),
  region        text CHECK (char_length(region) <= 128),
  city          text CHECK (char_length(city) <= 128),
  device_type   text CHECK (device_type IN ('desktop','mobile','tablet','bot','other')),
  os            text CHECK (char_length(os) <= 64),
  browser       text CHECK (char_length(browser) <= 64),
  screen        text CHECK (char_length(screen) <= 16),
  lang          text CHECK (char_length(lang) <= 16),
  duration_ms   integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  visitor_hash  text NOT NULL CHECK (char_length(visitor_hash) <= 64),
  session_id    text CHECK (char_length(session_id) <= 64),
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX analytics_events_ts_idx ON analytics_events (ts);
CREATE INDEX analytics_events_site_ts_idx ON analytics_events (site, ts);
CREATE INDEX analytics_events_visitor_idx ON analytics_events (visitor_hash, ts);

-- Pre-aggregated per-day metrics so the dashboard never scans the raw event
-- table. One row per (day, site, dimension, key); `metric` names the dimension
-- (e.g. 'path','referrer_host','country','device_type','os','browser') and
-- 'pageviews'/'visitors' totals live under metric='total', key='all'.
CREATE TABLE analytics_daily (
  day        date NOT NULL,
  site       text NOT NULL,
  metric     text NOT NULL,
  key        text NOT NULL,
  pageviews  bigint NOT NULL DEFAULT 0,
  visitors   bigint NOT NULL DEFAULT 0,
  sessions   bigint NOT NULL DEFAULT 0,
  duration_ms_sum bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, site, metric, key)
);

-- Short-TTL rollup of "live visitors now" (last 5 minutes), refreshed by a cron
-- job so the realtime tile is a single cheap read. Kept separate from
-- analytics_daily because it is overwritten, not accumulated.
CREATE TABLE analytics_realtime (
  id            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  computed_at   timestamptz NOT NULL DEFAULT now(),
  visitors_now  bigint NOT NULL DEFAULT 0,
  by_site       jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_path       jsonb NOT NULL DEFAULT '[]'::jsonb
);
INSERT INTO analytics_realtime (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
