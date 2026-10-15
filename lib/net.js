// Background fetching from the side panel (the extension's host permissions bypass CORS),
// plus a small worker pool. Pages fetched this way are parsed with DOMParser and handed to
// the same engine (content/engine.js) that runs inside tabs.

const UA_HEADERS = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

export async function fetchWithTimeout(url, { timeoutMs = 20000, signal, ...init } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Timed out: ${url}`)), timeoutMs);
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, credentials: 'include', redirect: 'follow' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function fetchDoc(url, opts = {}) {
  const res = await fetchWithTimeout(url, { headers: UA_HEADERS, ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (type && !/html|xml|text\/plain/i.test(type)) throw new Error(`Not a web page (${type.split(';')[0]})`);
  const html = await res.text();
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
    return new Response(stream).text();
  }
  return res.text();
}

export async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
