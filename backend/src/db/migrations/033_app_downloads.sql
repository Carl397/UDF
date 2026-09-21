-- APK / app-artifact download counting with device information.
--
-- The public download link is routed through GET /api/public/download/apk,
-- which logs one row here (parsed device/os/browser from the user agent, coarse
-- geo, hashed IP only) and then 302-redirects to the real file. As with
-- analytics there is no raw IP and no PII: ip_hash is the daily-salted HMAC used
-- purely to de-duplicate obvious repeat hits, never to identify a person.
CREATE TABLE app_downloads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts           timestamptz NOT NULL DEFAULT now(),
  artifact     text NOT NULL DEFAULT 'apk' CHECK (artifact IN ('apk','aab')),
  version      text CHECK (char_length(version) <= 32),
  ip_hash      text CHECK (char_length(ip_hash) <= 64),
  user_agent   text CHECK (char_length(user_agent) <= 512),
  device_type  text CHECK (device_type IN ('desktop','mobile','tablet','bot','other')),
  os           text CHECK (char_length(os) <= 64),
  browser      text CHECK (char_length(browser) <= 64),
  referrer     text CHECK (char_length(referrer) <= 255),
  country      text CHECK (char_length(country) <= 2)
);
CREATE INDEX app_downloads_ts_idx ON app_downloads (ts);
CREATE INDEX app_downloads_artifact_ts_idx ON app_downloads (artifact, ts);

-- Per-day download rollup so the dashboard trend/breakdown is a cheap read.
-- `metric` is the dimension ('total','os','device_type','browser','country',
-- 'version','referrer'); key='all' holds the grand total for the day.
CREATE TABLE download_daily (
  day       date NOT NULL,
  artifact  text NOT NULL,
  metric    text NOT NULL,
  key       text NOT NULL,
  downloads bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, artifact, metric, key)
);
