// Helpers for running the engine inside browser tabs.

export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  return tab;
}

export function isScrapable(url = '') {
  return /^(https?|file):/i.test(url) && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);
}

// Inject the engine (idempotent) and call one of its methods with JSON-serialisable args.
export async function callInTab(tabId, method, ...args) {
  const tab = await chrome.tabs.get(tabId);
  if (!isScrapable(tab.url)) {
    throw new Error('Chrome does not allow extensions to read this page. Open a normal website and try again.');
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/engine.js'] });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (m, a) => {
      try {
        return { ok: await globalThis.__webScraper[m](...a) };
      } catch (e) {
        return { err: String(e?.message || e) };
      }
    },
    args: [method, args],
  });
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
