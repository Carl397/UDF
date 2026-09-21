/*
 * UDF CMS content hydration (marketing site).
 *
 * Progressive enhancement only: every element already ships its real, static
 * copy in the HTML (good for SEO and for the no-JS / not-yet-published case).
 * This script, when it can reach the published content API, replaces that copy
 * with whatever an admin has most recently published — and builds image+text
 * sliders. If the fetch fails for any reason the page is left exactly as it was
 * delivered, so a CMS outage never blanks the marketing site.
 *
 * Hooks an author adds to the static markup:
 *   <h1 data-cms="marketing.home:heroTitle">Service before self</h1>
 *     → textContent replaced from published block marketing.home field heroTitle.
 *   <a data-cms="marketing.home:ctaHref" data-cms-attr="href" ...>
 *     → the named ATTRIBUTE is replaced instead of the text.
 *   <div data-cms-slider="home.hero"></div>
 *     → an auto-advancing image+text slider (each slide's own durationSeconds)
 *       is built inside this container from the published `slider` block.
 *   <div class="council-grid" data-cms-candidates></div>
 *     → the live "Meet our ward councillors" roster from
 *       GET /public/candidates (CRM-managed rows, active only), each card
 *       carrying its photo when one has been set. Empty/failed responses leave
 *       the statically shipped cards untouched.
 *
 * Configure on the <script> tag (same origin/config pattern as udf-analytics.js):
 *   <script src="assets/js/udf-content.js"
 *           data-api="https://crm.udf-party.co.za/api"></script>
 */
(function () {
  'use strict';

  var tag =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName('script');
      for (var i = all.length - 1; i >= 0; i--) {
        if (/udf-content\.js$/.test(all[i].src)) return all[i];
      }
      return null;
    })();
  if (!tag) return;

  var API = (tag.getAttribute('data-api') || 'https://crm.udf-party.co.za/api').replace(/\/+$/, '');

  // Cache each published block we need so N fields on one block cost one fetch.
  var blockCache = {};
  function fetchBlock(key) {
    if (blockCache[key]) return blockCache[key];
    blockCache[key] = fetch(API + '/public/content/' + encodeURIComponent(key), {
      headers: { Accept: 'application/json' },
    })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .catch(function () {
        return null;
      });
    return blockCache[key];
  }

  function hydrateField(el) {
    // value is "<blockKey>:<field>"; optional data-cms-attr names an attribute.
    var spec = el.getAttribute('data-cms') || '';
    var sep = spec.indexOf(':');
    if (sep < 0) return;
    var key = spec.slice(0, sep);
    var field = spec.slice(sep + 1);
    var attr = el.getAttribute('data-cms-attr');
    if (attr && !safeAttrName(attr)) return;
    fetchBlock(key).then(function (block) {
      if (!block || !block.data) return;
      var value = block.data[field];
      if (value == null || value === '') return;
      var text = typeof value === 'string' ? value : String(value);
      if (attr) {
        // A published payload is trusted content, but never let a bad value
        // turn an attribute swap into a script or event handler.
        if ((attr === 'href' || attr === 'src') && !safeUrl(text)) return;
        el.setAttribute(attr, text);
      } else {
        el.textContent = text;
      }
    });
  }

  // Only these attributes may be hydrated; event handlers (on*) are never set.
  function safeAttrName(attr) {
    return ['href', 'src', 'content', 'aria-label', 'title', 'alt', 'poster'].indexOf(attr) >= 0;
  }
  // Relative, hash, and http(s)/mailto/tel URLs only; blocks javascript: etc.
  function safeUrl(text) {
    return !/^(?:javascript|data|vbscript|file):/i.test(String(text).trim().replace(/[\u0000-\u001f\s]+$/g, ''));
  }

  // ── Slider ────────────────────────────────────────────────────────────────
  function mediaUrl(mediaId) {
    return API + '/public/content-media/' + encodeURIComponent(mediaId);
  }
  function reducedMotion() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return false;
    }
  }

  function buildSlider(el, slides) {
    el.textContent = '';
    el.className = (el.className ? el.className + ' ' : '') + 'udf-cms-slider';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', el.getAttribute('aria-label') || 'Highlights');

    var items = [];
    slides.forEach(function (_, i) {
      var fig = document.createElement('div');
      fig.className = 'udf-cms-slide';
      fig.style.display = i === 0 ? 'block' : 'none';
      if (slides[i].imageMediaId) {
        var img = document.createElement('img');
        img.className = 'udf-cms-slide-img';
        img.src = mediaUrl(slides[i].imageMediaId);
        img.alt = slides[i].title || '';
        img.loading = 'lazy';
        fig.appendChild(img);
      }
      if (slides[i].title || slides[i].text) {
        var cap = document.createElement('div');
        cap.className = 'udf-cms-slide-caption';
        if (slides[i].title) {
          var h = document.createElement('div');
          h.className = 'udf-cms-slide-title';
          h.textContent = slides[i].title;
          cap.appendChild(h);
        }
        if (slides[i].text) {
          var p = document.createElement('p');
          p.className = 'udf-cms-slide-text';
          p.textContent = slides[i].text;
          cap.appendChild(p);
        }
        fig.appendChild(cap);
      }
      el.appendChild(fig);
      items.push(fig);
    });

    var index = 0;
    var timer = null;
    var paused = false;
    var noMotion = reducedMotion();

    function show(i) {
      index = (i + items.length) % items.length;
      for (var j = 0; j < items.length; j++) items[j].style.display = j === index ? 'block' : 'none';
      for (var d = 0; d < dots.length; d++) dots[d].className = 'udf-cms-dot' + (d === index ? ' udf-cms-dot-active' : '');
    }
    function schedule() {
      if (timer) clearTimeout(timer);
      if (noMotion || paused || items.length <= 1) return;
      var d = Number(slides[index].durationSeconds);
      var secs = Math.max(Math.min(Number.isFinite(d) && d > 0 ? d : 5, 120), 2);
      timer = setTimeout(function () {
        show(index + 1);
        schedule();
      }, secs * 1000);
    }

    el.onmouseenter = function () { paused = true; };
    el.onmouseleave = function () { paused = false; schedule(); };

    var dots = [];
    if (items.length > 1) {
      (function () {
        var wrap = document.createElement('div');
        wrap.className = 'udf-cms-dots';
        slides.forEach(function (_, i) {
          var dot = document.createElement('button');
          dot.type = 'button';
          dot.className = 'udf-cms-dot' + (i === 0 ? ' udf-cms-dot-active' : '');
          dot.setAttribute('aria-label', 'Go to slide ' + (i + 1));
          dot.onclick = function () { show(i); schedule(); };
          wrap.appendChild(dot);
          dots.push(dot);
        });
        el.appendChild(wrap);
      })();
      schedule();
    }
  }

  function hydrateSlider(el) {
    var key = el.getAttribute('data-cms-slider') || '';
    if (!key) return;
    fetchBlock(key).then(function (block) {
      if (!block || block.kind !== 'slider' || !block.data) return;
      var rows = Array.isArray(block.data.slides) ? block.data.slides : [];
      var slides = [];
      for (var i = 0; i < rows.length && i < 12; i++) {
        var r = rows[i] || {};
        slides.push({
          imageMediaId: typeof r.imageMediaId === 'string' ? r.imageMediaId : '',
          title: typeof r.title === 'string' ? r.title : '',
          text: typeof r.text === 'string' ? r.text : '',
          durationSeconds: typeof r.durationSeconds === 'number' ? r.durationSeconds : 5,
        });
      }
      if (slides.length) buildSlider(el, slides);
    });
  }

  // ── Ward councillor roster ────────────────────────────────────────────────
  // Rows live in `ward_candidates` and are edited on /crm/candidates; the public
  // feed returns only active people, in the editorial order set there.
  var rosterCache = null;
  function fetchRoster() {
    if (!rosterCache) {
      rosterCache = fetch(API + '/public/candidates', {
        headers: { Accept: 'application/json' },
      })
        .then(function (res) {
          return res.ok ? res.json() : null;
        })
        .catch(function () {
          return null;
        });
    }
    return rosterCache;
  }

  function text(parent, tag, cls, value) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    // Always textContent: roster copy is typed by an editor, never markup.
    el.textContent = value;
    parent.appendChild(el);
    return el;
  }

  function buildCandidate(c) {
    var card = document.createElement('article');
    card.className = 'council-card';
    // No `reveal` class here: main.js binds its observer at load, and these cards
    // are appended after the fetch resolves, so an unobserved `.reveal` would
    // stay at opacity 0 forever. Static cards keep the animation; live ones do not.
    if (c.hasPhoto && c.id) {
      var img = document.createElement('img');
      img.className = 'council-photo';
      img.src = API + '/public/candidates/' + encodeURIComponent(c.id) + '/photo';
      img.alt = c.fullName || '';
      img.loading = 'lazy';
      card.appendChild(img);
    } else {
      // Empty photo slot (no initials): cards show only the councillor's name
      // until a headshot is uploaded.
      var ph = document.createElement('div');
      ph.className = 'council-photo';
      ph.setAttribute('aria-hidden', 'true');
      card.appendChild(ph);
    }
    text(card, 'h3', null, c.fullName || '');
    if (c.roleLabel) text(card, 'p', 'council-role', c.roleLabel);
    if (c.wardsLabel) text(card, 'p', 'council-wards', c.wardsLabel);
    if (c.bio) text(card, 'p', 'council-bio', c.bio);
    return card;
  }

  function hydrateRoster(el) {
    fetchRoster().then(function (data) {
      var rows = data && Array.isArray(data.items) ? data.items : [];
      // Nothing published yet (or the API is unreachable) → keep the shipped cards.
      if (!rows.length) return;
      el.textContent = '';
      for (var i = 0; i < rows.length && i < 200; i++) {
        var c = rows[i] || {};
        if (typeof c.fullName === 'string' && c.fullName) el.appendChild(buildCandidate(c));
      }
    });
  }

  function injectStyles() {
    if (document.getElementById('udf-cms-styles')) return;
    var css = [
      '.udf-cms-slider{position:relative;overflow:hidden;border-radius:12px;background:#111}',
      '.udf-cms-slide{position:relative}',
      '.udf-cms-slide-img{width:100%;display:block;max-height:460px;object-fit:cover}',
      '.udf-cms-slide-caption{position:absolute;left:0;right:0;bottom:0;padding:16px 20px;' +
        'background:linear-gradient(transparent,rgba(0,0,0,.65));color:#fff}',
      '.udf-cms-slide-title{font-size:22px;font-weight:700}',
      '.udf-cms-slide-text{margin:4px 0 0;font-size:15px;opacity:.92}',
      '.udf-cms-dots{position:absolute;bottom:10px;left:0;right:0;display:flex;gap:6px;justify-content:center}',
      '.udf-cms-dot{width:9px;height:9px;border-radius:50%;border:none;cursor:pointer;padding:0;background:rgba(255,255,255,.5)}',
      '.udf-cms-dot-active{background:#fff}',
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'udf-cms-styles';
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  }

  function run() {
    injectStyles();
    var fields = document.querySelectorAll('[data-cms]');
    for (var i = 0; i < fields.length; i++) hydrateField(fields[i]);
    var sliders = document.querySelectorAll('[data-cms-slider]');
    for (var j = 0; j < sliders.length; j++) hydrateSlider(sliders[j]);
    var rosters = document.querySelectorAll('[data-cms-candidates]');
    for (var k = 0; k < rosters.length; k++) hydrateRoster(rosters[k]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
