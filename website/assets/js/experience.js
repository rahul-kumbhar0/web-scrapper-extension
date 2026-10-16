/* PullRows homepage — motion layer: scroll progress, hero tilt, scroll story, live playground, data-flow toggles. */
(function () {
  'use strict';
  var doc = document;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };
  var raf = window.requestAnimationFrame.bind(window);

  /* ================= Scroll progress ================= */
  var bar = $('.progress i');
  var scrollJobs = [];
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    raf(function () {
      ticking = false;
      scrollJobs.forEach(function (fn) { fn(); });
    });
  }
  if (bar && !reduce) {
    scrollJobs.push(function () {
      var max = doc.documentElement.scrollHeight - window.innerHeight;
      bar.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, window.scrollY / max) : 0).toFixed(4) + ')';
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  /* ================= Hero: gentle 3D tilt that follows the pointer ================= */
  (function heroTilt() {
    var wrap = $('.hero .mock-wrap');
    var mock = $('#mock');
    if (!wrap || !mock || reduce || !finePointer) return;
    var rect = null, px = 0, py = 0, pending = false;
    function apply() {
      pending = false;
      if (!rect) return;
      var x = (px - rect.left) / rect.width - 0.5;
      var y = (py - rect.top) / rect.height - 0.5;
      mock.style.transform = 'rotateX(' + (-y * 3).toFixed(2) + 'deg) rotateY(' + (x * 3.5).toFixed(2) + 'deg)';
    }
    wrap.addEventListener('pointerenter', function () { rect = wrap.getBoundingClientRect(); });
    wrap.addEventListener('pointermove', function (e) {
      px = e.clientX; py = e.clientY;
      if (!rect) rect = wrap.getBoundingClientRect();
      if (!pending) { pending = true; raf(apply); }
    });
    wrap.addEventListener('pointerleave', function () { rect = null; mock.style.transform = ''; });
    window.addEventListener('scroll', function () { rect = null; }, { passive: true });
  })();

  /* ================= Scroll story: a page turns into rows ================= */
  (function story() {
    var sx = $('#story-stage');
    if (!sx) return;
    var wrap = sx.parentElement;
    var steps = $$('.story__step');
    var items = $$('.sx__item', sx);
    var rows = $$('.sx__table tbody tr', sx);
    var ghosts = $('.sx__ghosts', sx);
    $$('.sx__cols span', sx).forEach(function (el, i) { el.style.setProperty('--d', i); });
    items.forEach(function (el, i) { el.style.setProperty('--d', i); });
    rows.forEach(function (el, i) { el.style.setProperty('--d', i); });

    var W = 680, H = 480, scale = 1;
    function fit() {
      scale = Math.min(1, wrap.clientWidth / W);
      sx.style.setProperty('--s', scale.toFixed(4));
      wrap.style.setProperty('--stage-h', Math.round(H * scale) + 'px');
    }
    fit();
    window.addEventListener('resize', fit);

    var stage = 0;
    function fly() {
      if (reduce || !sx.animate) return;
      var base = sx.getBoundingClientRect();
      items.forEach(function (item, i) {
        var from = $('.sx__t', item).getBoundingClientRect();
        var to = rows[i] && rows[i].cells[0].getBoundingClientRect();
        if (!to) return;
        var g = doc.createElement('div');
        g.className = 'sx__ghost';
        g.textContent = $('.sx__t', item).textContent;
        ghosts.appendChild(g);
        var x0 = (from.left - base.left) / scale, y0 = (from.top - base.top) / scale - 4;
        var x1 = (to.left - base.left) / scale - 2, y1 = (to.top - base.top) / scale - 3;
        var anim = g.animate([
          { transform: 'translate(' + x0 + 'px,' + y0 + 'px) scale(1)', opacity: 0 },
          { transform: 'translate(' + x0 + 'px,' + (y0 - 10) + 'px) scale(1.05)', opacity: 1, offset: 0.15 },
          { transform: 'translate(' + x1 + 'px,' + y1 + 'px) scale(.96)', opacity: 1, offset: 0.85 },
          { transform: 'translate(' + x1 + 'px,' + y1 + 'px) scale(.96)', opacity: 0 }
        ], { duration: 820, delay: i * 90, easing: 'cubic-bezier(.5,0,.2,1)', fill: 'both' });
        anim.onfinish = function () { g.remove(); };
      });
    }
    function setStage(n) {
      if (n === stage) return;
      var prev = stage;
      stage = n;
      steps.forEach(function (s) { s.classList.toggle('is-active', Number(s.getAttribute('data-stage')) === n); });
      sx.setAttribute('data-stage', String(n));
      if (prev < 2 && n >= 2) {
        fly();
        sx.classList.add('is-fresh');
        setTimeout(function () { sx.classList.remove('is-fresh'); }, 1800);
      }
    }
    function pick() {
      var line = window.innerHeight * (window.innerWidth < 980 ? 0.7 : 0.55);
      var n = 0;
      steps.forEach(function (s) { if (s.getBoundingClientRect().top < line) n = Number(s.getAttribute('data-stage')); });
      setStage(n);
    }
    scrollJobs.push(pick);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) sx.classList.add('is-on'); });
      }, { threshold: 0.2 }).observe(sx);
    } else sx.classList.add('is-on');
    pick();
  })();

  /* ================= Playground: a working mini List Extractor ================= */
  (function playground() {
    var play = $('#play');
    if (!play) return;
    var NS = 'http://www.w3.org/2000/svg';
    var PAGES = [
      [
        ['Aurora ANC 700', 'Lumen', 129, 4.7, 2140], ['Pulse Studio', 'Basswave', 89, 4.4, 860],
        ['Drift Wireless', 'Northbeat', 59, 4.2, 1324], ['Halo Pro X', 'Lumen', 199, 4.8, 3410],
        ['Echo Lite', 'Kestrel', 39, 4.0, 512], ['Nimbus Over-Ear', 'Cirrus', 149, 4.6, 1877],
        ['Tempo Sport', 'Basswave', 49, 4.3, 958], ['Orbit Buds 2', 'Northbeat', 79, 4.5, 2290]
      ],
      [
        ['Monarch Studio', 'Kestrel', 249, 4.9, 640], ['Ripple Kids', 'Cirrus', 29, 4.1, 377],
        ['Atlas Travel', 'Lumen', 169, 4.6, 1205], ['Vapor Open', 'Northbeat', 99, 4.2, 731],
        ['Signal DJ', 'Basswave', 119, 4.5, 489], ['Calm Sleep', 'Cirrus', 69, 4.4, 1033],
        ['Forge Gaming', 'Kestrel', 139, 4.7, 2681], ['Breeze Mini', 'Lumen', 45, 4.0, 284]
      ],
      [
        ['Summit Pro', 'Northbeat', 219, 4.8, 1559], ['Wave Neckband', 'Basswave', 35, 3.9, 412],
        ['Lyric Hi-Fi', 'Kestrel', 299, 4.9, 318], ['Cove Earbuds', 'Cirrus', 55, 4.3, 1740],
        ['Arc Commuter', 'Lumen', 109, 4.5, 902], ['Bolt Run', 'Basswave', 42, 4.1, 655],
        ['Haven ANC', 'Cirrus', 179, 4.7, 1188], ['Spark Kids Pro', 'Northbeat', 39, 4.2, 266]
      ]
    ];
    var COLORS = [['#6A5CFF', '#A49BFF'], ['#0FAF8E', '#7BE3CD'], ['#F59E0B', '#FFD27A'], ['#FF6B4A', '#FFB09E'], ['#3F8CFF', '#9CC3FF'], ['#22223A', '#5A5A78'], ['#C04BD8', '#E6A5F2'], ['#0E8FB0', '#7CD3E6']];
    var COLS = ['name', 'brand', 'price', 'rating', 'reviews', 'link'];
    var grid = $('#play-grid'), statusEl = $('#play-status'), countEl = $('#play-count');
    var thead = $('#play-thead'), tbody = $('#play-tbody'), colsEl = $('#play-cols');
    var btnDetect = $('#play-detect'), btnNext = $('#play-next'), btnReset = $('#play-reset'), btnCsv = $('#play-csv'), btnCopy = $('#play-copy');
    var urlEl = $('#play-url'), pageEl = $('#play-page');
    var state;
    var timers = [];
    function later(ms, fn) { if (reduce) { fn(); return; } timers.push(setTimeout(fn, ms)); }
    function clearTimers() { timers.forEach(clearTimeout); timers = []; }

    function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
    function rowOf(p) { return { name: p[0], brand: p[1], price: '$' + p[2].toFixed(2), rating: p[3].toFixed(1), reviews: p[4].toLocaleString('en-US'), link: 'https://audio-shop.example/p/' + slug(p[0]) }; }

    function headphones() {
      var svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('aria-hidden', 'true');
      ['M4 15v-3a8 8 0 0 1 16 0v3', 'M4 15a2 2 0 0 1 2-2h1v6H6a2 2 0 0 1-2-2z', 'M20 15a2 2 0 0 0-2-2h-1v6h1a2 2 0 0 0 2-2z'].forEach(function (d) {
        var p = doc.createElementNS(NS, 'path');
        p.setAttribute('d', d);
        svg.appendChild(p);
      });
      return svg;
    }
    function el(tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

    function renderGrid(page) {
      grid.textContent = '';
      PAGES[page].forEach(function (p, i) {
        var li = doc.createElement('li');
        var b = el('button', 'pcard');
        b.type = 'button';
        b.setAttribute('aria-label', p[0] + ' by ' + p[1] + ', $' + p[2] + ' — click to extract this list');
        var img = el('span', 'pcard__img');
        var c = COLORS[(i + page * 3) % COLORS.length];
        img.style.setProperty('--c1', c[0]);
        img.style.setProperty('--c2', c[1]);
        img.appendChild(headphones());
        var row = el('span', 'pcard__row');
        row.appendChild(el('span', 'pcard__price', '$' + p[2]));
        row.appendChild(el('span', 'pcard__rate', '★ ' + p[3].toFixed(1) + ' (' + p[4].toLocaleString('en-US') + ')'));
        b.appendChild(img);
        b.appendChild(el('span', 'pcard__brand', p[1]));
        b.appendChild(el('span', 'pcard__name', p[0]));
        b.appendChild(row);
        b.addEventListener('click', function () { if (!state.list) detect(); });
        li.appendChild(b);
        grid.appendChild(li);
      });
      urlEl.textContent = 'audio-shop.example/headphones?page=' + (page + 1);
      pageEl.textContent = 'Page ' + (page + 1) + ' of ' + PAGES.length;
    }

    function setCount() {
      countEl.textContent = state.rows.length + (state.rows.length === 1 ? ' row' : ' rows');
      countEl.classList.remove('bump');
      void countEl.offsetWidth;
      if (!reduce) countEl.classList.add('bump');
    }
    function visibleCols() { return COLS.filter(function (c) { return state.on[c]; }); }

    function renderHead() {
      thead.textContent = '';
      var tr = doc.createElement('tr');
      visibleCols().forEach(function (c) { tr.appendChild(el('th', '', c)); });
      thead.appendChild(tr);
    }
    function rowEl(r, animate) {
      var tr = doc.createElement('tr');
      if (animate && !reduce) tr.className = 'row-in';
      visibleCols().forEach(function (c) { tr.appendChild(el('td', /price|rating|reviews/.test(c) ? 'num' : '', r[c])); });
      return tr;
    }
    function renderBody() {
      tbody.textContent = '';
      if (!state.rows.length) {
        var tr = el('tr', 'play__empty');
        tr.appendChild(el('td', '', 'Your rows appear here.'));
        tbody.appendChild(tr);
        return;
      }
      state.rows.forEach(function (r) { tbody.appendChild(rowEl(r, false)); });
    }
    function renderCols() {
      colsEl.textContent = '';
      COLS.forEach(function (c, i) {
        var b = el('button', 'colchip', c);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(state.on[c]));
        b.title = 'Show or hide the “' + c + '” column';
        if (!reduce) b.style.animationDelay = (i * 60) + 'ms';
        b.addEventListener('click', function () {
          if (state.on[c] && visibleCols().length === 1) return;
          state.on[c] = !state.on[c];
          b.setAttribute('aria-pressed', String(state.on[c]));
          renderHead();
          renderBody();
        });
        colsEl.appendChild(b);
      });
    }

    function status(html) {
      statusEl.textContent = '';
      html.forEach(function (part) {
        if (typeof part === 'string') statusEl.appendChild(doc.createTextNode(part));
        else statusEl.appendChild(el('b', '', part.b));
      });
    }

    function pickAndAdd(onDone) {
      var cards = $$('.pcard', grid);
      var added = 0;
      cards.forEach(function (card, i) {
        later(i * 85, function () {
          card.classList.add('is-picked');
          card.setAttribute('data-n', String(state.rows.length + 1));
          var r = rowOf(PAGES[state.page][i]);
          state.rows.push(r);
          if (tbody.querySelector('.play__empty')) tbody.textContent = '';
          tbody.appendChild(rowEl(r, true));
          tbody.parentElement.parentElement.scrollTop = 1e6;
          added++;
          setCount();
          if (added === cards.length) onDone();
        });
      });
    }

    function enable(list) {
      btnReset.disabled = !list;
      btnCsv.disabled = !list;
      btnCopy.disabled = !list;
      btnDetect.disabled = !!list;
      btnNext.disabled = !list || state.page >= PAGES.length - 1;
    }

    function detect() {
      if (state.busy || state.list) return;
      state.busy = true;
      btnDetect.classList.remove('is-glow');
      status(['Detecting the list…']);
      later(450, function () {
        state.list = true;
        play.classList.add('has-list');
        status([{ b: '8 similar items' }, ' found · 6 columns named from the content.']);
        renderCols();
        renderHead();
        pickAndAdd(function () {
          state.busy = false;
          enable(true);
          status([{ b: state.rows.length + ' rows' }, ' from page 1. Add the next page, untick columns, or download the CSV.']);
          if (!reduce) btnNext.classList.add('is-glow');
        });
      });
    }

    function next() {
      if (state.busy || state.page >= PAGES.length - 1) return;
      state.busy = true;
      btnNext.classList.remove('is-glow');
      btnNext.disabled = true;
      status(['Clicking “Next”, waiting for page ' + (state.page + 2) + '…']);
      grid.classList.add('is-swapping');
      later(320, function () {
        state.page++;
        renderGrid(state.page);
        grid.classList.remove('is-swapping');
        later(250, function () {
          pickAndAdd(function () {
            state.busy = false;
            enable(true);
            var last = state.page >= PAGES.length - 1;
            status(last
              ? ['Last page reached · ', { b: state.rows.length + ' rows' }, ' from ' + PAGES.length + ' pages, 0 duplicates.']
              : [{ b: state.rows.length + ' rows' }, ' so far. There is one more page.']);
            if (!reduce) (last ? btnCsv : btnNext).classList.add('is-glow');
          });
        });
      });
    }

    function table(sep) {
      var cols = visibleCols();
      var esc = sep === ',' ? function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; } : function (v) { return String(v); };
      return [cols.join(sep)].concat(state.rows.map(function (r) { return cols.map(function (c) { return esc(r[c]); }).join(sep); })).join('\n');
    }

    btnDetect.addEventListener('click', detect);
    btnNext.addEventListener('click', next);
    btnReset.addEventListener('click', reset);
    btnCsv.addEventListener('click', function () {
      btnCsv.classList.remove('is-glow');
      var blob = new Blob(['﻿' + table(',')], { type: 'text/csv;charset=utf-8' });
      var a = doc.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'headphones.csv';
      doc.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      status(['Saved ', { b: 'headphones.csv' }, ' · ' + state.rows.length + ' rows × ' + visibleCols().length + ' columns. That’s the whole idea — now imagine it on any site.']);
    });
    btnCopy.addEventListener('click', function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(table('\t')).then(function () {
        status(['Copied ' + state.rows.length + ' rows — paste them into any spreadsheet.']);
      });
    });

    function reset() {
      clearTimers();
      state = { page: 0, rows: [], list: false, busy: false, on: {} };
      COLS.forEach(function (c) { state.on[c] = true; });
      play.classList.remove('has-list');
      renderGrid(0);
      colsEl.textContent = '';
      thead.textContent = '';
      renderBody();
      countEl.textContent = '0 rows';
      enable(false);
      $$('.pbtn', play).forEach(function (b) { b.classList.remove('is-glow'); });
      if (!reduce) btnDetect.classList.add('is-glow');
      status(['Click any product on the left — or press ', { b: 'Auto-detect' }, '.']);
    }
    reset();
  })();

  /* ================= Data flow toggles ================= */
  (function flow() {
    var box = $('#flow');
    var ai = $('#flow-ai'), mcp = $('#flow-mcp'), cap = $('#flow-caption');
    if (!box || !ai || !mcp) return;
    function render() {
      box.classList.toggle('ai-on', ai.checked);
      box.classList.toggle('mcp-on', mcp.checked);
      $('.fnode--ai em', box).textContent = ai.checked ? 'your key · on' : 'your key · off';
      $('.fnode--mcp em', box).textContent = mcp.checked ? 'on' : 'off';
      var out = ai.checked || mcp.checked;
      cap.classList.toggle('is-out', out);
      cap.textContent = !out ? 'Everything stays on this device.'
        : ai.checked && mcp.checked ? 'Only what you send to AI and to Claude leaves — nothing is stored on our side.'
          : ai.checked ? 'Only the text or rows you pick go to Anthropic, with your own key.'
            : 'Tool results pass through the relay to your Claude — not stored.';
    }
    ai.addEventListener('change', render);
    mcp.addEventListener('change', render);
    render();
  })();

  onScroll();
})();
