// Helpers for running the scraper inside a browser tab.

export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  return tab;
}

function assertScrapable(url = '') {
  if (!/^(https?|file):/i.test(url) || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)) {
    throw new Error('Chrome does not allow extensions to read this page. Open a normal website and try again.');
  }
}

// Inject the scraper (idempotent) and call one of its methods with JSON-serialisable args.
export async function callInTab(tabId, method, ...args) {
  const tab = await chrome.tabs.get(tabId);
  assertScrapable(tab.url);
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/scraper.js'] });
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

// Navigate a tab and resolve once it has finished loading.
export function navigate(tabId, url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out loading ${url}`));
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch((e) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(e);
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
