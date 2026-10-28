/* PullRows — homepage interactions: hero scrape demo, Claude chat demo, counters, card tilt, FAQ, pricing. */
(function () {
  'use strict';
  var doc = document;
  var C = window.PULLROWS_CONFIG || {};
  var mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var reduce = mqReduce.matches;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };

  function onVisible(el, cb, opts) {
    if (!('IntersectionObserver' in window)) { cb(true); return null; }
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { cb(e.isIntersecting, e); }); }, opts || { threshold: 0.25 });
    io.observe(el);
    return io;
  }

  /* ================= Hero scrape demo ================= */
  (function heroMock() {
    var mock = $('#mock');
    if (!mock) return;
    var rows = $$('tr.r', mock);
    var cards = $$('.mp__card', mock);
    var pins = $$('.pin', mock);
    var viewport = $('.mp__viewport', mock);
    var track = $('.mp__track', mock);
    var hl = $('.mp__hl', mock);
    var bar = $('.sp__bar i', mock);
    var count = $('.sp__count', mock);
    var msg = $('.sp__msg', mock);
    var more = $('.sp__more', mock);
    var btn = $('.sp__btn--main', mock);
    var toast = $('.sp__toast', mock);
    var cursor = $('.cursor', mock);
    var TOTAL = 40;
    if (reduce) return; // static end state is already in the markup

    mock.classList.add('anim');
    var timers = [];
    var running = false;
    var inView = false;
    function at(ms, fn) { timers.push(setTimeout(fn, ms)); }
    function stop() { timers.forEach(clearTimeout); timers = []; running = false; }

    function reset() {
      rows.forEach(function (r) { r.classList.remove('in', 'flash'); });
      pins.forEach(function (p) { p.classList.remove('is-hot'); });
      more.classList.remove('in');
      toast.classList.remove('in');
      btn.classList.remove('pulse', 'press');
      bar.style.transform = 'scaleX(0)';
      track.style.transform = 'translateY(0)';
      hl.style.opacity = '0';
      hl.style.transform = 'translateY(3px)';
      cursor.style.opacity = '0';
      count.textContent = '0 rows';
      msg.textContent = 'Ready · click an item or Auto-detect';
    }

    function play() {
      if (running) return;
      running = true;
      reset();
      // Read layout once per cycle.
      var cardH = cards[0].offsetHeight;
      var visible = Math.max(2, Math.floor(viewport.clientHeight / cardH));
      var mRect = mock.getBoundingClientRect();
      var tRect = $('.sp__table', mock).getBoundingClientRect();
      var start = { x: tRect.left - mRect.left + tRect.width * 0.35, y: tRect.top - mRect.top + tRect.height * 0.45 };
      cursor.style.transform = 'translate(' + start.x + 'px,' + start.y + 'px)';

      var t = 500;
      at(t, function () { msg.textContent = 'Auto-detecting the list…'; });
      t += 900;
      at(t, function () {
        msg.textContent = 'Found the results list · Google Maps preset';
        hl.style.opacity = '1';
      });
      t += 500;
      var STEP = 640;
      rows.forEach(function (row, i) {
        at(t + i * STEP, function () {
          var offset = i >= visible - 1 ? i - (visible - 2) : 0;
          track.style.transform = 'translateY(' + (-offset * cardH) + 'px)';
          hl.style.transform = 'translateY(' + ((i - offset) * cardH + 3) + 'px)';
          pins.forEach(function (p, k) { p.classList.toggle('is-hot', k === i % pins.length); });
          row.classList.add('in', 'flash');
          var n = Math.round(((i + 1) / rows.length) * TOTAL * 0.9);
          count.textContent = n + ' rows';
          bar.style.transform = 'scaleX(' + ((i + 1) / rows.length * 0.9).toFixed(3) + ')';
          if (i === visible - 1) msg.textContent = 'Scrolling one screen at a time…';
          if (i === rows.length - 2) msg.textContent = 'Merging half-loaded rows…';
        });
      });
      t += rows.length * STEP + 300;
      at(t, function () {
        bar.style.transform = 'scaleX(1)';
        count.textContent = TOTAL + ' rows';
        msg.textContent = 'Done · ' + TOTAL + ' rows · 0 duplicates';
        more.classList.add('in');
        hl.style.opacity = '0';
        pins.forEach(function (p) { p.classList.remove('is-hot'); });
        btn.classList.add('pulse');
      });
      t += 500;
      at(t, function () {
        var r = mock.getBoundingClientRect();
        var b = btn.getBoundingClientRect();
        cursor.style.opacity = '1';
        cursor.style.transform = 'translate(' + (b.left - r.left + b.width * 0.55) + 'px,' + (b.top - r.top + b.height * 0.5) + 'px)';
      });
      t += 1100;
      at(t, function () { btn.classList.add('press'); });
      at(t + 160, function () { btn.classList.remove('press'); toast.classList.add('in'); });
      t += 3600;
      at(t, function () { cursor.style.opacity = '0'; toast.classList.remove('in'); });
      t += 700;
      at(t, function () {
        rows.forEach(function (r) { r.classList.remove('in', 'flash'); });
        more.classList.remove('in');
        bar.style.transform = 'scaleX(0)';
      });
      t += 700;
      at(t, function () {
        running = false;
        if (inView && !doc.hidden) play();
      });
    }

    onVisible(mock, function (v) {
      inView = v;
      if (v && !doc.hidden) play();
      else if (!v) { stop(); reset(); }
    }, { threshold: 0.2 });
    doc.addEventListener('visibilitychange', function () {
      if (doc.hidden) { stop(); reset(); }
      else if (inView) play();
    });
  })();

  /* ================= Claude chat demo ================= */
  (function chatMock() {
    var chat = $('#chat');
    if (!chat) return;
    var typed = $('.typed', chat);
    var caret = $('.caret', chat);
    var full = typed.getAttribute('data-text') || typed.textContent;
    var steps = $$('[data-step]', chat);
    var chips = $$('.tchip', chat);
    var replay = $('.chat__replay', chat);
    if (reduce) { caret.classList.add('off'); return; }

    chat.classList.add('anim');
    var timers = [];
    var played = false;
    function at(ms, fn) { timers.push(setTimeout(fn, ms)); }
    function reset() {
      timers.forEach(clearTimeout); timers = [];
      typed.textContent = '';
      caret.classList.remove('off');
      steps.forEach(function (s) { s.classList.remove('in'); });
      chips.forEach(function (c) { c.classList.remove('done'); });
      replay.classList.remove('in');
    }
    function play() {
      reset();
      var t = 400;
      for (var i = 1; i <= full.length; i++) {
        (function (n) { at(t + n * 26, function () { typed.textContent = full.slice(0, n); }); })(i);
      }
      t += full.length * 26 + 500;
      at(t, function () { caret.classList.add('off'); });
      var seq = steps.slice();
      seq.forEach(function (s) {
        var isChip = s.classList.contains('tchip');
        t += isChip ? 520 : 650;
        at(t, function () { s.classList.add('in'); });
        if (isChip) at(t + 900 + Math.random() * 300, function () { s.classList.add('done'); });
        if (isChip && s === chips[chips.length - 1]) t += 1200;
      });
      t += 900;
      at(t, function () { replay.classList.add('in'); });
    }
    replay.addEventListener('click', play);
    onVisible(chat, function (v) {
      if (v && !played) { played = true; play(); }
    }, { threshold: 0.35 });
  })();

  /* ================= Counters ================= */
  $$('[data-count]').forEach(function (el) {
    var to = parseFloat(el.getAttribute('data-count'));
    var pre = el.getAttribute('data-prefix') || '';
    var suf = el.getAttribute('data-suffix') || '';
    if (reduce || isNaN(to)) return;
    var done = false;
    onVisible(el, function (v) {
      if (!v || done) return;
      done = true;
      if (to === 0) return;
      var t0 = performance.now(), dur = 1300;
      (function tick(now) {
        var p = Math.min(1, (now - t0) / dur);
        var e = 1 - Math.pow(1 - p, 3);
        el.textContent = pre + Math.round(to * e) + suf;
        if (p < 1) requestAnimationFrame(tick);
      })(t0);
    }, { threshold: 0.6 });
  });

  /* ================= Card tilt + glow ================= */
  if (!reduce && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    $$('[data-tilt]').forEach(function (card) {
      var rect = null, raf = 0, px = 0, py = 0;
      function apply() {
        raf = 0;
        if (!rect) return;
        var x = (px - rect.left) / rect.width, y = (py - rect.top) / rect.height;
        card.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
        card.style.setProperty('--my', (y * 100).toFixed(1) + '%');
        card.style.transform = 'perspective(900px) rotateX(' + ((0.5 - y) * 6).toFixed(2) + 'deg) rotateY(' + ((x - 0.5) * 6).toFixed(2) + 'deg) translateY(-3px)';
      }
      card.addEventListener('pointerenter', function () { rect = card.getBoundingClientRect(); });
      card.addEventListener('pointermove', function (e) {
        px = e.clientX; py = e.clientY;
        if (!rect) rect = card.getBoundingClientRect();
        if (!raf) raf = requestAnimationFrame(apply);
      });
      card.addEventListener('pointerleave', function () {
        rect = null;
        if (raf) cancelAnimationFrame(raf), raf = 0;
        card.style.transform = '';
      });
    });
  }

  /* ================= FAQ accordion ================= */
  var faq = $('.faq');
  if (faq) {
    faq.classList.add('is-ready');
    $$('.faq__btn', faq).forEach(function (btn, i) {
      var panel = doc.getElementById(btn.getAttribute('aria-controls'));
      var startOpen = i === 0;
      btn.setAttribute('aria-expanded', String(startOpen));
      panel.classList.toggle('is-open', startOpen);
      if (!startOpen) panel.setAttribute('inert', '');
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', String(open));
        panel.classList.toggle('is-open', open);
        if (open) panel.removeAttribute('inert'); else panel.setAttribute('inert', '');
      });
    });
  }

})();
