// Background fetching from the side panel (the extension's host permissions bypass CORS),
// plus a small worker pool. Pages fetched this way are parsed with DOMParser and handed to
// the same engine (content/engine.js) that runs inside tabs.

const UA_HEADERS = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

// Set by the Claude connector: every background request it causes (including URLs found inside
// pages: sitemap entries, post links, caption files) is checked before and after redirects.
let fetchGuard = null;
export function setFetchGuard(fn) { fetchGuard = fn; }

export async function fetchWithTimeout(url, { timeoutMs = 20000, signal, ...init } = {}) {
  fetchGuard?.(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Timed out: ${url}`)), timeoutMs);
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, credentials: 'include', redirect: 'follow' });
    if (fetchGuard && res.url && res.url !== url) {
      try { fetchGuard(res.url); } catch (e) { res.body?.cancel().catch(() => {}); throw e; }
    }
    return res;
  } catch (e) {
    if (/^Blocked by PullRows/.test(e?.message)) throw e;
    if (ctrl.signal.aborted || e?.name === 'AbortError') throw e;
    let host = url;
    try { host = new URL(url).host; } catch { /* keep url */ }
    throw new Error(`Couldn’t connect to ${host} — check the address, or the site may block background requests (try Browser mode).`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const MAX_BYTES = 15 * 1024 * 1024; // a "page" bigger than this is not a page

// Read a response body as text, refusing anything over MAX_BYTES (also when the size is unknown).
async function readText(res, max = MAX_BYTES) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) throw new Error(`Response too large (${Math.round(len / 1048576)} MB)`);
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { reader.cancel().catch(() => {}); throw new Error('Response too large'); }
    chunks.push(value);
  }
  return new TextDecoder(charsetOf(res)).decode(await new Blob(chunks).arrayBuffer());
}

function charsetOf(res) {
  const m = (res.headers.get('content-type') || '').match(/charset=["']?([\w-]+)/i);
  try { return m ? new TextDecoder(m[1]).encoding : 'utf-8'; } catch { return 'utf-8'; }
}

export async function fetchDoc(url, opts = {}) {
  const res = await fetchWithTimeout(url, { headers: UA_HEADERS, ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (type && !/html|xml|text\/plain/i.test(type)) throw new Error(`Not a web page (${type.split(';')[0]})`);
  const html = await readText(res);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Resolve relative links against the real page URL, not the side panel.
  const base = doc.createElement('base');
  base.href = res.url || url;
  doc.head.prepend(base);
  return { doc, url: res.url || url };
}

export async function fetchText(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (/\.gz($|\?)/i.test(url) && !/xml|text/i.test(res.headers.get('content-type') || '')) {
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    return readText(new Response(stream), 50 * 1024 * 1024);
  }
  return readText(res);
}

export async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(await readText(res, 20 * 1024 * 1024)); // size-capped, like pages
}

// Run `worker(item, index)` over items with limited concurrency. Errors are captured per item.
export async function runPool(items, concurrency, worker, { signal, onProgress } = {}) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const lane = async () => {
    while (next < items.length && !signal?.aborted) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (e) {
        results[i] = { ok: false, error: String(e?.message || e) };
      }
      done++;
      onProgress?.(done, items.length, items[i], results[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
  return results;
}

export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try { return new URL(s).href; } catch { return ''; }
}

// Pull URLs out of pasted text, CSV content, or a mixed list.
export function parseUrlList(text) {
  const found = String(text || '').match(/(?:https?:\/\/|www\.)[^\s"'<>,;]+|(?:^|[\s,;"'])((?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\/[^\s"'<>,;]*)?)/gim) || [];
  const urls = found.map((m) => normalizeUrl(m.replace(/^[\s,;"']+/, '')));
  return [...new Set(urls.filter(Boolean))];
}
