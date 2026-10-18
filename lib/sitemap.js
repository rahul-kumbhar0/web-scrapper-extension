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

function riskyRegex(src) {
  if (/\\[1-9]|\(\?<?[=!]/.test(src)) return true;
  // Find every group; risky if it is followed by a quantifier and contains a quantifier or alternation.
  const stack = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '(') stack.push(i);
    else if (c === ')' && stack.length) {
      const start = stack.pop();
      const inner = src.slice(start + 1, i);
      if (/^\s*[+*?{]/.test(src.slice(i + 1)) && /[+*{|]/.test(inner.replace(/\\./g, ''))) return true;
    }
  }
  return false;
}

// "/blog/" is a path; "/^.*\\/p\\/\\d+/" (or anything with regex syntax) is a regular expression.
export function urlMatcher(filter) {
  const f = String(filter || '').trim();
  if (!f) return () => true;
  const re = f.match(/^\/(.+)\/([a-z]*)$/);
  // A quantified group that contains a quantifier ((a+)+, ((a+))+, (a|aa)*…) can take forever on long
  // URLs — treat those as plain text. Back-references are refused for the same reason.
  if (re && /[\\^$.|?*+()[\]{}]/.test(re[1]) && re[1].length <= 200 && !riskyRegex(re[1])) {
    try { const r = new RegExp(re[1], re[2] || 'i'); return (u) => r.test(u); } catch { return () => false; }
  }
  return (u) => u.toLowerCase().includes(f.toLowerCase());
}
