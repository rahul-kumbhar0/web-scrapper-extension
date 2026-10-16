// Sitemap discovery + crawling: robots.txt "Sitemap:" lines, then common locations.
// Follows sitemap indexes, reads .xml.gz, stops at maxUrls.
import { fetchText } from './net.js';

const COMMON = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml', '/sitemap.xml.gz'];

export async function discoverSitemaps(origin, { signal } = {}) {
  const found = [];
  try {
    const robots = await fetchText(`${origin}/robots.txt`, { signal, timeoutMs: 10000 });
    for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) found.push(new URL(m[1], origin).href);
  } catch { /* no robots.txt */ }
  if (!found.length) {
    for (const path of COMMON) {
      try {
        const xml = await fetchText(origin + path, { signal, timeoutMs: 10000 });
        if (/<(urlset|sitemapindex)\b/i.test(xml)) { found.push(origin + path); break; }
      } catch { /* try next */ }
    }
  }
  return [...new Set(found)];
}

const nodesText = (doc, parent, child) =>
  [...doc.getElementsByTagNameNS('*', parent)].map((n) => {
    const get = (name) => n.getElementsByTagNameNS('*', name)[0]?.textContent.trim() || '';
    return Object.fromEntries(child.map((c) => [c, get(c)]));
  });

export async function crawlSitemaps(roots, { maxUrls = 50000, maxSitemaps = 200, signal, onProgress } = {}) {
  const queue = [...roots];
  const visited = new Set();
  const rows = [];
  const seen = new Set();
  const errors = [];
  while (queue.length && rows.length < maxUrls && visited.size < maxSitemaps && !signal?.aborted) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    let xml;
    try {
      xml = await fetchText(url, { signal });
    } catch (e) {
      errors.push({ sitemap: url, error: String(e.message || e) });
      continue;
    }
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    for (const s of nodesText(doc, 'sitemap', ['loc'])) if (s.loc) queue.push(s.loc);
    for (const u of nodesText(doc, 'url', ['loc', 'lastmod', 'changefreq', 'priority'])) {
      if (!u.loc || seen.has(u.loc)) continue;
      seen.add(u.loc);
      rows.push({ url: u.loc, lastmod: u.lastmod, sitemap: url, section: sectionOf(u.loc) });
      if (rows.length >= maxUrls) break;
    }
    onProgress?.(rows.length, visited.size);
  }
  return { rows, sitemaps: [...visited], errors };
}

// First path segment, used for the folder-style grouping ("/blog", "/products"…).
export function sectionOf(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean)[0];
    return seg ? `/${seg}` : '/';
  } catch {
    return '';
  }
}

// "/blog/" is a path; "/^.*\\/p\\/\\d+/" (or anything with regex syntax) is a regular expression.
export function urlMatcher(filter) {
  const f = String(filter || '').trim();
  if (!f) return () => true;
  const re = f.match(/^\/(.+)\/([a-z]*)$/);
  // Nested quantifiers like (a+)+ can take forever on long URLs — treat those as plain text.
  if (re && /[\\^$.|?*+()[\]{}]/.test(re[1]) && re[1].length <= 200 && !/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(re[1])) {
    try { const r = new RegExp(re[1], re[2] || 'i'); return (u) => r.test(u); } catch { return () => false; }
  }
  return (u) => u.toLowerCase().includes(f.toLowerCase());
}
