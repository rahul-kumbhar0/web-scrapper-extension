/* PullRows — shared behaviour for every page (nav, links from config, reveal). */
(function () {
  'use strict';
  var C = window.PULLROWS_CONFIG || {};
  var doc = document;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- Links from config ---- */
  doc.querySelectorAll('[data-href]').forEach(function (a) {
    var key = a.getAttribute('data-href');
    var v = C[key];
    if (v) { a.href = v; return; }
    // A checkout that isn't set up yet: say so instead of linking to a broken page.
    if (key.indexOf('CHECKOUT_') === 0) {
      a.removeAttribute('href');
      a.setAttribute('aria-disabled', 'true');
      a.classList.add('is-soon');
      a.textContent = 'Coming soon — try Pro free in the extension';
    }
  });
  if (C.SUPPORT_EMAIL) {
    doc.querySelectorAll('[data-mail]').forEach(function (a) {
      var subj = a.getAttribute('data-mail');
      a.href = 'mailto:' + C.SUPPORT_EMAIL + (subj ? '?subject=' + encodeURIComponent(subj) : '');
      if (a.hasAttribute('data-mail-text')) a.textContent = C.SUPPORT_EMAIL;
    });
  }

  /* ---- Browser-aware install CTA (Edge gets the Edge Add-ons link) ---- */
  var ua = navigator.userAgent || '';
  var isEdge = /\bEdg\//.test(ua);
  var isBrave = !!(navigator.brave && typeof navigator.brave.isBrave === 'function');
  if (isEdge || isBrave) {
    doc.querySelectorAll('[data-browser]').forEach(function (s) { s.textContent = isEdge ? 'Edge' : 'Brave'; });
    if (isEdge && C.EDGE_URL) {
      doc.querySelectorAll('[data-href="CHROME_STORE_URL"]').forEach(function (a) { a.href = C.EDGE_URL; });
    }
  }

  /* ---- Sticky nav state ---- */
  var nav = doc.querySelector('.nav');
  if (nav) {
    var ticking = false;
    var onScroll = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        nav.classList.toggle('is-scrolled', window.scrollY > 8);
        ticking = false;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---- Mobile menu ---- */
  var toggle = doc.querySelector('.nav__toggle');
  var menu = doc.getElementById('mobile-menu');
  if (toggle && menu) {
    var setOpen = function (open) {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      menu.classList.toggle('is-open', open);
      if (open) menu.removeAttribute('inert'); else menu.setAttribute('inert', '');
    };
    setOpen(false);
    toggle.addEventListener('click', function () { setOpen(toggle.getAttribute('aria-expanded') !== 'true'); });
    menu.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setOpen(false); toggle.focus(); }
    });
    window.matchMedia('(min-width: 901px)').addEventListener('change', function (m) { if (m.matches) setOpen(false); });
  }

  /* ---- Scroll reveal: only elements that start below the fold are hidden, so no-JS / fast paint stays visible ---- */
  var revealEls = doc.querySelectorAll('[data-reveal]');
  if (!reduce && 'IntersectionObserver' in window && revealEls.length) {
    var seen = new WeakSet();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var el = en.target;
        if (!seen.has(el)) {
          seen.add(el);
          if (en.isIntersecting) { io.unobserve(el); return; }
          el.classList.add('rv');
          return;
        }
        if (en.isIntersecting) {
          el.classList.add('rv-in');
          io.unobserve(el);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  /* ---- Copy buttons ---- */
  doc.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = doc.getElementById(btn.getAttribute('data-copy'));
      if (!target || !navigator.clipboard) return;
      navigator.clipboard.writeText(target.textContent.trim()).then(function () {
        var old = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = old; }, 1600);
      });
    });
  });

  /* ---- Footer year ---- */
  doc.querySelectorAll('[data-year]').forEach(function (el) {
    var y = new Date().getFullYear();
    if (y > 2026) el.textContent = '2026–' + y;
  });
})();
