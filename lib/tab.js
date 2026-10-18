// Helpers for running the engine inside browser tabs.

export async function getActiveTab() {
  // lastFocusedWindow works from the side panel and from the service worker alike.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  return tab;
}

export function isScrapable(url = '') {
  return /^(https?|file):/i.test(url) && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);
}

// Chrome's own wording for pages an extension can't script, in words a user can act on.
function friendlyInjectError(e, url = '') {
  const msg = String(e?.message || e);
  if (/^file:/i.test(url)) return 'To scrape files on your computer, open chrome://extensions → PullRows → Details and turn on "Allow access to file URLs".';
  if (/error page/i.test(msg)) return 'This page did not load. Reload it and try again.';
  if (/\.pdf([?#]|$)/i.test(url)) return 'PDFs open in Chrome\'s built-in viewer, which extensions cannot read.';
  if (/Cannot access|cannot be scripted|must request permission/i.test(msg)) return 'Chrome does not allow extensions to read this page (a browser, store or policy-protected page). Open a normal website and try again.';
  if (/No tab with id|tab was closed/i.test(msg)) return 'That tab was closed.';
  return msg;
}

// Inject the engine (idempotent) and call one of its methods with JSON-serialisable args.
export async function callInTab(tabId, method, ...args) {
  const tab = await chrome.tabs.get(tabId);
  if (!isScrapable(tab.url)) {
    throw new Error('Chrome does not allow extensions to read this page. Open a normal website and try again.');
  }
  const run = () => chrome.scripting.executeScript({
    target: { tabId },
    func: async (m, a, v) => {
      const eng = globalThis.__webScraper;
      if (!eng || eng.version !== v || !eng.socialPost) return { missing: true };
      try {
        return { ok: await eng[m](...a) };
      } catch (e) {
        return { err: String(e?.message || e) };
      }
    },
    args: [method, args, chrome.runtime.getManifest().version],
  });
  // Usually the engine is already in the page: one round trip. Otherwise inject it first.
  let res;
  try {
    [res] = await run();
    if (res?.result?.missing) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/engine.js', 'content/social.js'] });
      [res] = await run();
    }
  } catch (e) {
    throw new Error(friendlyInjectError(e, tab.url));
  }
  if (!res?.result) throw new Error('Could not run the scraper on this page.');
  if (res.result.err) throw new Error(res.result.err);
  return res.result.ok;
}

// Resolve once a tab finishes loading (or immediately if it already has).
export function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error('Timed out waiting for the page to load')), timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') finish(resolve);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') setTimeout(() => chrome.tabs.get(tabId).then((t2) => { if (t2.status === 'complete') finish(resolve); }), 300); }, (e) => finish(reject, e));
  });
}

// Navigate a tab and resolve once it has finished loading.
export async function navigate(tabId, url, timeoutMs = 30000) {
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); reject(new Error(`Timed out loading ${url}`)); }, timeoutMs);
    function l(id, info) {
      if (id === tabId && info.status === 'complete') { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(l); resolve(); }
    }
    chrome.tabs.onUpdated.addListener(l);
  });
  await chrome.tabs.update(tabId, { url });
  await loaded;
}

// Open `url` in a background tab, wait for it to render, run `method`, close the tab.
// `check(url)` (Claude connector safety rules) is applied to where the tab really ended up.
export async function runInNewTab(url, method, args = [], { waitMs = 1000, timeoutMs = 45000, check } = {}) {
  const tab = await chrome.tabs.create({ url, active: false });
  chrome.tabs.update(tab.id, { muted: true }).catch(() => {}); // reels and videos autoplay
  try {
    await waitForLoad(tab.id, timeoutMs);
    if (waitMs) await sleep(waitMs);
    if (check) check((await chrome.tabs.get(tab.id)).url);
    return await callInTab(tab.id, method, ...args);
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Click a pagination button, then wait until either the page navigates (link) or the list
// re-renders in place (JS). Returns false when the button is gone/disabled or nothing changed.
export async function clickAndWait(tabId, buttonSelector, itemSelector, timeoutMs = 15000) {
  const fp = await callInTab(tabId, 'fingerprint', itemSelector);
  const navigated = new Promise((resolve) => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(false); }, 1500);
    function l(id, info) { if (id === tabId && info.status === 'loading') { clearTimeout(t); chrome.tabs.onUpdated.removeListener(l); resolve(true); } }
    chrome.tabs.onUpdated.addListener(l);
  });
  const ok = await callInTab(tabId, 'clickElement', buttonSelector);
  if (!ok) return false;
  if (await navigated) { await waitForLoad(tabId); await sleep(800); return true; }
  try {
    return await callInTab(tabId, 'waitForChange', itemSelector, fp, timeoutMs);
  } catch {
    await waitForLoad(tabId); // navigation started late and destroyed the page context
    return true;
  }
}

// Open a feed / search / hashtag page and scroll it, collecting every post it shows (Reels, TikToks,
// Shorts…). The tab is shown while it scrolls: Chrome doesn't load more items in hidden tabs.
export async function collectPosts(url, { steps = 12, want = 50, stepMs = 1200, patience = 3, until = 0, signal, onProgress, reuseTabId, check } = {}) {
  const tab = reuseTabId ? await chrome.tabs.get(reuseTabId) : await chrome.tabs.create({ url, active: true });
  chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
  const byUrl = new Map();
  let block = null;
  try {
    await waitForLoad(tab.id);
    await sleep(1500);
    let idle = 0;
    for (let i = 0; i <= steps && !signal?.aborted; i++) {
      if (check) check((await chrome.tabs.get(tab.id)).url);
      block = await callInTab(tab.id, 'pageBlock').catch(() => null);
      if (block) break;
      const before = byUrl.size;
      for (const p of await callInTab(tab.id, 'socialPosts')) {
        const prev = byUrl.get(p.url);
        byUrl.set(p.url, prev ? Object.fromEntries(Object.keys(p).map((k) => [k, prev[k] === '' || prev[k] == null ? p[k] : prev[k]])) : p);
      }
      onProgress?.(byUrl.size, i, steps);
      if (byUrl.size >= want || (until && Date.now() > until)) break;
      idle = byUrl.size === before ? idle + 1 : 0;
      if (idle >= patience) break;
      await callInTab(tab.id, 'scrollStep', null).catch(() => {});
      await sleep(stepMs);
    }
  } finally {
    if (!reuseTabId) chrome.tabs.remove(tab.id).catch(() => {});
  }
  return { posts: [...byUrl.values()], block };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
