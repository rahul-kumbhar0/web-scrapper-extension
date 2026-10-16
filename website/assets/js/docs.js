/* PullRows docs — scrollspy for the table of contents. */
(function () {
  'use strict';
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  if (!links.length || !('IntersectionObserver' in window)) return;
  var byId = {};
  links.forEach(function (a) {
    var id = decodeURIComponent(a.getAttribute('href').slice(1));
    (byId[id] = byId[id] || []).push(a);
  });
  var targets = Object.keys(byId).map(function (id) { return document.getElementById(id); }).filter(Boolean);
  var visible = new Map();
  var current = null;

  function setActive(id) {
    if (id === current) return;
    current = id;
    links.forEach(function (a) { a.classList.remove('is-active'); a.removeAttribute('aria-current'); });
    (byId[id] || []).forEach(function (a) {
      a.classList.add('is-active');
      a.setAttribute('aria-current', 'location');
    });
    // keep the active link in view inside the sticky sidebar
    var side = document.querySelector('.docs > .toc');
    var link = side && side.querySelector('a.is-active');
    if (link) {
      var top = link.offsetTop, h = side.clientHeight;
      if (top < side.scrollTop + 40 || top > side.scrollTop + h - 60) side.scrollTo({ top: top - h / 3 });
    }
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { visible.set(e.target.id, e.isIntersecting); });
    // pick the first heading (in document order) currently in the reading band, else the last one above it
    var pick = null;
    for (var i = 0; i < targets.length; i++) { if (visible.get(targets[i].id)) { pick = targets[i].id; break; } }
    if (!pick) {
      var y = window.innerHeight * 0.25;
      for (var j = 0; j < targets.length; j++) { if (targets[j].getBoundingClientRect().top < y) pick = targets[j].id; }
    }
    if (!pick) pick = targets[0].id;
    setActive(pick);
  }, { rootMargin: '-72px 0px -65% 0px', threshold: 0 });
  targets.forEach(function (t) { io.observe(t); });

  // close the mobile TOC after choosing a section
  var mob = document.querySelector('.toc-mobile');
  if (mob) mob.addEventListener('click', function (e) { if (e.target.closest('a')) mob.removeAttribute('open'); });
})();
