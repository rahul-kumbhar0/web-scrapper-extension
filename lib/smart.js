// Background first. Most pages can be read without opening anything: PullRows fetches the HTML
// (with the user's cookies, so logged-in pages work too) and runs the same engine on it. Only when
// a page needs JavaScript to show its data, or answers with a login wall / bot check, is it rendered
// in a muted background tab, read, and closed.
//
// io = { fetchDoc(url, {signal}) → {doc}, renderInTab(url, method, args) → result, signal }

const engine = () => globalThis.__webScraper;

// An app shell: almost no text, a mount point, and scripts that would build the page.
export function looksLikeShell(doc) {
  const body = doc.body;
  if (!body) return true;
  const text = (body.textContent || '').replace(/\s+/g, ' ').trim();
  if (/enable javascript|javascript is (disabled|required)|you need to enable javascript/i.test(text) && text.length < 2000) return true;
  const mount = doc.querySelector('#root, #app, #__next, #__nuxt, [data-reactroot], app-root, #react-root');
  return text.length < 200 && (!!mount || doc.querySelectorAll('script[src]').length > 2);
}

const emptyValue = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

/** True when an engine result carries no data (works for row packs, objects and arrays). */
export function isEmptyResult(r) {
  if (emptyValue(r)) return true;
  if (r.cols && r.data) return !r.data.some((row) => row.some((v) => !emptyValue(v)));
  if (Array.isArray(r)) return !r.length;
  if (typeof r === 'object') return Object.entries(r).every(([k, v]) => /^(url|platform|id)$/.test(k) || emptyValue(v));
  return false;
}

/**
 * Run engine[method](...args, doc) on the fetched page; fall back to a background tab when needed.
 * mode: 'auto' (default) | 'fetch' (never open a tab) | 'browser' (always a tab).
 * Resolves to { result, via: 'background' | 'tab', reason }.
 */
export async function smartRun(url, method, args, io, { mode = 'auto', isEmpty = isEmptyResult } = {}) {
  let reason = '';
  if (mode !== 'browser') {
    try {
      const { doc } = await io.fetchDoc(url, { signal: io.signal });
      const block = engine().pageBlock(doc);
      if (block) reason = block.label;
      else if (looksLikeShell(doc)) reason = 'the page builds itself with JavaScript';
      else {
        const result = await engine()[method](...args, doc);
        if (!isEmpty(result)) return { result, via: 'background', reason: '' };
        reason = 'the data was not in the page HTML';
      }
    } catch (e) {
      if (io.signal?.aborted) throw e;
      reason = String(e?.message || e);
    }
    if (mode === 'fetch') throw new Error(`Couldn't read it in the background (${reason}).`);
  }
  const result = await io.renderInTab(url, method, args);
  return { result, via: 'tab', reason };
}
