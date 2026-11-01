// SEARCH ANY SITE — turn "a site + what to look for" into that site's own search-results page, so
// the list extractor can take it from there. Four ways, tried in order:
//   1. a preset for well-known sites (fastest, and knows the right sort / filters);
//   2. the site's sitelinks search box (JSON-LD SearchAction with a {search_term_string} template);
//   3. its OpenSearch description (<link rel="search" type="application/opensearchdescription+xml">);
//   4. the search form on its home page (a GET form with a text / search input);
// and, failing all of those, the common /search?q= guess.
const enc = encodeURIComponent;

export const SEARCH_PRESETS = [
  // Reddit refuses search.json on www; the old UI still serves search pages and JSON.
  { name: 'Reddit', match: /(^|\.)reddit\.com$/, url: (q) => `https://old.reddit.com/search?q=${enc(q)}&sort=top&t=week` },
  { name: 'YouTube', match: /(^|\.)youtube\.com$/, url: (q) => `https://www.youtube.com/results?search_query=${enc(q)}` },
  { name: 'Amazon', match: /(^|\.)amazon\.[a-z.]+$/, url: (q, h) => `https://${h.replace(/^(?!www\.)/, 'www.')}/s?k=${enc(q)}` },
  { name: 'Flipkart', match: /(^|\.)flipkart\.com$/, url: (q) => `https://www.flipkart.com/search?q=${enc(q)}` },
  { name: 'eBay', match: /(^|\.)ebay\.[a-z.]+$/, url: (q, h) => `https://${h.replace(/^(?!www\.)/, 'www.')}/sch/i.html?_nkw=${enc(q)}` },
  { name: 'Etsy', match: /(^|\.)etsy\.com$/, url: (q) => `https://www.etsy.com/search?q=${enc(q)}` },
  { name: 'Walmart', match: /(^|\.)walmart\.com$/, url: (q) => `https://www.walmart.com/search?q=${enc(q)}` },
  { name: 'AliExpress', match: /(^|\.)aliexpress\.[a-z.]+$/, url: (q) => `https://www.aliexpress.com/w/wholesale-${enc(q.replace(/\s+/g, '-'))}.html` },
  { name: 'Google Maps', match: /(^|\.)google\.[a-z.]+$/, url: (q) => `https://www.google.com/maps/search/${enc(q)}`, only: /maps/ },
  { name: 'Google Maps', match: /^maps\.google\.[a-z.]+$/, url: (q) => `https://www.google.com/maps/search/${enc(q)}` },
  { name: 'LinkedIn Jobs', match: /(^|\.)linkedin\.com$/, url: (q) => `https://www.linkedin.com/jobs/search/?keywords=${enc(q)}` },
  { name: 'Indeed', match: /(^|\.)indeed\.[a-z.]+$/, url: (q, h) => `https://${h.replace(/^(?!www\.)/, 'www.')}/jobs?q=${enc(q)}` },
  { name: 'Naukri', match: /(^|\.)naukri\.com$/, url: (q) => `https://www.naukri.com/${enc(q.trim().replace(/\s+/g, '-'))}-jobs` },
  { name: 'GitHub', match: /(^|\.)github\.com$/, url: (q) => `https://github.com/search?q=${enc(q)}&type=repositories` },
  { name: 'Stack Overflow', match: /(^|\.)stackoverflow\.com$/, url: (q) => `https://stackoverflow.com/search?q=${enc(q)}` },
  { name: 'Hacker News', match: /(^|\.)(news\.ycombinator\.com|hn\.algolia\.com)$/, url: (q) => `https://hn.algolia.com/?q=${enc(q)}&sort=byPopularity` },
  { name: 'Product Hunt', match: /(^|\.)producthunt\.com$/, url: (q) => `https://www.producthunt.com/search?q=${enc(q)}` },
  { name: 'X', match: /(^|\.)(x|twitter)\.com$/, url: (q) => `https://x.com/search?q=${enc(q)}&src=typed_query&f=top` },
  { name: 'TikTok', match: /(^|\.)tiktok\.com$/, url: (q) => `https://www.tiktok.com/search?q=${enc(q)}` },
  { name: 'Instagram', match: /(^|\.)instagram\.com$/, url: (q) => `https://www.instagram.com/explore/search/keyword/?q=${enc(q.replace(/#/g, ''))}` },
  { name: 'Pinterest', match: /(^|\.)pinterest\.[a-z.]+$/, url: (q) => `https://www.pinterest.com/search/pins/?q=${enc(q)}` },
  { name: 'Wikipedia', match: /(^|\.)wikipedia\.org$/, url: (q, h) => `https://${/^[a-z]{2,3}\.wikipedia\.org$/.test(h) ? h : 'en.wikipedia.org'}/w/index.php?search=${enc(q)}&fulltext=1` },
  { name: 'Quora', match: /(^|\.)quora\.com$/, url: (q) => `https://www.quora.com/search?q=${enc(q)}` },
  { name: 'Medium', match: /(^|\.)medium\.com$/, url: (q) => `https://medium.com/search?q=${enc(q)}` },
  { name: 'DEV', match: /(^|\.)dev\.to$/, url: (q) => `https://dev.to/search?q=${enc(q)}` },
  { name: 'npm', match: /(^|\.)npmjs\.com$/, url: (q) => `https://www.npmjs.com/search?q=${enc(q)}` },
  { name: 'PyPI', match: /(^|\.)pypi\.org$/, url: (q) => `https://pypi.org/search/?q=${enc(q)}` },
  { name: 'Yelp', match: /(^|\.)yelp\.[a-z.]+$/, url: (q) => `https://www.yelp.com/search?find_desc=${enc(q)}` },
  { name: 'Zillow', match: /(^|\.)zillow\.com$/, url: (q) => `https://www.zillow.com/homes/${enc(q.trim().replace(/\s+/g, '-'))}_rb/` },
  { name: 'G2', match: /(^|\.)g2\.com$/, url: (q) => `https://www.g2.com/search?query=${enc(q)}` },
  { name: 'Capterra', match: /(^|\.)capterra\.com$/, url: (q) => `https://www.capterra.com/search/?search=${enc(q)}` },
  { name: 'Booking.com', match: /(^|\.)booking\.com$/, url: (q) => `https://www.booking.com/searchresults.html?ss=${enc(q)}` },
  { name: 'IMDb', match: /(^|\.)imdb\.com$/, url: (q) => `https://www.imdb.com/find/?q=${enc(q)}` },
  { name: 'Bing', match: /(^|\.)bing\.com$/, url: (q) => `https://www.bing.com/search?q=${enc(q)}` },
  { name: 'DuckDuckGo', match: /(^|\.)duckduckgo\.com$/, url: (q) => `https://html.duckduckgo.com/html/?q=${enc(q)}` },
  { name: 'Google', match: /(^|\.)google\.[a-z.]+$/, url: (q) => `https://www.google.com/search?q=${enc(q)}` },
];

/** "amazon.in", "https://www.etsy.com/shop/x", "Reddit" → a site URL (or '' when it isn't one). */
export function siteUrl(site) {
  let s = String(site || '').trim();
  if (!s) return '';
  // A bare name ("reddit", "linkedin", "amazon") → that preset's host.
  if (!/[./]/.test(s)) {
    const key = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const named = SEARCH_PRESETS.find((p) => { const n = p.name.toLowerCase().replace(/[^a-z0-9]/g, ''); return n === key || n.startsWith(key) || key.startsWith(n); });
    if (named) s = named.url('x', `www.${key}.com`).replace(/^https?:\/\/([^/]+).*$/, '$1');
  }
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  try {
    const u = new URL(s);
    return /\./.test(u.hostname) || u.hostname === 'localhost' ? u.href : '';
  } catch { return ''; }
}

/** A preset search URL for the site, or null when there is none. */
export function presetSearchUrl(site, query) {
  const url = siteUrl(site);
  if (!url) return null;
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  for (const p of SEARCH_PRESETS) {
    if (!p.match.test(host)) continue;
    if (p.only && !p.only.test(u.pathname) && !p.only.test(host)) continue;
    return { url: p.url(String(query), host), how: 'preset', name: p.name };
  }
  return null;
}

const tmpl = (t, q) => t.replace(/\{(search_term_string|searchTerms|query|q)\??\}/gi, enc(q)).replace(/\{[^}]*\?\}/g, '');

/** Resolve a site's search-results URL for a query. io.fetchDoc(url, {signal}) → {doc, url}. */
export async function searchUrlFor(site, query, io) {
  const q = String(query || '').trim();
  if (!q) throw new Error('What should I search for? Give a query.');
  const url = siteUrl(site);
  if (!url) throw new Error(`"${site}" doesn't look like a website. Give a domain like amazon.in or a URL.`);
  const preset = presetSearchUrl(url, q);
  if (preset) return preset;
  const home = new URL(url);
  let doc;
  let pageUrl = home.href;
  try { ({ doc, url: pageUrl } = await io.fetchDoc(home.href, { signal: io.signal })); } catch (e) {
    if (io.signal?.aborted) throw e;
    return { url: `${home.origin}/search?q=${enc(q)}`, how: 'guess', note: `Could not read ${home.hostname} (${String(e.message || e).slice(0, 80)}); trying the usual /search?q= address.` };
  }
  const found = fromJsonLd(doc, pageUrl, q) || (await fromOpenSearch(doc, pageUrl, q, io)) || fromForm(doc, pageUrl, q);
  if (found) return found;
  return { url: `${home.origin}/search?q=${enc(q)}`, how: 'guess', note: `${home.hostname} has no search box PullRows could find; trying the usual /search?q= address.` };
}

function fromJsonLd(doc, pageUrl, q) {
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try { data = JSON.parse(s.textContent); } catch { continue; }
    const items = [];
    const walk = (o) => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk); if (o.potentialAction) items.push(...[o.potentialAction].flat()); for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v); };
    walk(data);
    for (const a of items) {
      const t = a?.target?.urlTemplate || (typeof a?.target === 'string' ? a.target : '');
      if (!t || !/\{/.test(t) || !/search/i.test(String(a['@type'] || '') + t)) continue;
      try { return { url: new URL(tmpl(t, q), pageUrl).href, how: 'sitelinks' }; } catch { /* bad template */ }
    }
  }
  return null;
}

async function fromOpenSearch(doc, pageUrl, q, io) {
  const link = doc.querySelector('link[rel~="search"][type*="opensearchdescription"]');
  if (!link) return null;
  try {
    const { doc: xml } = await io.fetchDoc(new URL(link.getAttribute('href'), pageUrl).href, { signal: io.signal });
    const urls = [...xml.querySelectorAll('Url, url')];
    const html = urls.find((u) => /text\/html/i.test(u.getAttribute('type') || '')) || urls[0];
    const t = html?.getAttribute('template');
    if (!t) return null;
    return { url: new URL(tmpl(t, q), pageUrl).href, how: 'opensearch' };
  } catch (e) { if (io.signal?.aborted) throw e; return null; }
}

const QUERY_NAME = /^(q|s|query|search|search_query|searchterm|searchterms|keyword|keywords|term|k|text|find|wd|p|searchtext|search_text)$/i;

function fromForm(doc, pageUrl, q) {
  const forms = [...doc.querySelectorAll('form')].filter((f) => !/post/i.test(f.getAttribute('method') || ''));
  const score = (f) => {
    const input = f.querySelector('input[type="search"]') || [...f.querySelectorAll('input:not([type]), input[type="text"]')].find((i) => QUERY_NAME.test(i.name || '') || /search/i.test(`${i.id} ${i.placeholder} ${i.getAttribute('aria-label')}`)) || null;
    if (!input || !input.name) return null;
    const bad = /login|signin|sign-in|password|newsletter|subscribe|comment/i.test(`${f.id} ${f.className} ${f.getAttribute('action') || ''}`);
    return bad ? null : { f, input, pts: (/search/i.test(`${f.id} ${f.className} ${f.getAttribute('role')} ${f.getAttribute('action')}`) ? 2 : 0) + (input.type === 'search' ? 2 : 0) + (QUERY_NAME.test(input.name) ? 1 : 0) };
  };
  const best = forms.map(score).filter(Boolean).sort((a, b) => b.pts - a.pts)[0];
  if (!best) return null;
  let u;
  try { u = new URL(best.f.getAttribute('action') || pageUrl, pageUrl); } catch { return null; }
  for (const h of best.f.querySelectorAll('input[type="hidden"][name]')) u.searchParams.set(h.name, h.value || '');
  u.searchParams.set(best.input.name, q);
  return { url: u.href, how: 'form' };
}
