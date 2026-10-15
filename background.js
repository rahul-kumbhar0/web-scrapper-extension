// Service worker: opens the side panel, keeps the Claude (MCP) bridge running, and performs the
// browser operations the bridge asks for (tabs, screenshots, downloads, storage).
import { getActiveTab, callInTab, navigate, waitForLoad, runInNewTab, clickAndWait, sleep } from './lib/tab.js';
import { getSettings, saveSettings, addHistory, newToken } from './lib/storage.js';

const OFFSCREEN = 'offscreen/bridge.html';

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  const s = await getSettings();
  if (!s.mcp?.token) await saveSettings({ mcp: { ...s.mcp, token: newToken() } });
  syncBridge();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  syncBridge();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const a = changes.settings.oldValue?.mcp || {};
  const b = changes.settings.newValue?.mcp || {};
  if (a.enabled !== b.enabled || a.server !== b.server || a.token !== b.token) syncBridge(true);
});

// ---------- offscreen bridge lifecycle ----------
let syncing = Promise.resolve();
function syncBridge(restart = false) {
  syncing = syncing.then(() => doSync(restart)).catch(console.error);
  return syncing;
}

async function doSync(restart) {
  const { mcp } = await getSettings();
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  const want = !!(mcp?.enabled && mcp.server && mcp.token);
  if (contexts.length && (restart || !want)) await chrome.offscreen.closeDocument().catch(() => {});
  if (!want) {
    await setStatus({ state: 'off' });
    return;
  }
  if (!contexts.length || restart) {
    const qs = new URLSearchParams({ server: mcp.server.replace(/\/+$/, ''), token: mcp.token, v: chrome.runtime.getManifest().version });
    await chrome.offscreen.createDocument({
      url: `${OFFSCREEN}?${qs}`,
      reasons: ['DOM_PARSER'],
      justification: 'Parses fetched web pages and keeps the connection to the Claude MCP relay.',
    });
  }
}

async function setStatus(patch) {
  const { mcpStatus } = await chrome.storage.local.get('mcpStatus');
  await chrome.storage.local.set({ mcpStatus: { ...mcpStatus, ...patch, at: Date.now() } });
}

async function log(entry) {
  const { mcpLog = [] } = await chrome.storage.local.get('mcpLog');
  await chrome.storage.local.set({ mcpLog: [{ ...entry, at: Date.now() }, ...mcpLog].slice(0, 30) });
}

// ---------- operations requested by the bridge ----------
const tabInfo = (t) => ({ tab_id: t.id, title: t.title, url: t.url, active: t.active, window_id: t.windowId });

const OPS = {
  status: (patch) => setStatus(patch),
  log: (entry) => log(entry),
  getStorage: async (key) => (await chrome.storage.local.get(key))[key],
  settings: () => getSettings(),
  activeTab: async () => tabInfo(await getActiveTab()),
  listTabs: async () => (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url || '')).map(tabInfo),
  async open({ url, tabId, newTab, waitMs = 1500 }) {
    let tab;
    if (newTab) {
      tab = await chrome.tabs.create({ url, active: true });
      await waitForLoad(tab.id, 45000);
    } else {
      const id = tabId ?? (await getActiveTab()).id;
      await navigate(id, url, 45000);
      tab = await chrome.tabs.get(id);
    }
    if (waitMs) await sleep(waitMs);
    return tabInfo(await chrome.tabs.get(tab.id));
  },
  callInTab: ({ tabId, method, args = [] }) => callInTab(tabId, method, ...args),
  runInNewTab: ({ url, method, args = [], waitMs }) => runInNewTab(url, method, args, { waitMs }),
  clickAndWait: ({ tabId, buttonSelector, itemSelector }) => clickAndWait(tabId, buttonSelector, itemSelector),
  async screenshot({ tabId }) {
    const tab = tabId ? await chrome.tabs.get(tabId) : await getActiveTab();
    if (!tab.active) { await chrome.tabs.update(tab.id, { active: true }); await sleep(400); }
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    return { dataUrl, title: tab.title, url: tab.url };
  },
  async download({ urls, folder }) {
    const safe = String(folder || 'claude').replace(/[^\w.-]+/g, '_');
    let ok = 0;
    for (const [i, url] of urls.entries()) {
      const name = (url.split(/[?#]/)[0].split('/').pop() || `image-${i + 1}`).replace(/[^\w.-]+/g, '_').slice(0, 80) || `image-${i + 1}`;
      try {
        await chrome.downloads.download({ url, filename: `web-scraper/${safe}/${/\.\w{2,5}$/.test(name) ? name : name + '.jpg'}`, conflictAction: 'uniquify' });
        ok++;
      } catch (e) { console.warn('download failed', url, e); }
    }
    return { requested: urls.length, started: ok, folder: `Downloads/web-scraper/${safe}/` };
  },
  async saveDataset({ title, url, source, sheets }) {
    const dataset = { title, url, source, sheets, active: Math.max(0, sheets.findIndex((s) => s.rows.length)), updatedBy: 'claude', updatedAt: Date.now() };
    await chrome.storage.local.set({ dataset });
    await addHistory({ title, url, source, pages: [url], results: Object.fromEntries(sheets.map((s) => [s.name, s.rows])) });
    return true;
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'bridge-op') return false;
  const op = OPS[msg.op];
  if (!op) { sendResponse({ err: `Unknown op ${msg.op}` }); return false; }
  Promise.resolve()
    .then(() => op(msg.arg))
    .then((ok) => sendResponse({ ok }), (e) => sendResponse({ err: String(e?.message || e) }));
  return true;
});

// Re-create the bridge whenever the worker wakes up (e.g. after Chrome restarts).
syncBridge();
