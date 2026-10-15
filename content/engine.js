// Scraping engine. Injected on demand into pages (chrome.scripting.executeScript) and also
// loaded in the side panel to parse pages fetched in the background, so every extractor
// takes a `doc` argument instead of assuming the global document.
// Safe to load repeatedly: everything hangs off one global.
(() => {
  if (globalThis.__webScraper) return;

  // ======================================================================
  // helpers
  // ======================================================================

  const clean = (s, max = 300) => (s || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const baseOf = (doc) => doc.baseURI || location.href;
  const abs = (u, doc = document) => {
    try { return new URL(u, baseOf(doc)).href; } catch { return ''; }
  };
  const hostOf = (doc) => { try { return new URL(baseOf(doc)).host; } catch { return ''; } };
  const textOf = (el) => clean(el?.innerText ?? el?.textContent, 5000);
  // Visible text of a document. Pages fetched in the background (DOMParser) have no layout, so
  // innerText degrades to textContent and glues adjacent elements together ("a@b.comYouTube");
  // join their text nodes with spaces instead.
  const docText = (doc) => {
    if (doc.defaultView && doc.body?.innerText != null) return doc.body.innerText;
    return [...textNodes(doc)].map((n) => n.textContent).join(' ');
  };

  function* textNodes(doc) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest('script,style,noscript,template')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n;
    while ((n = walker.nextNode())) yield n;
  }

  // "Stable" classes: skip state classes and generated hashes (css-1x2y3z, sc-AbCdE, jsx-123…).
  const stableClasses = (el) => [...el.classList].filter((c) =>
    /^[a-z_-][\w-]*$/i.test(c) && c.length < 40 &&
    !/\d{3,}|^(css|sc|jsx|emotion|svelte)-|^_|^(is-|has-)?(active|hover|selected|focus|open|visible|hidden|current|loaded|lazy)/i.test(c));

  const esc = (c) => (globalThis.CSS?.escape ? CSS.escape(c) : c.replace(/([^\w-])/g, '\\$1'));
  const sigOf = (el, maxClasses = 2) => {
    const cls = stableClasses(el).slice(0, maxClasses);
    return el.tagName.toLowerCase() + cls.map((c) => '.' + esc(c)).join('');
  };
  const qsa = (root, sel) => { try { return [...root.querySelectorAll(sel)]; } catch { return []; } };

  // Shortest selector (built from tag+class chains) that matches exactly `targets` (or just `el`).
  function selectorFor(el, { unique = false } = {}) {
    const doc = el.ownerDocument;
    if (el.id && /^[a-z][\w-]*$/i.test(el.id) && !/\d{3,}/.test(el.id) && qsa(doc, '#' + esc(el.id)).length === 1) {
      return '#' + esc(el.id);
    }
    const parts = [];
    for (let cur = el; cur && cur !== doc.body && cur !== doc.documentElement && parts.length < 7; cur = cur.parentElement) {
      parts.unshift(sigOf(cur));
    }
    for (let n = 1; n <= parts.length; n++) {
      const sel = parts.slice(-n).join(' > ');
      const m = qsa(doc, sel);
      if (m.includes(el) && (!unique || m.length === 1)) return unique ? sel : sel;
    }
    // Fall back to nth-of-type from the body.
    const path = [];
    for (let cur = el; cur && cur !== doc.body; cur = cur.parentElement) {
      const same = [...(cur.parentElement?.children || [])].filter((s) => s.tagName === cur.tagName);
      path.unshift(cur.tagName.toLowerCase() + (same.length > 1 ? `:nth-of-type(${same.indexOf(cur) + 1})` : ''));
    }
    return 'body > ' + path.join(' > ');
  }

  // ======================================================================
  // quick extractors (each returns an array of flat row objects)
  // ======================================================================

  const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
  const OBFUSCATED_EMAIL_RE = /([a-z0-9._%+-]+)\s*[[(]\s*at\s*[\])]\s*([a-z0-9.-]+?)\s*[[(]\s*dot\s*[\])]\s*([a-z]{2,24})/gi;
  const JUNK_EMAIL_RE = /\.(png|jpe?g|gif|webp|svg|avif|css|js)$|^(example|test|user|name|email|your)@|@(example|domain|email|sentry|wixpress)\.|@\d+x\./i;

  // Cloudflare "email protection" (data-cfemail / /cdn-cgi/l/email-protection#…).
  function decodeCf(hex) {
    try {
      const key = parseInt(hex.slice(0, 2), 16);
      let out = '';
      for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
      return out;
    } catch { return ''; }
  }

  function emails(doc = document) {
    const found = new Map();
    const add = (e, source) => {
      e = e.trim().toLowerCase().replace(/^mailto:/, '').replace(/[.,;:]+$/, '');
      if (e && /^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(e) && !JUNK_EMAIL_RE.test(e) && !found.has(e)) found.set(e, source);
    };
    for (const a of qsa(doc, 'a[href^="mailto:" i]')) {
      decodeURIComponent(a.getAttribute('href').slice(7).split('?')[0]).split(',').forEach((e) => add(e, 'mailto link'));
    }
    for (const el of qsa(doc, '[data-cfemail]')) add(decodeCf(el.getAttribute('data-cfemail')), 'cloudflare protected');
    for (const a of qsa(doc, 'a[href*="/cdn-cgi/l/email-protection#"]')) add(decodeCf(a.getAttribute('href').split('#')[1] || ''), 'cloudflare protected');
    const text = doc.body ? docText(doc) : '';
    for (const m of text.match(EMAIL_RE) || []) add(m, 'page text');
    for (const m of text.matchAll(OBFUSCATED_EMAIL_RE)) add(`${m[1]}@${m[2]}.${m[3]}`, 'obfuscated text');
    return [...found].map(([email, source]) => ({ email, source }));
  }

  // Candidates: optional +country, optional (area), then digit groups split by space/dot/dash.
  const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,5}\)[\s.-]?)?\d{2,5}(?:[\s.-]\d{2,5}){1,4}/g;
  function phones(doc = document) {
    const found = new Map();
    for (const a of qsa(doc, 'a[href^="tel:" i]')) {
      const p = decodeURIComponent(a.getAttribute('href').slice(4)).trim();
      if (p) found.set(p.replace(/[^\d+]/g, ''), { phone: p, source: 'tel link' });
    }
    for (const node of textNodes(doc)) {
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

  function links(doc = document) {
    const seen = new Set();
    const rows = [];
    const host = hostOf(doc);
    for (const a of qsa(doc, 'a[href]')) {
      const url = abs(a.getAttribute('href'), doc);
      if (!/^https?:/i.test(url) || seen.has(url)) continue;
      seen.add(url);
      rows.push({
        url,
        text: clean(a.innerText || a.textContent || a.getAttribute('aria-label') || a.title, 150),
        kind: new URL(url).host === host ? 'internal' : 'external',
      });
    }
    return rows;
  }

  function images(doc = document) {
    const seen = new Set();
    const rows = [];
    const add = (src, alt, w, h, source) => {
      const url = abs(src, doc);
      if (!url || url.startsWith('data:') || seen.has(url)) return;
      seen.add(url);
      rows.push({ src: url, alt: clean(alt, 150), width: w || '', height: h || '', source });
    };
    const bestFromSrcset = (srcset) => {
      const cands = srcset.split(',').map((s) => s.trim().split(/\s+/)).filter((p) => p[0]);
      cands.sort((a, b) => (parseFloat(b[1]) || 0) - (parseFloat(a[1]) || 0));
      return cands[0]?.[0];
    };
    for (const img of qsa(doc, 'img')) {
      const lazy = img.dataset.src || img.dataset.lazySrc || img.dataset.original || img.getAttribute('data-srcset')?.split(' ')[0];
      const src = img.getAttribute('srcset') ? bestFromSrcset(img.getAttribute('srcset')) : null;
      add(src || img.currentSrc || img.getAttribute('src') || lazy, img.alt || img.title,
        img.naturalWidth || img.width || img.getAttribute('width'), img.naturalHeight || img.height || img.getAttribute('height'), 'img');
    }
    for (const s of qsa(doc, 'picture source[srcset]')) add(bestFromSrcset(s.getAttribute('srcset')), '', '', '', 'picture');
    for (const el of qsa(doc, '[style*="url("]')) {
      for (const m of el.getAttribute('style').matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        add(m[1], el.getAttribute('aria-label') || '', '', '', 'css background');
      }
    }
    for (const m of qsa(doc, 'meta[property="og:image"], meta[name="twitter:image"]')) add(m.content, 'social preview', '', '', 'meta');
    for (const l of qsa(doc, 'link[rel~="icon"], link[rel="apple-touch-icon"]')) add(l.getAttribute('href'), 'icon', '', '', 'icon');
    return rows;
  }

  function tables(doc = document) {
    const rows = [];
    qsa(doc, 'table').forEach((table, ti) => {
      const trs = [...table.rows].filter((tr) => tr.cells.length);
      if (trs.length < 2) return;
      const headRow = table.tHead?.rows[0] || ([...trs[0].cells].every((c) => c.tagName === 'TH') ? trs[0] : null);
      const headers = [];
      if (headRow) {
        [...headRow.cells].forEach((c, i) => {
          let h = clean(c.innerText ?? c.textContent, 60) || `Column ${i + 1}`;
          while (headers.includes(h)) h += '_';
          for (let s = 0; s < (c.colSpan || 1); s++) headers.push(s ? `${h}_${s + 1}` : h);
        });
      }
      for (const tr of trs) {
        if (tr === headRow) continue;
        const row = { table: ti + 1 };
        let col = 0;
        for (const c of tr.cells) {
          row[headers[col] || `Column ${col + 1}`] = clean(c.innerText ?? c.textContent, 500);
          col += c.colSpan || 1;
        }
        rows.push(row);
      }
    });
    return rows;
  }

  function text(doc = document) {
    const seen = new Set();
    const rows = [];
    for (const el of qsa(doc.body, 'h1,h2,h3,h4,h5,h6,p,li,blockquote,dt,dd,figcaption')) {
      if (el.closest('nav,footer,script,style,noscript') || el.querySelector('p,li')) continue;
      const t = clean(el.innerText ?? el.textContent, 5000);
      const tag = el.tagName.toLowerCase();
      if (!t || seen.has(t) || (!/^h\d$/.test(tag) && t.length < 20)) continue;
      seen.add(t);
      rows.push({ tag, text: t });
    }
    return rows;
  }

  const SOCIAL = {
    'linkedin.com': 'LinkedIn', 'twitter.com': 'Twitter/X', 'x.com': 'Twitter/X',
    'facebook.com': 'Facebook', 'fb.com': 'Facebook', 'instagram.com': 'Instagram', 'youtube.com': 'YouTube',
    'youtu.be': 'YouTube', 'tiktok.com': 'TikTok', 'github.com': 'GitHub', 'reddit.com': 'Reddit',
    'pinterest.com': 'Pinterest', 'threads.net': 'Threads', 'bsky.app': 'Bluesky',
    'discord.gg': 'Discord', 'discord.com': 'Discord', 't.me': 'Telegram', 'telegram.me': 'Telegram',
    'wa.me': 'WhatsApp', 'whatsapp.com': 'WhatsApp', 'medium.com': 'Medium', 'snapchat.com': 'Snapchat',
    'vimeo.com': 'Vimeo', 'twitch.tv': 'Twitch', 'dribbble.com': 'Dribbble', 'behance.net': 'Behance',
    'crunchbase.com': 'Crunchbase', 'angel.co': 'AngelList', 'wellfound.com': 'Wellfound', 'yelp.com': 'Yelp',
    'tripadvisor.com': 'Tripadvisor', 'trustpilot.com': 'Trustpilot', 'mastodon.social': 'Mastodon',
  };
  // Share buttons and generic pages aren't profiles.
  const SOCIAL_JUNK = /\/(sharer|share|intent|dialog|plugins|home|login|signup|hashtag|search|watch\?|embed)\b|[?&](u|url|text)=/i;
  function social(doc = document) {
    const seen = new Set();
    const rows = [];
    for (const a of qsa(doc, 'a[href]')) {
      let u;
      try { u = new URL(a.getAttribute('href'), baseOf(doc)); } catch { continue; }
      const host = u.hostname.replace(/^(www|m|mobile)\./, '');
      const domain = Object.keys(SOCIAL).find((d) => host === d || host.endsWith('.' + d));
      const url = u.href.split('#')[0].replace(/\/$/, '');
      if (!domain || seen.has(url) || SOCIAL_JUNK.test(u.pathname + u.search) || u.pathname.length < 2) continue;
      seen.add(url);
      rows.push({ platform: SOCIAL[domain], url, text: clean(a.innerText || a.textContent || a.getAttribute('aria-label'), 100) });
    }
    return rows;
  }

  const CURRENCY = { '$': 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₪': 'ILS', '₽': 'RUB', '₺': 'TRY' };
  const PRICE_RE = /(?:(US\$|C\$|A\$|[$£€¥₹₩₪₽₺])\s?(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?))|(?:(\d{1,3}(?:[,.]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?(USD|EUR|GBP|INR|JPY|CAD|AUD|€|zł|kr))\b/g;
  function prices(doc = document) {
    const seen = new Set();
    const rows = [];
    for (const node of textNodes(doc)) {
      for (const m of node.textContent.matchAll(PRICE_RE)) {
        const price = m[0].trim();
        // Context = nearest ancestor with more text than just the price (e.g. the product card).
        let container = node.parentElement;
        while (container?.parentElement && container !== doc.body && clean(container.innerText ?? container.textContent).length <= price.length + 3) {
          container = container.parentElement;
        }
        const context = clean(container?.innerText ?? container?.textContent, 160);
        const key = price + '|' + context;
        if (seen.has(key)) continue;
        seen.add(key);
        const sym = m[1] || m[4];
        rows.push({ price, currency: CURRENCY[sym] || sym.replace(/\$$/, '') || '', context });
      }
    }
    return rows;
  }

  const NEXT_TEXT = /^(next|next page|next ›|next »|›|»|→|>|>>|older posts|older|more results|siguiente|suivant|weiter|próxima|avanti|volgende)$/i;
  function findNextUrl(doc = document) {
    const candidates = [
      ...qsa(doc, 'link[rel="next"], a[rel~="next"]'),
      ...qsa(doc, 'a[href]').filter((a) => {
        const label = clean(a.innerText || a.textContent || a.getAttribute('aria-label') || a.title, 40);
        return NEXT_TEXT.test(label) || /^next/i.test(a.getAttribute('aria-label') || '');
      }),
    ];
    for (const el of candidates) {
      const href = el.getAttribute('href');
      if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
      const url = abs(href, doc);
      if (url && url.split('#')[0] !== baseOf(doc).split('#')[0]) return url;
    }
    return null;
  }

  function pagination(doc = document) {
    const rows = [];
    const next = findNextUrl(doc);
    if (next) rows.push({ url: next, label: 'Next page', kind: 'next' });
    const seen = new Set([next]);
    for (const a of qsa(doc, 'a[href]')) {
      const url = abs(a.getAttribute('href'), doc);
      if (seen.has(url)) continue;
      if (/[?&](page|p|pg|start|offset)=\d+|\/page\/\d+/i.test(url)) {
        seen.add(url);
        rows.push({ url, label: clean(a.innerText || a.textContent, 40), kind: 'page link' });
      }
    }
    if (doc.querySelector('[class*="infinite" i], [data-infinite], [class*="load-more" i], button[class*="more" i]')) {
      rows.push({ url: baseOf(doc), label: 'Infinite scroll / load-more detected', kind: 'infinite' });
    }
    return rows;
  }

  // Custom CSS selector: text plus the most useful link and image for each match.
  function custom(selector, doc = document) {
    if (!selector) return [];
    const rows = [];
    const matches = qsa(doc, selector);
    // The item's "card": the largest ancestor (max 4 levels) that contains no other match.
    const cardOf = (el) => {
      let card = el;
      for (let i = 0, cur = el.parentElement; i < 4 && cur && cur !== doc.body; i++, cur = cur.parentElement) {
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
        text: clean(el.innerText || el.textContent || el.getAttribute('alt') || el.getAttribute('content') || el.value, 1000),
        link: link ? abs(link.getAttribute('href'), doc) : '',
        image: img ? abs(img.currentSrc || img.getAttribute('src'), doc) : '',
      });
    }
    return rows;
  }

  const QUICK = { emails, phones, links, images, tables, text, social, prices, pagination };

  // Chrome sorts object keys when returning results from executeScript, so tables travel
  // as { cols, data } to keep the intended column order.
  function pack(rows) {
    const cols = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    return { cols, data: rows.map((r) => cols.map((c) => r[c] ?? '')) };
  }

  function quick(types, opts = {}, doc = document) {
    const results = {};
    const errors = {};
    for (const t of types) {
      try {
        results[t] = pack(t === 'custom' ? custom(opts.selector, doc) : QUICK[t](doc));
      } catch (e) {
        results[t] = pack([]);
        errors[t] = String(e.message || e);
      }
    }
    return { url: baseOf(doc), title: doc.title, results, errors, next: findNextUrl(doc) };
  }

  // ======================================================================
  // LIST EXTRACTOR — detect repeating items and their fields
  // ======================================================================

  const INLINE = new Set(['B', 'I', 'EM', 'STRONG', 'SMALL', 'SUP', 'SUB', 'BR', 'U', 'S', 'MARK', 'ABBR', 'CODE', 'WBR', 'FONT', 'BDI', 'Q']);
  const SKIP = 'script,style,noscript,template,svg,iframe,button[aria-hidden="true"]';

  const nameHint = (el) => el.getAttribute('itemprop') || el.getAttribute('data-testid') ||
    stableClasses(el).find((c) => !/^(text|font|flex|grid|col|row|d|m[trblxy]?|p[trblxy]?|w|h|bg|border|rounded)-|^(sm|md|lg|xl):/.test(c));
  const tableHeaderFor = (cell) => {
    const table = cell.closest('table');
    const tr = cell.parentElement;
    if (!table || !tr) return '';
    const head = table.tHead?.rows[0] || [...table.rows].find((r) => [...r.cells].every((c) => c.tagName === 'TH'));
    if (!head || head === tr) return '';
    return clean(head.cells[[...tr.cells].indexOf(cell)]?.textContent, 40);
  };
  const fieldNameFrom = (el) => {
    if (/^T[DH]$/.test(el.tagName)) { const h = tableHeaderFor(el); if (h) return h; }
    if (el.getAttribute('role') === 'img' && /star|rating/i.test(el.getAttribute('aria-label') || '')) return 'rating';
    // Unclassed links/spans take their name from the parent (h3.name > a → "name").
    const hint = nameHint(el) || (/^(A|SPAN|STRONG|B|EM)$/.test(el.tagName) && el.parentElement ? nameHint(el.parentElement) : '');
    if (hint) return hint.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
    return { a: 'link text', h1: 'heading', h2: 'title', h3: 'title', h4: 'subtitle', p: 'description', img: 'image', time: 'date', span: 'text', div: 'text', li: 'item' }[el.tagName.toLowerCase()] || el.tagName.toLowerCase();
  };

  // Every data point inside an item: text leaves, link targets, image sources, datetimes.
  function leavesOf(item) {
    const out = [];
    const counters = new Map();
    const relPath = (el) => {
      const parts = [];
      for (let cur = el; cur && cur !== item; cur = cur.parentElement) parts.unshift(sigOf(cur, 1));
      return ':scope > ' + parts.join(' > ');
    };
    const push = (el, attr, value) => {
      if (!value) return;
      const path = el === item ? ':scope' : relPath(el);
      const k = path + '|' + attr;
      const idx = counters.get(k) || 0;
      counters.set(k, idx + 1);
      out.push({ key: `${k}|${idx}`, path, attr, idx, value, el });
    };
    const isTextLeaf = (el) => {
      const t = (el.innerText ?? el.textContent ?? '').trim();
      if (!t) return false;
      return ![...el.children].some((c) => !INLINE.has(c.tagName) && (c.textContent || '').trim());
    };
    const visit = (el, insideLeaf) => {
      if (el.matches(SKIP)) return;
      let leaf = insideLeaf;
      if (!insideLeaf && isTextLeaf(el)) {
        push(el, 'text', clean(el.innerText ?? el.textContent, 2000));
        leaf = true;
      }
      if (el.tagName === 'A' && el.getAttribute('href') && !/^(javascript:|#)/i.test(el.getAttribute('href'))) {
        push(el, 'href', abs(el.getAttribute('href'), el.ownerDocument));
      }
      if (el.tagName === 'IMG') {
        const src = el.currentSrc || el.getAttribute('src') || el.dataset.src || el.dataset.lazySrc;
        if (src && !src.startsWith('data:')) push(el, 'src', abs(src, el.ownerDocument));
      }
      if (el.tagName === 'TIME' && el.getAttribute('datetime')) push(el, 'datetime', el.getAttribute('datetime'));
      for (const c of el.children) visit(c, leaf);
    };
    visit(item, false);
    return out;
  }

  // Columns shared by enough items, with readable names.
  function fieldsFor(items) {
    const stats = new Map();
    const sample = items.slice(0, 60);
    for (const item of sample) {
      for (const l of leavesOf(item)) {
        const s = stats.get(l.key) || { ...l, count: 0, values: new Set(), order: stats.size };
        s.count++;
        s.values.add(l.value);
        stats.set(l.key, s);
      }
    }
    const minCount = Math.max(2, Math.ceil(sample.length * 0.2));
    let fields = [...stats.values()].filter((s) => s.count >= Math.min(minCount, sample.length));
    // Drop columns whose value never changes (decorations like "View", "Add to cart") unless only one item.
    if (sample.length > 2) fields = fields.filter((f) => f.values.size > 1 || f.attr === 'text' && f.count < sample.length);
    // Drop columns that duplicate an earlier column value-for-value.
    const sig = (f) => sample.map((item) => leavesOf(item).find((l) => l.key === f.key)?.value || '').join('\u0001');
    const seenSig = new Set();
    fields = fields.sort((a, b) => a.order - b.order).filter((f) => {
      const k = sig(f);
      if (seenSig.has(k)) return false;
      seenSig.add(k);
      return true;
    });
    const names = new Set();
    return fields.slice(0, 40).map((f) => {
      let base = fieldNameFrom(f.el);
      if (f.attr === 'href') base += ' link';
      else if (f.attr === 'src') base = base === 'image' ? 'image' : `${base} image`;
      else if (f.attr === 'datetime') base += ' datetime';
      let name = base;
      for (let i = 2; names.has(name); i++) name = `${base} ${i}`;
      names.add(name);
      return { name, path: f.path, idx: f.idx, attr: f.attr };
    });
  }

  const pathsOf = (item) => new Set(leavesOf(item).map((l) => l.key));
  const jaccard = (a, b) => {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter || 1);
  };

  // Score a group of sibling elements as "the list": many items × rich items × similar structure.
  function scoreGroup(group) {
    const sample = group.slice(0, 12);
    const sets = sample.map(pathsOf);
    const richness = Math.min(12, sets.reduce((n, s) => n + s.size, 0) / sets.length);
    if (richness < 1) return 0;
    let sim = 0;
    for (let i = 1; i < sets.length; i++) sim += jaccard(sets[0], sets[i]);
    sim = sets.length > 1 ? sim / (sets.length - 1) : 0;
    const visible = sample.filter((el) => el.getClientRects?.().length !== 0).length / sample.length;
    return group.length * richness * sim * sim * (0.2 + 0.8 * visible);
  }

  const similarSiblings = (el) => {
    const parent = el.parentElement;
    if (!parent) return [el];
    const sig = sigOf(el, 1);
    return [...parent.children].filter((c) => c.tagName === el.tagName && sigOf(c, 1) === sig);
  };

  function itemSelectorFor(items) {
    const doc = items[0].ownerDocument;
    const shared = stableClasses(items[0]).filter((c) => items.every((i) => i.classList.contains(c))).slice(0, 2);
    const sig = items[0].tagName.toLowerCase() + shared.map((c) => '.' + esc(c)).join('');
    const set = new Set(items);
    const ok = (sel) => { const m = qsa(doc, sel); return m.length === items.length && m.every((x) => set.has(x)); };
    if (shared.length && ok(sig)) return sig;
    const parentSel = selectorFor(items[0].parentElement, { unique: true });
    const sel = `${parentSel} > ${sig}`;
    if (ok(sel)) return sel;
    return `${parentSel} > ${items[0].tagName.toLowerCase()}`;
  }

  function describeGroup(items, score) {
    const itemSelector = itemSelectorFor(items);
    const fields = fieldsFor(items);
    return { itemSelector, count: qsa(items[0].ownerDocument, itemSelector).length, fields, score: Math.round(score) };
  }

  // From one clicked element: candidate lists at each ancestor level, best first.
  function listsFromElement(el) {
    const cands = [];
    for (let cur = el, depth = 0; cur && cur !== cur.ownerDocument.body && depth < 10; cur = cur.parentElement, depth++) {
      const group = similarSiblings(cur);
      if (group.length < 2) continue;
      const score = scoreGroup(group) / (1 + depth * 0.05);
      if (score > 0) cands.push({ group, score });
    }
    cands.sort((a, b) => b.score - a.score);
    return cands.slice(0, 5).map((c) => describeGroup(c.group, c.score));
  }

  // Without a click: scan the page for the best repeating groups (Instant-Data-Scraper style).
  function autoDetectLists(doc = document) {
    const cands = [];
    for (const parent of qsa(doc.body, '*')) {
      if (parent.children.length < 3 || parent.matches(SKIP)) continue;
      const groups = new Map();
      for (const c of parent.children) {
        const k = sigOf(c, 1);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c);
      }
      for (const group of groups.values()) {
        if (group.length < 3) continue;
        const score = scoreGroup(group);
        if (score > 0) cands.push({ group, score });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    // Skip groups nested inside a better group.
    const picked = [];
    for (const c of cands) {
      if (picked.some((p) => p.group.some((g) => g.contains(c.group[0]) || c.group[0].contains(g)))) continue;
      picked.push(c);
      if (picked.length === 6) break;
    }
    return picked.map((c) => describeGroup(c.group, c.score));
  }

  // Auto-generated fields for a user-supplied item selector.
  function describeSelector(itemSelector, doc = document) {
    const items = qsa(doc, itemSelector);
    if (!items.length) throw new Error(`No elements match ${itemSelector}`);
    return { itemSelector, count: items.length, fields: fieldsFor(items), score: 0 };
  }

  function extractList(config, doc = document) {
    const items = qsa(doc, config.itemSelector);
    const rows = items.map((item) => {
      const row = {};
      for (const f of config.fields) {
        let el = null;
        if (f.path === ':scope') el = item;
        else el = qsa(item, f.path)[f.idx || 0];
        let v = '';
        if (el) {
          if (f.attr === 'text') v = clean(el.innerText ?? el.textContent, 2000);
          else if (f.attr === 'href') v = abs(el.getAttribute('href'), doc);
          else if (f.attr === 'src') v = abs(el.currentSrc || el.getAttribute('src') || el.dataset.src || '', doc);
          else v = el.getAttribute(f.attr) || '';
        }
        row[f.name] = v;
      }
      return row;
    }).filter((r) => Object.values(r).some(Boolean));
    return { ...pack(rows), count: items.length, url: baseOf(doc), title: doc.title };
  }

  // ======================================================================
  // pagination actions (run in the live page)
  // ======================================================================

  const isVisible = (el) => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const isDisabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true' || /\bdisabled\b/i.test(el.className);

  function findNextButton(doc = document) {
    const cands = [
      ...qsa(doc, 'a[rel~="next"]'),
      ...qsa(doc, 'a, button, [role="button"]').filter((el) => {
        const label = clean(el.innerText || el.getAttribute('aria-label') || el.title, 40);
        return NEXT_TEXT.test(label) || /^next/i.test(el.getAttribute('aria-label') || '') ||
          (/\bnext\b/i.test(el.className) && /pag/i.test(el.closest('[class]')?.parentElement?.className || el.className));
      }),
    ].filter((el) => isVisible(el) && !isDisabled(el));
    return cands[0] ? selectorFor(cands[0]) : null;
  }

  const LOAD_MORE = /^(load|show|see|view)\s+more\b|^more\s+(results|items|products)|^mehr\b|^ver m[aá]s|^voir plus|^carica altri/i;
  function findLoadMoreButton(doc = document) {
    const el = qsa(doc, 'button, a, [role="button"]').find((b) => isVisible(b) && !isDisabled(b) &&
      LOAD_MORE.test(clean(b.innerText || b.getAttribute('aria-label'), 40)));
    return el ? selectorFor(el) : null;
  }

  function clickElement(selector) {
    const el = qsa(document, selector).find(isVisible);
    if (!el || isDisabled(el)) return false;
    el.scrollIntoView({ block: 'center' });
    // Some sites listen for mousedown/mouseup rather than click.
    for (const type of ['mousedown', 'mouseup']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    el.click();
    return true;
  }

  // Type into an input/textarea/contenteditable the way a user would (fires input/change).
  function fillInput(selector, value) {
    const el = qsa(document, selector).find(isVisible) || qsa(document, selector)[0];
    if (!el) return false;
    el.focus();
    if (el.isContentEditable) el.textContent = value;
    else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // Scroll the container that actually holds the list (e.g. Google Maps' results feed), else the window.
  function scrollContainerOf(selector) {
    const first = selector && qsa(document, selector)[0];
    for (let el = first?.parentElement; el && el !== document.body; el = el.parentElement) {
      const s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
    }
    return null;
  }

  function scrollStep(selector) {
    const box = scrollContainerOf(selector);
    if (box) {
      const before = box.scrollTop;
      box.scrollTop = box.scrollHeight;
      return { moved: box.scrollTop !== before, height: box.scrollHeight };
    }
    const before = window.scrollY;
    window.scrollTo(0, document.documentElement.scrollHeight);
    return { moved: window.scrollY !== before, height: document.documentElement.scrollHeight };
  }

  // Scroll down until the page stops growing (infinite scroll / lazy content).
  async function autoScroll({ maxSteps = 30, pauseMs = 800, selector } = {}) {
    let lastHeight = 0;
    let stable = 0;
    for (let i = 0; i < maxSteps && stable < 2; i++) {
      const { height } = scrollStep(selector);
      await new Promise((r) => setTimeout(r, pauseMs));
      stable = height === lastHeight ? stable + 1 : 0;
      lastHeight = height;
    }
    return lastHeight;
  }

  // Wait until the list changes (new first item or more items) after a click/scroll.
  async function waitForChange(selector, prevFingerprint, timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 300));
      if (fingerprint(selector) !== prevFingerprint) {
        await new Promise((r) => setTimeout(r, 500)); // let the rest render
        return true;
      }
    }
    return false;
  }

  function fingerprint(selector) {
    const items = qsa(document, selector);
    return `${items.length}|${clean(items[0]?.textContent, 80)}|${clean(items[items.length - 1]?.textContent, 80)}`;
  }

  // ======================================================================
  // PAGE EXTRACTOR — named fields on detail pages
  // ======================================================================

  function readField(doc, f) {
    if (f.builtin) return BUILTINS[f.builtin]?.(doc) ?? '';
    const els = qsa(doc, f.selector);
    if (!els.length) return '';
    const val = (el) => {
      if (f.attr === 'text') return clean(el.innerText ?? el.textContent, 5000);
      if (f.attr === 'href') return abs(el.getAttribute('href'), doc);
      if (f.attr === 'src') return abs(el.currentSrc || el.getAttribute('src') || '', doc);
      if (f.attr === 'html') return el.innerHTML.slice(0, 20000);
      return el.getAttribute(f.attr) || '';
    };
    return f.multiple ? els.map(val).filter(Boolean).join(' | ') : val(els[0]);
  }

  const meta = (doc, sel) => doc.querySelector(sel)?.getAttribute('content') || '';
  const BUILTINS = {
    url: (doc) => baseOf(doc),
    title: (doc) => clean(doc.title, 500),
    h1: (doc) => textOf(doc.querySelector('h1')),
    description: (doc) => meta(doc, 'meta[name="description" i]') || meta(doc, 'meta[property="og:description"]'),
    canonical: (doc) => doc.querySelector('link[rel="canonical"]')?.href || '',
    og_image: (doc) => abs(meta(doc, 'meta[property="og:image"]'), doc),
    emails: (doc) => emails(doc).map((e) => e.email).join(', '),
    phones: (doc) => phones(doc).map((p) => p.phone).join(', '),
    socials: (doc) => social(doc).map((s) => s.url).join(', '),
    price: (doc) => meta(doc, 'meta[property="product:price:amount"]') || jsonLd(doc).find((o) => o.offers)?.offers?.price || prices(doc)[0]?.price || '',
    author: (doc) => meta(doc, 'meta[name="author" i]') || meta(doc, 'meta[property="article:author"]') || [jsonLd(doc).find((o) => o.author)?.author].flat()[0]?.name || '',
    published: (doc) => meta(doc, 'meta[property="article:published_time"]') || jsonLd(doc).find((o) => o.datePublished)?.datePublished || doc.querySelector('time[datetime]')?.getAttribute('datetime') || '',
    language: (doc) => doc.documentElement.lang || '',
    word_count: (doc) => String(readable(doc).words),
    // Google Maps place pages (stable aria / data-item-id hooks, not hashed class names)
    maps_name: (doc) => textOf(doc.querySelector('h1')),
    maps_rating: (doc) => (doc.querySelector('[role="img"][aria-label*="star" i]')?.getAttribute('aria-label') || '').match(/[\d.,]+/)?.[0] || '',
    maps_reviews: (doc) => (doc.querySelector('[aria-label*="review" i]')?.getAttribute('aria-label') || '').match(/[\d.,]+(?=\s*review)/i)?.[0] || '',
    maps_category: (doc) => textOf(doc.querySelector('button[jsaction*="category"]')),
    maps_address: (doc) => clean(doc.querySelector('[data-item-id="address"]')?.getAttribute('aria-label')?.replace(/^address:\s*/i, '') || '', 300),
    maps_phone: (doc) => clean(doc.querySelector('[data-item-id^="phone"]')?.getAttribute('aria-label')?.replace(/^phone:\s*/i, '') || '', 60),
    maps_website: (doc) => doc.querySelector('a[data-item-id="authority"]')?.href || '',
    maps_hours: (doc) => clean(doc.querySelector('[aria-label*="hours" i][aria-label*="day" i]')?.getAttribute('aria-label') || '', 600),
    main_text: (doc) => readable(doc).text.slice(0, 20000),
  };

  // schema.org JSON-LD objects on the page (products, organizations, articles…)
  function jsonLd(doc = document) {
    const out = [];
    for (const s of qsa(doc, 'script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        const walk = (o) => {
          if (Array.isArray(o)) o.forEach(walk);
          else if (o && typeof o === 'object') {
            if (o['@graph']) walk(o['@graph']);
            const offers = Array.isArray(o.offers) ? o.offers[0] : o.offers;
            out.push({ ...o, offers });
          }
        };
        walk(data);
      } catch { /* ignore malformed blocks */ }
    }
    return out;
  }

  function extractPage(fields, doc = document) {
    const row = {};
    for (const f of fields) {
      try { row[f.name] = readField(doc, f); } catch { row[f.name] = ''; }
    }
    return pack([row]);
  }

  // ======================================================================
  // PAGE TEXT — readability-style main content
  // ======================================================================

  function readable(doc = document) {
    const body = doc.body;
    if (!body) return { title: doc.title, text: '', markdown: '', words: 0 };
    const bad = /comment|sidebar|footer|header|nav|menu|related|share|social|promo|advert|cookie|banner|popup|newsletter|breadcrumb/i;
    // Pick the block with the most paragraph text (siblings' paragraphs count towards their parent).
    const scores = new Map();
    for (const p of qsa(body, 'p, pre, li, h2, h3, blockquote, td')) {
      const len = clean(p.textContent, 100000).length;
      if (len < 25) continue;
      let score = 1 + Math.min(len / 100, 3) + (p.textContent.match(/,/g) || []).length * 0.2;
      for (let el = p.parentElement, d = 0; el && el !== doc.documentElement && d < 4; el = el.parentElement, d++) {
        const penalty = bad.test(`${el.className} ${el.id}`) || el.matches('nav,footer,aside,header') ? 0.2 : 1;
        scores.set(el, (scores.get(el) || 0) + (score * penalty) / (d + 1));
      }
    }
    let best = qsa(body, 'article, main, [role="main"]')[0] || body;
    let bestScore = 0;
    for (const [el, s] of scores) if (s > bestScore) { best = el; bestScore = s; }

    const lines = [];
    const walk = (el) => {
      for (const node of el.childNodes) {
        if (node.nodeType === 3) continue;
        if (node.nodeType !== 1 || node.matches('script,style,noscript,nav,footer,aside,form,button,svg,iframe')) continue;
        if (bad.test(`${node.className} ${node.id}`) && node !== best) continue;
        const tag = node.tagName;
        const t = clean(node.innerText ?? node.textContent, 20000);
        if (/^H[1-6]$/.test(tag)) { if (t) lines.push(`${'#'.repeat(+tag[1])} ${t}`); }
        else if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'PRE') { if (t) lines.push(tag === 'BLOCKQUOTE' ? `> ${t}` : tag === 'PRE' ? '```\n' + (node.textContent || '').trim() + '\n```' : t); }
        else if (tag === 'LI') { if (t) lines.push(`- ${t}`); }
        else if (tag === 'IMG') { const src = abs(node.getAttribute('src') || '', doc); if (src) lines.push(`![${clean(node.alt, 100)}](${src})`); }
        else if (tag === 'TABLE') { if (t) lines.push(t); }
        else if (node.children.length) walk(node);
        else if (t) lines.push(t);
      }
    };
    walk(best);
    const markdown = lines.join('\n\n');
    const plain = markdown.replace(/^#+ |^- |^> |!\[[^\]]*\]\([^)]*\)/gm, '').replace(/```\n?/g, '');
    return { title: clean(doc.title, 500), text: plain.trim(), markdown, words: (plain.match(/\S+/g) || []).length };
  }

  // ======================================================================
  // contacts for the Email / Social crawlers
  // ======================================================================

  const CONTACT_LINK = /contact|about|impressum|imprint|team|support|kontakt|contacto|contatti|nous-contacter|legal|company|reach|get-in-touch/i;
  function contacts(doc = document) {
    const host = hostOf(doc).replace(/^www\./, '');
    const contactLinks = [];
    for (const a of qsa(doc, 'a[href]')) {
      const url = abs(a.getAttribute('href'), doc);
      let u;
      try { u = new URL(url); } catch { continue; }
      if (!/^https?:$/.test(u.protocol) || u.host.replace(/^www\./, '') !== host) continue;
      if (CONTACT_LINK.test(u.pathname) || CONTACT_LINK.test(clean(a.textContent, 40))) contactLinks.push(u.href.split('#')[0]);
    }
    return {
      emails: emails(doc),
      phones: phones(doc),
      socials: social(doc),
      contactLinks: [...new Set(contactLinks)].slice(0, 10),
      title: doc.title,
    };
  }

  function pageText(maxChars, doc = document) {
    const t = (doc.body ? docText(doc) : '').replace(/\n{3,}/g, '\n\n').trim();
    return { url: baseOf(doc), title: doc.title, text: t.slice(0, maxChars), truncated: t.length > maxChars, length: t.length };
  }

  // ======================================================================
  // highlighting + point-and-click picker
  // ======================================================================

  const HL_ID = '__wse_highlight';
  function highlight(selector, { color = '#6366f1', max = 300 } = {}) {
    clearHighlight();
    const els = qsa(document, selector).slice(0, max);
    const layer = document.createElement('div');
    layer.id = HL_ID;
    layer.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2147483646';
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const box = document.createElement('div');
      box.style.cssText = `position:absolute;left:${r.left + scrollX}px;top:${r.top + scrollY}px;width:${r.width}px;height:${r.height}px;outline:2px solid ${color};background:${color}22;border-radius:3px`;
      layer.append(box);
    }
    document.documentElement.append(layer);
    els[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return els.length;
  }
  function clearHighlight() { document.getElementById(HL_ID)?.remove(); }

  let picker = null;
  const PICK_HINT = {
    list: 'Click one item of the list',
    field: 'Click the element to extract',
    element: 'Click the button to use',
    selector: 'Click an element',
  };

  function startPicker(mode = 'selector') {
    stopPicker();
    clearHighlight();
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #6366f1;background:rgba(99,102,241,.15);border-radius:3px';
    const tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#111827;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:4px 8px;border-radius:4px;max-width:460px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    document.documentElement.append(box, tip);
    let current = null;

    const onMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === current || el === box || el === tip) return;
      current = el;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      let info = '';
      if (mode === 'list') {
        const sib = similarSiblings(el.closest('li,tr,article') || el);
        info = sib.length > 1 ? ` · ${sib.length} similar` : '';
      } else if (mode === 'selector') {
        const sel = selectorFor(el);
        info = ` · ${qsa(document, sel).length} matches`;
      }
      tip.textContent = `${PICK_HINT[mode]} — <${el.tagName.toLowerCase()}> ${clean(el.textContent, 40)}${info}   (Esc to cancel)`;
      tip.style.left = Math.max(0, Math.min(r.left, innerWidth - 470)) + 'px';
      tip.style.top = (r.top > 30 ? r.top - 26 : r.bottom + 4) + 'px';
    };
    const finish = (result) => {
      stopPicker();
      chrome.runtime.sendMessage({ type: 'PICKER_RESULT', mode, ...result });
    };
    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (!current) return;
      try {
        finish(resultFor(mode, current));
      } catch (err) {
        finish({ error: String(err.message || err) });
      }
    };
    const block = (e) => { e.preventDefault(); e.stopPropagation(); };
    const onKey = (e) => { if (e.key === 'Escape') finish({ cancelled: true }); };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', block, true);
    document.addEventListener('mouseup', block, true);
    document.addEventListener('keydown', onKey, true);
    picker = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mousedown', block, true);
      document.removeEventListener('mouseup', block, true);
      document.removeEventListener('keydown', onKey, true);
      box.remove();
      tip.remove();
    };
  }

  function resultFor(mode, el) {
    if (mode === 'list') return { candidates: listsFromElement(el) };
    if (mode === 'field') {
      const a = el.closest('a[href]');
      const img = el.tagName === 'IMG' ? el : null;
      return {
        selector: selectorFor(el, { unique: true }),
        name: fieldNameFrom(el),
        sample: clean(el.innerText ?? el.textContent, 120),
        attrs: [
          'text',
          ...(a ? ['href'] : []),
          ...(img ? ['src'] : []),
          ...[...el.attributes].map((x) => x.name).filter((n) => !/^(class|style|id|on)/.test(n)).slice(0, 8),
        ].filter((v, i, arr) => arr.indexOf(v) === i),
        defaultAttr: img ? 'src' : el.tagName === 'A' ? 'text' : 'text',
      };
    }
    if (mode === 'element') {
      const target = el.closest('a,button,[role="button"]') || el;
      return { selector: selectorFor(target), text: clean(target.innerText || target.getAttribute('aria-label'), 60) };
    }
    const sel = selectorFor(el);
    return { selector: sel, count: qsa(document, sel).length };
  }

  function stopPicker() {
    if (picker) picker();
    picker = null;
  }

  globalThis.__webScraper = {
    // quick scan
    quick, findNextUrl,
    // list extractor
    listsFromElement, autoDetectLists, describeSelector, extractList, fingerprint, waitForChange,
    findNextButton, findLoadMoreButton, clickElement, fillInput, scrollStep, autoScroll,
    // page extractor
    extractPage, jsonLd, BUILTIN_FIELDS: Object.keys(BUILTINS),
    // text / contacts / AI
    readable, contacts, pageText,
    // picker + highlight
    startPicker, stopPicker, highlight, clearHighlight,
    countSelector: (s) => qsa(document, s).length,
    // exposed for background parsing in the side panel
    _internal: { emails, phones, social, images, links },
  };
})();
