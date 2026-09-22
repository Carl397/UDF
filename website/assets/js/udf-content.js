/*
 * UDF CMS content hydration (marketing site).
 *
 * Editorial copy and sliders progressively enhance the static marketing page.
 * The candidate roster is different: only a valid public API response may supply
 * cards. Loading, unavailable and unpublished states never use shipped people.
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
 *       carrying its photo when one has been set. Empty/failed responses show
 *       distinct states, with a fresh request available from the roster control.
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
        if (/udf-content\.js(?:[?#]|$)/.test(all[i].src)) return all[i];
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
  // Share only an in-flight request: a failed or empty response must be retryable.
  var rosterCache = null;
  function validRoster(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || !Array.isArray(data.items)) return false;
    return data.items.every(function (c) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
      if (typeof c.id !== 'string' || !c.id.trim() || typeof c.fullName !== 'string' || !c.fullName.trim()) return false;
      if (typeof c.hasPhoto !== 'boolean') return false;
      return ['roleLabel', 'wardsLabel', 'bio'].every(function (key) {
        return c[key] == null || typeof c[key] === 'string';
      });
    });
  }

  function fetchRoster() {
    if (!rosterCache) {
      rosterCache = new Promise(function (resolve) {
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var settled = false;
        var timer = setTimeout(function () {
          finish({ state: 'unavailable' });
          if (controller) controller.abort();
        }, 12000);

        function finish(result) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }

        Promise.resolve().then(function () {
          var options = { headers: { Accept: 'application/json' }, cache: 'no-store' };
          if (controller) options.signal = controller.signal;
          return fetch(API + '/public/candidates', options);
        }).then(function (res) {
          if (!res.ok) {
            finish({ state: 'unavailable' });
            return null;
          }
          return res.json();
        }).then(function (data) {
          if (settled) return;
          if (!validRoster(data)) {
            finish({ state: 'unavailable' });
            return;
          }
          finish({ state: data.items.length ? 'ready' : 'empty', items: data.items });
        }).catch(function () {
          finish({ state: 'unavailable' });
        });
      }).then(function (result) {
        rosterCache = null;
        return result;
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

  function candidatePhotoPlaceholder() {
    var ph = document.createElement('div');
    ph.className = 'council-photo council-photo-placeholder';
    ph.textContent = 'Photo not available';
    return ph;
  }

  function buildCandidate(c) {
    var card = document.createElement('article');
    card.className = 'council-card';
    // No `reveal` class: main.js has already bound its observer when cards arrive.
    if (c.hasPhoto && c.id) {
      var img = document.createElement('img');
      img.className = 'council-photo';
      img.alt = c.fullName || '';
      img.loading = 'lazy';
      img.addEventListener('error', function () {
        if (img.parentNode === card) card.replaceChild(candidatePhotoPlaceholder(), img);
      });
      img.src = API + '/public/candidates/' + encodeURIComponent(c.id) + '/photo';
      card.appendChild(img);
    } else {
      card.appendChild(candidatePhotoPlaceholder());
    }
    text(card, 'h3', null, c.fullName || '');
    if (c.roleLabel) text(card, 'p', 'council-role', c.roleLabel);
    if (c.wardsLabel) text(card, 'p', 'council-wards', c.wardsLabel);
    if (c.bio) text(card, 'p', 'council-bio', c.bio);
    return card;
  }

  function hydrateRoster(el) {
    el.textContent = '';
    var status = document.createElement('div');
    status.className = 'council-roster-status';
    el.appendChild(status);
    var message = text(status, 'p', null, '');
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    message.setAttribute('aria-atomic', 'true');
    var retry = text(status, 'button', 'btn btn-sm', 'Refresh roster');
    retry.type = 'button';
    var loading = false;

    function finish(state, copy) {
      loading = false;
      el.setAttribute('data-roster-state', state);
      el.setAttribute('aria-busy', 'false');
      message.textContent = copy;
      retry.setAttribute('aria-disabled', 'false');
      retry.textContent = state === 'unavailable' ? 'Retry roster' : 'Refresh roster';
    }

    function load() {
      if (loading) return;
      loading = true;
      el.setAttribute('data-roster-state', 'loading');
      el.setAttribute('aria-busy', 'true');
      message.textContent = 'Loading the published candidate roster…';
      // Keep the control mounted and focusable throughout a keyboard retry.
      retry.setAttribute('aria-disabled', 'true');
      retry.textContent = 'Loading roster…';
      while (el.lastChild !== status) el.removeChild(el.lastChild);
      fetchRoster().then(function (result) {
        if (result.state === 'ready') {
          var cards = document.createDocumentFragment();
          result.items.forEach(function (c) { cards.appendChild(buildCandidate(c)); });
          el.appendChild(cards);
          finish('ready', 'Showing ' + result.items.length + ' published candidate' + (result.items.length === 1 ? '.' : 's.'));
        } else if (result.state === 'empty') {
          finish('empty', 'No candidates are currently published. Please check again later.');
        } else {
          finish('unavailable', 'The candidate roster is unavailable right now. Please try again.');
        }
      }).catch(function () {
        finish('unavailable', 'The candidate roster is unavailable right now. Please try again.');
      });
    }

    retry.addEventListener('click', load);
    load();
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
