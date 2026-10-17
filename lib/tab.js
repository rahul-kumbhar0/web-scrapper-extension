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
      if (!eng || eng.version !== v) return { missing: true };
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
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/engine.js'] });
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
export async function runInNewTab(url, method, args = [], { waitMs = 1000, timeoutMs = 45000 } = {}) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForLoad(tab.id, timeoutMs);
    if (waitMs) await sleep(waitMs);
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
