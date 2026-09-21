/*
 * UDF first-party analytics beacon (marketing site).
 *
 * Cookieless and PII-free by construction: this script sends NO identifier of
 * its own. The server derives a per-day, rotating-salt visitor hash from the
 * request, so nothing here is linkable across days and no cookie/storage value
 * is ever sent as an id. The only client-supplied fields are a coarse path, the
 * referrer, query utm tags, a screen bucket, the browser language and a numeric
 * dwell time — all within the tiny `/api/public/collect` contract.
 *
 * Configure per page with data attributes on the <script> tag:
 *   <script src="assets/js/udf-analytics.js"
 *           data-api="https://crm.udf-party.co.za/api" data-site="marketing">
 * `data-api` defaults to the production CRM API origin (this static site is
 * served from udf-party.co.za, a different host to the API). `data-site` labels
 * the traffic and defaults to "marketing".
 */
(function () {
  'use strict';

  var tag =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName('script');
      for (var i = all.length - 1; i >= 0; i--) {
        if (/udf-analytics\.js$/.test(all[i].src)) return all[i];
      }
      return null;
    })();
  if (!tag) return;

  var API = (tag.getAttribute('data-api') || 'https://crm.udf-party.co.za/api').replace(/\/+$/, '');
  var SITE = tag.getAttribute('data-site') || 'marketing';
  var COLLECT = API + '/public/collect';
  var startedAt = Date.now();
  var sentEnd = false;

  // A per-tab, ephemeral id — lives only in sessionStorage, never leaves as an
  // identifier the server trusts for counting (the visitor hash is derived
  // server-side), it just groups a single visit's events together.
  function sessionId() {
    try {
      var k = 'udf_sid';
      var v = sessionStorage.getItem(k);
      if (!v) {
        v = Math.random().toString(36).slice(2) + Date.now().toString(36);
        sessionStorage.setItem(k, v);
      }
      return v;
    } catch (e) {
      return null;
    }
  }

  function screenBucket() {
    var w = Math.max(window.innerWidth || 0, screen && screen.width ? screen.width : 0);
    if (w >= 1920) return '1920+';
    if (w >= 1440) return '1440';
    if (w >= 1280) return '1280';
    if (w >= 1024) return '1024';
    if (w >= 768) return '768';
    return 'small';
  }

  function payload(extra) {
    var base = {
      site: SITE,
      eventType: 'pageview',
      path: location.pathname,
      referrer: document.referrer || undefined,
      screen: screenBucket(),
      lang: (navigator.language || '').slice(0, 16),
      sessionId: sessionId(),
    };
    // Pull campaign tags from the querystring (only these leave the browser).
    try {
      var qs = new URLSearchParams(location.search);
      if (qs.get('utm_source')) base.utmSource = qs.get('utm_source').slice(0, 128);
      if (qs.get('utm_medium')) base.utmMedium = qs.get('utm_medium').slice(0, 128);
      if (qs.get('utm_campaign')) base.utmCampaign = qs.get('utm_campaign').slice(0, 128);
    } catch (e) {
      /* URLSearchParams unsupported — send without campaign tags */
    }
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) base[k] = extra[k];
    return base;
  }

  function send(body) {
    var json = JSON.stringify(body);
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(COLLECT, new Blob([json], { type: 'application/json' }));
        return;
      }
    } catch (e) {
      /* fall through to fetch */
    }
    try {
      fetch(COLLECT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        keepalive: true,
        mode: 'no-cors', // beacon only needs to arrive; we never read the response
      }).catch(function () {});
    } catch (e) {
      /* best-effort only — analytics must never error into the page */
    }
  }

  function sendEnd() {
    if (sentEnd) return;
    sentEnd = true;
    var ms = Date.now() - startedAt;
    // A separate `duration` event (NOT another `pageview`) so dwell time never
    // inflates the pageview/referrer/campaign counts — the server sums
    // duration_ms across every event but only tallies `pageview` rows as views.
    if (ms > 0 && ms < 3600000) {
      send({
        site: SITE,
        eventType: 'duration',
        path: location.pathname,
        durationMs: Math.round(ms),
        sessionId: sessionId(),
      });
    }
  }

  // Pageview on load.
  send(payload());

  // Dwell time on the ways a tab actually goes away, guarded so it fires once.
  window.addEventListener('pagehide', sendEnd);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') sendEnd();
  });
})();
