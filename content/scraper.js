// Injected on demand into the active tab (chrome.scripting.executeScript).
// Safe to inject repeatedly: everything hangs off a single global.
(() => {
  if (globalThis.__webScraper) return;

  const clean = (s, max = 300) => (s || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const abs = (u) => {
    try { return new URL(u, location.href).href; } catch { return ''; }
  };
  const textNodes = function* () {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest('script,style,noscript,template')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n;
    while ((n = walker.nextNode())) yield n;
  };

  // ---------- extractors: each returns an array of flat row objects ----------

  const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

  function emails() {
    const found = new Map();
    for (const a of document.querySelectorAll('a[href^="mailto:" i]')) {
      const e = decodeURIComponent(a.getAttribute('href').slice(7).split('?')[0]).trim().toLowerCase();
      e.split(',').forEach((x) => x && found.set(x.trim(), 'mailto link'));
    }
    for (const m of document.body.innerText.match(EMAIL_RE) || []) {
      const e = m.toLowerCase().replace(/\.$/, '');
      if (!IMAGE_EXT_RE.test(e) && !found.has(e)) found.set(e, 'page text');
    }
    return [...found].map(([email, source]) => ({ email, source }));
  }

  // Candidates: optional +country, optional (area), then digit groups split by space/dot/dash.
  const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,5}\)[\s.-]?)?\d{2,5}(?:[\s.-]\d{2,5}){1,4}/g;
  function phones() {
    const found = new Map();
    for (const a of document.querySelectorAll('a[href^="tel:" i]')) {
      const p = decodeURIComponent(a.getAttribute('href').slice(4)).trim();
      if (p) found.set(p.replace(/[^\d+]/g, ''), { phone: p, source: 'tel link' });
    }
    for (const node of textNodes()) {
      const text = node.textContent;
      for (const m of text.matchAll(PHONE_RE)) {
        const raw = m[0].trim();
        const digits = raw.replace(/\D/g, '');
        const before = text[m.index - 1] || '';
        const after = text[m.index + m[0].length] || '';
        const intl = raw.startsWith('+') || raw.includes('(');
        if (digits.length < (intl ? 7 : 10) || digits.length > 15) continue;
        if (/[\d$£€¥₹.,/:]/.test(before) || /[\d%/:]/.test(after)) continue; // prices, versions, ratios, times
        if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$|^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/.test(raw)) continue; // dates
        if (raw.split(/[\s.-]+/).every((g) => /^(19|20)\d\d$/.test(g))) continue; // year ranges
        const key = digits.replace(/^0+/, '');
        if (![...found.keys()].some((k) => k.replace(/\D/g, '').endsWith(key))) {
          found.set(key, { phone: raw, source: 'page text' });
        }
      }
    }
    return [...found.values()];
  }

  function links() {
    const seen = new Set();
    const rows = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const url = a.href;
      if (!/^https?:/i.test(url) || seen.has(url)) continue;
      seen.add(url);
      rows.push({
        url,
        text: clean(a.innerText || a.getAttribute('aria-label') || a.title, 150),
        kind: new URL(url).host === location.host ? 'internal' : 'external',
      });
    }
    return rows;
  }

  function images() {
    const seen = new Set();
    const rows = [];
    const add = (src, alt, w, h, source) => {
      const url = abs(src);
      if (!url || url.startsWith('data:') || seen.has(url)) return;
      seen.add(url);
      rows.push({ src: url, alt: clean(alt, 150), width: w || '', height: h || '', source });
    };
    for (const img of document.images) {
      const lazy = img.dataset.src || img.dataset.lazySrc || img.dataset.original;
      add(img.currentSrc || img.src || lazy, img.alt || img.title,
        img.naturalWidth || img.width, img.naturalHeight || img.height, 'img');
    }
    for (const s of document.querySelectorAll('picture source[srcset]')) {
      add(s.srcset.split(',')[0].trim().split(/\s+/)[0], '', '', '', 'picture');
    }
    for (const el of document.querySelectorAll('[style*="url("]')) {
      for (const m of el.getAttribute('style').matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        add(m[1], el.getAttribute('aria-label') || '', '', '', 'css background');
      }
    }
    for (const m of document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')) {
      add(m.content, 'social preview', '', '', 'meta');
    }
    return rows;
  }

  function tables() {
    const rows = [];
    document.querySelectorAll('table').forEach((table, ti) => {
      const trs = [...table.rows].filter((tr) => tr.cells.length);
      if (trs.length < 2) return;
      const headRow = table.tHead?.rows[0] || ([...trs[0].cells].every((c) => c.tagName === 'TH') ? trs[0] : null);
      const headers = [];
      if (headRow) {
        [...headRow.cells].forEach((c, i) => {
          let h = clean(c.innerText, 60) || `Column ${i + 1}`;
          while (headers.includes(h)) h += '_';
          for (let s = 0; s < (c.colSpan || 1); s++) headers.push(s ? `${h}_${s + 1}` : h);
        });
      }
      for (const tr of trs) {
        if (tr === headRow) continue;
        const row = { table: ti + 1 };
        let col = 0;
        for (const c of tr.cells) {
          const key = headers[col] || `Column ${col + 1}`;
          row[key] = clean(c.innerText, 500);
          col += c.colSpan || 1;
        }
        rows.push(row);
      }
    });
    return rows;
  }

  function text() {
    const seen = new Set();
    const rows = [];
    for (const el of document.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,dt,dd,figcaption')) {
      if (el.closest('nav,footer,script,style,noscript') || el.querySelector('p,li')) continue;
      const t = clean(el.innerText, 5000);
      const tag = el.tagName.toLowerCase();
      if (!t || seen.has(t) || (!/^h\d$/.test(tag) && t.length < 20)) continue;
      seen.add(t);
      rows.push({ tag, text: t });
    }
    return rows;
  }

  const SOCIAL = {
    'linkedin.com': 'LinkedIn', 'twitter.com': 'Twitter/X', 'x.com': 'Twitter/X',
    'facebook.com': 'Facebook', 'instagram.com': 'Instagram', 'youtube.com': 'YouTube',
    'youtu.be': 'YouTube', 'tiktok.com': 'TikTok', 'github.com': 'GitHub', 'reddit.com': 'Reddit',
    'pinterest.com': 'Pinterest', 'threads.net': 'Threads', 'bsky.app': 'Bluesky',
    'discord.gg': 'Discord', 'discord.com': 'Discord', 't.me': 'Telegram', 'telegram.me': 'Telegram',
    'wa.me': 'WhatsApp', 'whatsapp.com': 'WhatsApp', 'medium.com': 'Medium', 'snapchat.com': 'Snapchat',
  };
  function social() {
    const seen = new Set();
    const rows = [];
    for (const a of document.querySelectorAll('a[href]')) {
      let host;
      try { host = new URL(a.href).hostname.replace(/^www\.|^m\./, ''); } catch { continue; }
      const domain = Object.keys(SOCIAL).find((d) => host === d || host.endsWith('.' + d));
      const url = a.href.split('#')[0];
      if (!domain || seen.has(url)) continue;
      seen.add(url);
      rows.push({ platform: SOCIAL[domain], url, text: clean(a.innerText || a.getAttribute('aria-label'), 100) });
    }
    return rows;
  }

  const CURRENCY = { '$': 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₪': 'ILS', '₽': 'RUB', '₺': 'TRY' };
  const PRICE_RE = /(?:(US\$|C\$|A\$|[$£€¥₹₩₪₽₺])\s?(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?))|(?:(\d{1,3}(?:[,.]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?(USD|EUR|GBP|INR|JPY|CAD|AUD|€|zł|kr))\b/g;
  function prices() {
    const seen = new Set();
    const rows = [];
    for (const node of textNodes()) {
      for (const m of node.textContent.matchAll(PRICE_RE)) {
        const price = m[0].trim();
        // Context = nearest ancestor with more text than just the price (e.g. the product card).
        let container = node.parentElement;
        while (container?.parentElement && container !== document.body && clean(container.innerText).length <= price.length + 3) {
          container = container.parentElement;
        }
        const context = clean(container?.innerText, 160);
        const key = price + '|' + context;
        if (seen.has(key)) continue;
        seen.add(key);
        const sym = m[1] || m[4];
        rows.push({ price, currency: CURRENCY[sym] || sym.replace(/\$$/, '') || '', context });
      }
    }
    return rows;
  }

  const NEXT_TEXT = /^(next|next page|next ›|next »|›|»|→|>|older posts|older|more results|siguiente|suivant|weiter|próxima)$/i;
  function findNextPage() {
    const candidates = [
      ...document.querySelectorAll('link[rel="next"], a[rel~="next"]'),
      ...[...document.querySelectorAll('a[href]')].filter((a) => {
        const label = clean(a.innerText || a.getAttribute('aria-label') || a.title, 40);
        return NEXT_TEXT.test(label) || /^next/i.test(a.getAttribute('aria-label') || '');
      }),
    ];
    for (const el of candidates) {
      const href = el.getAttribute('href');
      if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
      const url = abs(href);
      if (url && url.split('#')[0] !== location.href.split('#')[0]) return url;
    }
    return null;
  }

  function pagination() {
    const rows = [];
    const next = findNextPage();
    if (next) rows.push({ url: next, label: 'Next page', kind: 'next' });
    const seen = new Set([next]);
    for (const a of document.querySelectorAll('a[href]')) {
      if (seen.has(a.href)) continue;
      if (/[?&](page|p|pg|start|offset)=\d+|\/page\/\d+/i.test(a.href)) {
        seen.add(a.href);
        rows.push({ url: a.href, label: clean(a.innerText, 40), kind: 'page link' });
      }
    }
    if (document.querySelector('[class*="infinite" i], [data-infinite], [class*="load-more" i], button[class*="more" i]')) {
      rows.push({ url: location.href, label: 'Infinite scroll / load-more detected', kind: 'infinite' });
    }
    return rows;
  }

  // Custom CSS selector: text plus the most useful link and image for each match.
  function custom(selector) {
    if (!selector) return [];
    const rows = [];
    const matches = [...document.querySelectorAll(selector)];
    // The item's "card": the largest ancestor (max 4 levels) that contains no other match.
    const cardOf = (el) => {
      let card = el;
      for (let i = 0, cur = el.parentElement; i < 4 && cur && cur !== document.body; i++, cur = cur.parentElement) {
        if (matches.some((m) => m !== el && cur.contains(m))) break;
        card = cur;
      }
      return card;
    };
    for (const el of matches) {
      const card = cardOf(el);
      const link = el.closest('a[href]') || el.querySelector('a[href]') || card.querySelector('a[href]');
      const img = el.matches('img') ? el : el.querySelector('img') || card.querySelector('img');
      rows.push({
        text: clean(el.innerText || el.getAttribute('alt') || el.getAttribute('content') || el.value, 1000),
        link: link ? link.href : '',
        image: img ? (img.currentSrc || img.src) : '',
      });
    }
    return rows;
  }

  const EXTRACTORS = { emails, phones, links, images, tables, text, social, prices, pagination };

  function run(types, opts = {}) {
    const results = {};
    const errors = {};
    for (const t of types) {
      try {
        results[t] = t === 'custom' ? custom(opts.selector) : EXTRACTORS[t]();
      } catch (e) {
        results[t] = [];
        errors[t] = String(e.message || e);
      }
    }
    // Chrome sorts object keys when returning results from executeScript, so send each
    // table as { cols, data } to keep the column order intended here.
    const packed = {};
    for (const [t, rows] of Object.entries(results)) {
      const cols = [];
      for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
      packed[t] = { cols, data: rows.map((r) => cols.map((c) => r[c] ?? '')) };
    }
    return { url: location.href, title: document.title, results: packed, errors, next: findNextPage() };
  }

  // Scroll down until the page stops growing (infinite scroll / lazy content).
  async function autoScroll({ maxSteps = 30, pauseMs = 800 } = {}) {
    let lastHeight = 0;
    let stable = 0;
    for (let i = 0; i < maxSteps && stable < 2; i++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((r) => setTimeout(r, pauseMs));
      const h = document.documentElement.scrollHeight;
      stable = h === lastHeight ? stable + 1 : 0;
      lastHeight = h;
    }
    window.scrollTo(0, 0);
    return lastHeight;
  }

  function pageText(maxChars) {
    const t = document.body.innerText.replace(/\n{3,}/g, '\n\n').trim();
    return { url: location.href, title: document.title, text: t.slice(0, maxChars), truncated: t.length > maxChars, length: t.length };
  }

  // ---------- point-and-click element picker ----------

  let picker = null;

  function selectorPart(el) {
    let s = el.tagName.toLowerCase();
    const classes = [...el.classList]
      .filter((c) => /^[a-z_-][\w-]*$/i.test(c) && !/\d{3,}|^(is-|has-)?(active|hover|selected|focus)/i.test(c))
      .slice(0, 2);
    if (classes.length) s += '.' + classes.map((c) => CSS.escape(c)).join('.');
    return s;
  }

  // Shortest ancestor chain that still matches the clicked element — generalised to similar items.
  function buildSelector(el) {
    const parts = [];
    for (let cur = el; cur && cur !== document.body && parts.length < 5; cur = cur.parentElement) {
      parts.unshift(selectorPart(cur));
    }
    for (let n = 1; n <= parts.length; n++) {
      const sel = parts.slice(-n).join(' > ');
      let matches;
      try { matches = document.querySelectorAll(sel); } catch { continue; }
      if ([...matches].includes(el) && matches.length <= 1000 && (matches.length > 1 || n === parts.length)) {
        return { selector: sel, count: matches.length };
      }
    }
    const sel = parts.join(' > ');
    return { selector: sel, count: document.querySelectorAll(sel).length };
  }

  function startPicker() {
    if (picker) return;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #6366f1;background:rgba(99,102,241,.15);border-radius:3px;transition:all .05s';
    const tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#111827;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:4px 8px;border-radius:4px;max-width:420px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    document.documentElement.append(box, tip);
    let current = null;

    const onMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === current) return;
      current = el;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      const { selector, count } = buildSelector(el);
      tip.textContent = `${selector}  —  ${count} match${count === 1 ? '' : 'es'}  (click to pick, Esc to cancel)`;
      tip.style.left = Math.min(r.left, innerWidth - 430) + 'px';
      tip.style.top = (r.top > 30 ? r.top - 26 : r.bottom + 4) + 'px';
    };
    const finish = (result) => {
      stopPicker();
      chrome.runtime.sendMessage({ type: 'PICKER_RESULT', ...result });
    };
    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (current) finish(buildSelector(current));
    };
    const onKey = (e) => { if (e.key === 'Escape') finish({ cancelled: true }); };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    picker = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      box.remove();
      tip.remove();
    };
  }

  function stopPicker() {
    if (picker) picker();
    picker = null;
  }

  globalThis.__webScraper = { run, autoScroll, pageText, findNextPage, startPicker, stopPicker, countSelector: (s) => document.querySelectorAll(s).length };
})();
