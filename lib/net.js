// Background fetching from the side panel (the extension's host permissions bypass CORS),
// plus a small worker pool. Pages fetched this way are parsed with DOMParser and handed to
// the same engine (content/engine.js) that runs inside tabs.

const UA_HEADERS = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

// Set by the Claude connector: every background request it causes (including URLs found inside
// pages: sitemap entries, post links, caption files) is checked before and after redirects.
// The guard is keyed by the call's own AbortSignal (which already travels with every fetch this
// module makes), never kept in a module global: two Claude calls and a scheduled monitor run in
// the same offscreen document at once, and a global guard let one call clear or re-arm another's.
const fetchGuards = new WeakMap(); // AbortSignal -> (url) => throws when blocked
export function setFetchGuard(signal, fn) { if (signal) fetchGuards.set(signal, fn); }
const guardFor = (signal) => (signal && fetchGuards.get(signal)) || null;

const MAX_REDIRECTS = 5;

// Claude-initiated requests carry the user's cookies, so a redirect must never be followed blindly:
// `redirect: 'follow'` would hand the session to every hop in the chain before anything is checked.
// Instead each hop is discovered with a cookie-less probe, checked against the safety rules, and
// only then requested with credentials — so no cookie ever reaches a host the user blocked.
async function guardedFetch(url, init, signal, guard) {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      return await fetch(target, { ...init, signal, credentials: 'include', redirect: 'error' });
    } catch (e) {
      if (signal.aborted || e?.name === 'AbortError' || /^Blocked by PullRows/.test(e?.message)) throw e;
      // Only a GET may be repeated to find out where it leads; re-sending a POST could repeat
      // whatever it did the first time.
      if ((init.method || 'GET').toUpperCase() !== 'GET') throw e;
      const next = await probeRedirect(target, init, signal);
      if (!next) throw e; // not a redirect — a real network error
      guard(next); // throws before any cookie is sent there
      target = next;
    }
  }
  throw new Error(`Too many redirects: ${url}`);
}

// Where does this URL redirect to? Asked without cookies, body discarded.
async function probeRedirect(url, init, signal) {
  try {
    const probe = await fetch(url, { ...init, signal, credentials: 'omit', redirect: 'follow' });
    const final = probe.url;
    probe.body?.cancel().catch(() => {});
    return probe.redirected && final && final !== url ? final : null;
  } catch {
    return null;
  }
}

export async function fetchWithTimeout(url, { timeoutMs = 20000, signal, ...init } = {}) {
  const guard = guardFor(signal);
  guard?.(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Timed out: ${url}`)), timeoutMs);
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort);
  try {
    const res = guard
      ? await guardedFetch(url, init, ctrl.signal, guard)
      : await fetch(url, { ...init, signal: ctrl.signal, credentials: 'include', redirect: 'follow' });
    if (guard && res.url && res.url !== url) {
      try { guard(res.url); } catch (e) { res.body?.cancel().catch(() => {}); throw e; }
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

// POST a JSON body and read a JSON answer. Used for the paging APIs a site calls itself (the
// YouTube channel feed), so a whole back catalogue can be read without opening a tab.
export async function postJson(url, body, opts = {}) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: '*/*' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    timeoutMs: 30000,
    ...opts,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(await readText(res, 30 * 1024 * 1024));
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
