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

  // Words a human would write: has a vowel and no long consonant runs ("price", "lockup", not "hfpxzc").
  const wordish = (w) => w.length >= 2 && /[aeiouy]/i.test(w) && !/[bcdfghjklmnpqrstvwxz]{4,}/i.test(w);
  const classWords = (c) => c.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[-_\s]+/).filter(Boolean);
  // Generated / obfuscated class names (CSS modules, styled-components, Google & Meta minified classes):
  // MW4etd, hfpxzc, UaQhfb, x1qjc9v5, LrSqpRBTdYAVrgYpUwCXkCOyGxSxCvvlaQ, sVfgkXaQeJziwXv…
  function looksHashed(c) {
    if (/^x[a-z0-9]{5,9}$/.test(c)) return true; // Meta (Instagram/Facebook) atomic CSS: x1i10hfl, xqjyukv
    if (!/[-_]/.test(c) && c.length >= 6 && (c.match(/[aeiou]/gi) || []).length / c.length < 0.2) return true;
    if (/\d/.test(c) && !/^(h|col|grid|span|level|step|page|tab|item|row|lg|md|sm|xl)-?\d+$/i.test(c)) return true;
    if (/^(css|sc|jsx|emotion|svelte|styled)-/i.test(c) || /^_/.test(c)) return true;
    if (!/[-_]/.test(c)) {
      if (c.length >= 20) return true;
      const caps = (c.match(/[A-Z]/g) || []).length;
      if (caps >= 2 && c.length <= 9) return true;
      if (caps >= 3 && caps / c.length > 0.2) return true;
    }
    return classWords(c).some((w) => w.length > 2 && !wordish(w));
  }
  // "Stable" classes: skip state classes and generated hashes.
  const stableClasses = (el) => [...el.classList].filter((c) =>
    /^[a-z_-][\w-]*$/i.test(c) && c.length < 40 && !looksHashed(c) &&
    !/^(is-|has-)?(active|hover|selected|focus|open|visible|hidden|current|loaded|lazy)$/i.test(c));

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
    const role = el.getAttribute('role');
    if (role && /^(feed|list|grid|listbox|table|tablist|main|region)$/.test(role)) {
      const label = el.getAttribute('aria-label');
      const byRole = `${el.tagName.toLowerCase()}[role="${role}"]`;
      if (qsa(doc, byRole).length === 1) return byRole;
      if (label && !label.includes('"')) { const byLabel = `${byRole}[aria-label="${label}"]`; if (qsa(doc, byLabel).length === 1) return byLabel; }
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

  const GENERIC_WORDS = /^(container|wrapper|wrap|inner|outer|content|contents|block|root|ember|view|item|items|card|cell|row|col|box|link|links|text|disabled|visually|hidden|main|body|section|component|module|el|elem|element|default|base|ui|js|x|is|has|the|of|font|small|medium|large|bold|regular|light|primary|secondary|full|entity|lockup|artdeco|t|flex|grid|clearfix|truncate|ellipsis|anchor|wide|mobile|desktop|show|hide|label|value|info|meta|detail|details|data|field|list|group|layout|style|styles|top|bottom|left|right|center|line|lines|area|part|piece|unit|tile|panel|pane|holder|outline|plain|normal|base|tiny|xs|sm|md|lg|xl)$/i;
  const SEMANTIC = [
    [/headline|heading|title|name|subject/i, 'title'], [/price|amount|cost|fare/i, 'price'], [/rating|stars?|score/i, 'rating'],
    [/reviews?|ratings?count/i, 'reviews'], [/date|time|posted|ago|published/i, 'date'], [/author|byline|user(name)?|creator/i, 'author'],
    [/company|employer|brand|vendor|seller|shop|store/i, 'company'], [/location|address|city|place|region/i, 'location'],
    [/desc|summary|excerpt|snippet|caption|body/i, 'description'], [/phone|tel/i, 'phone'], [/email|mail/i, 'email'],
    [/category|tag|type|genre/i, 'category'], [/thumb|image|img|photo|picture|avatar|logo/i, 'image'], [/subtitle/i, 'subtitle'], [/caption/i, 'caption'],
  ];
  // Readable hint from itemprop / data-testid / meaningful class names (BEM element part preferred).
  function nameHint(el) {
    const attr = el.getAttribute('itemprop') || el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (attr && !looksHashed(attr.replace(/[^\w-]/g, ''))) return classWords(attr).join(' ').toLowerCase();
    for (const c of stableClasses(el)) {
      const part = c.includes('__') ? c.split('__').pop().split('--')[0] : c.split('--')[0];
      const words = classWords(part).filter((w) => !GENERIC_WORDS.test(w) && wordish(w));
      if (!words.length) continue;
      const phrase = words.slice(-2).join(' ').toLowerCase();
      const sem = SEMANTIC.find(([re]) => re.test(phrase));
      return sem ? sem[1] : phrase;
    }
    return '';
  }
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
    return nameHint(el) || (/^(A|SPAN|STRONG|B|EM)$/.test(el.tagName) && el.parentElement ? nameHint(el.parentElement) : '');
  };
  const TAG_NAMES = { h1: 'title', h2: 'title', h3: 'title', h4: 'subtitle', h5: 'subtitle', p: 'description', time: 'date', img: 'image', strong: 'title', b: 'title' };

  // Name a column from what its values look like (most reliable on sites with obfuscated classes).
  function nameFromValues(values) {
    const v = values.filter(Boolean).slice(0, 40);
    if (!v.length) return '';
    const share = (re) => v.filter((x) => re.test(x)).length / v.length >= 0.6;
    if (share(/^\(\s*[\d.,]+\s*[KkMm]?\s*\)$/)) return 'reviews';
    if (share(/^[0-5]([.,]\d)?\s*(★|stars?|\/\s*5)?$/i)) return 'rating';
    if (share(/^[\d.,]+\s*[KkMm]?\s*(reviews?|ratings?)$/i)) return 'reviews';
    if (share(/^[\d.,]+\s*[KkMm]?\s*(views?|plays?)\b/i)) return 'views';
    if (share(/^[\d.,]+\s*[KkMm]?\s*likes?\b/i)) return 'likes';
    if (share(/^[\d.,]+\s*[KkMm]?\s*(comments?|replies)\b/i)) return 'comments';
    if (share(/(^|\s)(US\$|C\$|A\$|[$£€¥₹₩])\s?\d|\d\s?(USD|EUR|GBP|INR)\b/)) return 'price';
    if (share(/\b(ago|hours?|minutes?|days?|weeks?|months?|years?|yesterday|today|just now)\b|^\d{4}-\d{2}-\d{2}|^\d{1,2}\s\w{3,9}\s\d{4}$/i)) return 'date';
    if (share(/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i)) return 'email';
    if (share(/^\+?[\d\s().-]{7,}$/)) return 'phone';
    if (share(/\((remote|hybrid|on-site|onsite)\)|,\s*(india|usa|uk|canada|germany|france|australia|united states|united kingdom)\b/i)) return 'location';
    return '';
  }

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
        // Overlay links (Google Maps cards, image tiles) carry the name only in aria-label.
        const label = el.getAttribute('aria-label');
        if (label && !(el.textContent || '').trim()) push(el, 'aria-label', clean(label, 300));
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
    let titled = false;
    return fields.slice(0, 40).map((f) => {
      const values = [...f.values];
      const hint = fieldNameFrom(f.el);
      let base;
      if (f.attr === 'href') base = hint && !/^(title|link)$/.test(hint) ? `${hint} link` : 'link';
      else if (f.attr === 'src') base = 'image';
      else if (f.attr === 'datetime') base = 'date';
      else if (f.attr === 'aria-label') base = 'name';
      else {
        const fromValues = nameFromValues(values);
        const tagName = TAG_NAMES[f.el.tagName.toLowerCase()] || (f.el.closest('h1,h2,h3,h4') ? 'title' : '');
        base = fromValues || (hint && hint !== 'image' ? hint : '') || tagName;
        // The first longish text column is usually the item's title.
        if (!base || base === 'text') {
          const avg = values.reduce((n, x) => n + x.length, 0) / (values.length || 1);
          base = !titled && avg >= 6 && avg <= 160 ? 'title' : 'text';
        }
      }
      if (base === 'title') titled = true;
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
    const tag = items[0].tagName.toLowerCase();
    // A data-* attribute every item carries (data-occludable-job-id, data-asin, data-id…) is the most stable hook.
    const dataAttrs = [...items[0].attributes].map((a) => a.name)
      .filter((n) => /^data-[\w-]+$/.test(n) && !/^data-v-|^data-(state|index|testid|test)$/.test(n) && items.every((i) => i.hasAttribute(n)));
    for (const a of dataAttrs) if (ok(`${tag}[${a}]`)) return `${tag}[${a}]`;
    const parentSel = selectorFor(items[0].parentElement, { unique: true });
    for (const a of dataAttrs) if (ok(`${parentSel} > ${tag}[${a}]`)) return `${parentSel} > ${tag}[${a}]`;
    if (!items[0].classList.length && items.every((i) => !i.classList.length) && ok(`${parentSel} > ${tag}:not([class])`)) return `${parentSel} > ${tag}:not([class])`;
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
    const preset = presetFor(el.ownerDocument);
    if (preset && qsa(el.ownerDocument, preset.itemSelector).some((item) => item.contains(el))) return [preset, ...listsFromGeneric(el)].slice(0, 5);
    return listsFromGeneric(el);
  }

  function listsFromGeneric(el) {
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
    const preset = presetFor(doc);
    const rest = autoDetectGeneric(doc).filter((c) => !preset || c.itemSelector !== preset.itemSelector);
    return preset ? [preset, ...rest].slice(0, 6) : rest;
  }

  function autoDetectGeneric(doc = document) {
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

  // ======================================================================
  // SITE PRESETS — exact list setups for big sites whose markup is obfuscated.
  // Recognised by page structure (works on google.de, in.linkedin.com…), checked before auto-detect.
  // ======================================================================

  const host = (doc) => hostOf(doc).replace(/^www\./, '');
  const PRESETS = [
    {
      name: 'Google Maps results',
      match: (doc) => qsa(doc, '[role="feed"] a.hfpxzc').length > 0,
      itemSelector: '[role="feed"] > div:has(a.hfpxzc)',
      fields: [
        { name: 'name', path: 'a.hfpxzc', attr: 'aria-label' },
        { name: 'rating', path: 'span.MW4etd', attr: 'text' },
        { name: 'reviews', path: 'span.UY7F9', attr: 'text' },
        { name: 'category', path: '.W4Efsd .W4Efsd:first-child > span:first-child', attr: 'text' },
        { name: 'address', path: '.W4Efsd .W4Efsd:first-child > span:last-child', attr: 'text' },
        { name: 'status', path: '.W4Efsd .W4Efsd:nth-child(2)', attr: 'text' },
        { name: 'details', path: '.UaQhfb', attr: 'text' },
        { name: 'website', path: 'a[data-value="Website"]', attr: 'href' },
        { name: 'maps_link', path: 'a.hfpxzc', attr: 'href' },
      ],
      pagination: { mode: 'scroll', max: 60 },
    },
    {
      name: 'LinkedIn jobs',
      match: (doc) => qsa(doc, 'li[data-occludable-job-id]').length > 0,
      itemSelector: 'li[data-occludable-job-id]',
      fields: [
        { name: 'title', path: 'a[href*="/jobs/view/"] strong || .job-card-list__title || a[href*="/jobs/view/"]', attr: 'text' },
        { name: 'company', path: '.artdeco-entity-lockup__subtitle', attr: 'text' },
        { name: 'location', path: '.artdeco-entity-lockup__caption', attr: 'text' },
        { name: 'posted', path: 'time', attr: 'text' },
        { name: 'job_id', path: ':scope', attr: 'data-occludable-job-id' },
        { name: 'link', path: 'a[href*="/jobs/view/"]', attr: 'href' },
      ],
      pagination: { mode: 'next', selector: 'button[aria-label="View next page"], button.jobs-search-pagination__button--next', max: 5 },
    },
    {
      name: 'LinkedIn jobs (public)',
      match: (doc) => qsa(doc, 'ul.jobs-search__results-list > li').length > 0,
      itemSelector: 'ul.jobs-search__results-list > li',
      fields: [
        { name: 'title', path: '.base-search-card__title', attr: 'text' },
        { name: 'company', path: '.base-search-card__subtitle', attr: 'text' },
        { name: 'location', path: '.job-search-card__location', attr: 'text' },
        { name: 'posted', path: 'time', attr: 'text' },
        { name: 'link', path: 'a.base-card__full-link || a', attr: 'href' },
      ],
      pagination: { mode: 'scroll', max: 30 },
    },
    {
      name: 'Instagram posts',
      match: (doc) => (/instagram\.com$/.test(host(doc)) || !!doc.querySelector('meta[property="al:ios:app_name"][content="Instagram"]')) &&
        qsa(doc, 'a[href*="/p/"], a[href*="/reel/"]').length > 2,
      itemSelector: 'main a[href*="/p/"], main a[href*="/reel/"]',
      fields: [
        { name: 'link', path: ':scope', attr: 'href' },
        { name: 'caption', path: 'img', attr: 'alt' },
        { name: 'image', path: 'img', attr: 'src' },
      ],
      pagination: { mode: 'scroll', max: 60 },
    },
    {
      name: 'YouTube videos',
      match: (doc) => qsa(doc, 'ytd-video-renderer, ytd-rich-item-renderer, ytd-grid-video-renderer').length > 0,
      itemSelector: 'ytd-video-renderer, ytd-rich-item-renderer, ytd-grid-video-renderer',
      fields: [
        { name: 'title', path: '#video-title', attr: 'text' },
        { name: 'channel', path: 'ytd-channel-name a || #channel-name', attr: 'text' },
        { name: 'meta', path: '#metadata-line span', attr: 'text', multiple: true },
        { name: 'duration', path: 'ytd-thumbnail-overlay-time-status-renderer #text || badge-shape .yt-badge-shape__text', attr: 'text' },
        { name: 'link', path: 'a#video-title-link || a#video-title || a#thumbnail', attr: 'href' },
        { name: 'thumbnail', path: 'img', attr: 'src' },
      ],
      pagination: { mode: 'scroll', max: 40 },
    },
    {
      name: 'Amazon search',
      match: (doc) => qsa(doc, 'div[data-component-type="s-search-result"]').length > 0,
      itemSelector: 'div[data-component-type="s-search-result"][data-asin]:not([data-asin=""])',
      fields: [
        { name: 'title', path: 'h2 span || h2', attr: 'text' },
        { name: 'price', path: '.a-price:not(.a-text-price) .a-offscreen', attr: 'text' },
        { name: 'list_price', path: '.a-text-price .a-offscreen', attr: 'text' },
        { name: 'rating', path: '.a-icon-alt', attr: 'text' },
        { name: 'reviews', path: 'a[href*="customerReviews"] span || span.s-underline-text', attr: 'text' },
        { name: 'asin', path: ':scope', attr: 'data-asin' },
        { name: 'link', path: 'h2 a || a.a-link-normal.s-no-outline', attr: 'href' },
        { name: 'image', path: 'img.s-image', attr: 'src' },
      ],
      pagination: { mode: 'next', selector: 'a.s-pagination-next:not(.s-pagination-disabled)', max: 5 },
    },
  ];

  const stripQuery = (u) => { try { const x = new URL(u); x.search = ''; return x.href; } catch { return u; } };
  const PRESET_POST = {
    'Google Maps results': (r) => {
      if (r.address === r.category) r.address = '';
      if (/^(open|closed|closes|opens)/i.test(r.address)) r.address = '';
      return r;
    },
    'LinkedIn jobs': (r) => { r.title = r.title.replace(/\s+with verification$/i, ''); r.link = r.link && stripQuery(r.link); return r; },
    'LinkedIn jobs (public)': (r) => { r.link = r.link && stripQuery(r.link); return r; },
  };

  function presetFor(doc = document) {
    const p = PRESETS.find((x) => { try { return x.match(doc); } catch { return false; } });
    if (!p) return null;
    return { preset: p.name, itemSelector: p.itemSelector, count: qsa(doc, p.itemSelector).length, fields: p.fields.map((f) => ({ ...f, idx: 0 })), pagination: p.pagination, score: 1e9 };
  }

  const valueOf = (el, attr, doc) => {
    if (!el) return '';
    if (attr === 'text') return clean(el.innerText ?? el.textContent, 2000).replace(/^[\s·•|]+|[\s·•|]+$/g, '');
    if (attr === 'href') return abs(el.getAttribute('href'), doc);
    if (attr === 'src') return abs(el.currentSrc || el.getAttribute('src') || el.dataset.src || el.dataset.lazySrc || '', doc);
    return clean(el.getAttribute(attr) || '', 2000);
  };

  // One field of one item. `path` may list fallbacks: "a.title strong || a.title" (first non-empty wins).
  function readItemField(item, f, doc) {
    for (const path of String(f.path || ':scope').split('||').map((x) => x.trim())) {
      const els = path === ':scope' ? [item] : qsa(item, path);
      const v = f.multiple
        ? [...new Set(els.map((e) => valueOf(e, f.attr || 'text', doc)).filter(Boolean))].join(' · ')
        : valueOf(els[f.idx || 0], f.attr || 'text', doc);
      if (v) return v;
    }
    return '';
  }

  function extractList(config, doc = document) {
    const items = qsa(doc, config.itemSelector);
    const post = PRESET_POST[config.preset];
    const rows = items.map((item) => {
      const row = {};
      for (const f of config.fields) row[f.name] = readItemField(item, f, doc);
      return post ? post(row) : row;
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

  // The element that actually scrolls the list: the nearest scrollable ancestor of the items
  // (Google Maps' results feed, LinkedIn's job list pane, chat panels…), else the page itself.
  const canScroll = (el) => {
    const s = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 10;
  };
  function scrollContainerOf(selector) {
    const items = selector ? qsa(document, selector) : [];
    const probe = items[Math.floor(items.length / 2)] || items[0];
    for (let el = probe?.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (canScroll(el)) return el;
    }
    // Lists inside a well-known scrolling region even when no item is rendered yet.
    const region = qsa(document, '[role="feed"], [role="list"], [role="listbox"]').find(canScroll);
    return region || null;
  }

  // Scroll ONE screen further (not straight to the bottom): virtualised / lazy lists only render
  // what is on screen, so every step must be collected before moving on.
  function scrollStep(selector, { fraction = 0.8 } = {}) {
    const box = scrollContainerOf(selector);
    const el = box || document.scrollingElement || document.documentElement;
    const view = box ? box.clientHeight : innerHeight;
    const before = el.scrollTop;
    const max = el.scrollHeight - view;
    const next = Math.min(max, before + Math.max(150, view * fraction));
    el.scrollTop = next;
    // Some apps listen for wheel / scroll events rather than polling the position.
    (box || window).dispatchEvent(new Event('scroll', { bubbles: true }));
    (box || document).dispatchEvent(new WheelEvent('wheel', { deltaY: view * fraction, bubbles: true }));
    const atBottom = el.scrollTop >= max - 2;
    if (atBottom && selector) {
      const items = qsa(document, selector);
      items[items.length - 1]?.scrollIntoView({ block: 'end' }); // nudges nested scrollers / sentinels
    }
    return { moved: el.scrollTop !== before, atBottom, top: el.scrollTop, height: el.scrollHeight, container: box ? 'panel' : 'page' };
  }

  // Chrome pauses lazy loading (IntersectionObserver, animation frames) in hidden / covered windows.
  const pageState = () => ({ visibility: document.visibilityState, focused: document.hasFocus() });

  // Scroll up a little and back down: re-triggers loaders that only react to fresh scroll movement.
  async function jiggle(selector) {
    const box = scrollContainerOf(selector);
    const el = box || document.scrollingElement || document.documentElement;
    const top = el.scrollTop;
    el.scrollTop = Math.max(0, top - 400);
    (box || window).dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    el.scrollTop = el.scrollHeight;
    (box || window).dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  }

  function scrollToTop(selector) {
    const box = scrollContainerOf(selector);
    (box || document.scrollingElement || document.documentElement).scrollTop = 0;
    return true;
  }

  // Scroll down until the page stops growing (infinite scroll / lazy content).
  async function autoScroll({ maxSteps = 40, pauseMs = 700, selector } = {}) {
    let lastHeight = 0;
    let stable = 0;
    for (let i = 0; i < maxSteps && stable < 3; i++) {
      const { height, atBottom } = scrollStep(selector);
      await new Promise((r) => setTimeout(r, pauseMs));
      stable = atBottom && height === lastHeight ? stable + 1 : 0;
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
    findNextButton, findLoadMoreButton, clickElement, fillInput, scrollStep, scrollToTop, jiggle, pageState, autoScroll, presetFor,
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
