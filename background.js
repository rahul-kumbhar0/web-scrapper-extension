// Service worker: opens the side panel, keeps the Claude (MCP) bridge running, and performs the
// browser operations the bridge asks for (tabs, screenshots, downloads, storage).
// Only the extension's own offscreen bridge may call these operations, and every page Claude
// touches is checked against the user's safety settings (lib/guard.js).
import { getActiveTab, callInTab, navigate, waitForLoad, runInNewTab, clickAndWait, collectPosts, sleep } from './lib/tab.js';
import { getSettings, saveSettings, addHistory, newToken } from './lib/storage.js';
import { blockedReason, assertAllowed } from './lib/guard.js';
import { refreshLicense, getLicense, limitsFor, useMcpCall } from './lib/license.js';
import { LINKS } from './lib/config.js';

const OFFSCREEN = 'offscreen/bridge.html';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  chrome.runtime.setUninstallURL(LINKS.uninstall).catch(() => {});
  const s = await getSettings();
  if (!s.mcp?.token) await saveSettings({ mcp: { ...s.mcp, token: newToken() } });
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/welcome.html') }).catch(() => {});
  if (reason === 'update') await chrome.storage.local.set({ whatsNew: chrome.runtime.getManifest().version });
  syncBridge();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  refreshLicense().catch(() => {});
  syncBridge();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const a = changes.settings.oldValue?.mcp || {};
  const b = changes.settings.newValue?.mcp || {};
  if (a.enabled !== b.enabled || a.server !== b.server || a.token !== b.token || !!a.consentAt !== !!b.consentAt) {
    // Tell the relay right away that the old connection is gone, so Claude gets a clear error
    // instead of waiting for a timeout.
    if (a.enabled && a.server && a.token) fetch(`${a.server.replace(/\/+$/, '')}/bridge/${encodeURIComponent(a.token)}`, { method: 'DELETE' }).catch(() => {});
    syncBridge(true);
  }
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
  const want = !!(mcp?.enabled && mcp.consentAt && mcp.server && mcp.token);
  if (contexts.length && (restart || !want)) await chrome.offscreen.closeDocument().catch(() => {});
  if (!want) {
    await setStatus({ state: 'off' });
    setBusy(0);
    return;
  }
  if (!contexts.length || restart) {
    const qs = new URLSearchParams({ server: mcp.server.replace(/\/+$/, ''), token: mcp.token, v: chrome.runtime.getManifest().version });
    await chrome.offscreen.createDocument({
      url: `${OFFSCREEN}?${qs}`,
      reasons: ['DOM_PARSER'],
      justification: 'Parses web pages fetched in the background (DOMParser) for scraping jobs the user starts from Claude.',
    });
  }
}

async function setStatus(patch) {
  const { mcpStatus } = await chrome.storage.local.get('mcpStatus');
  await chrome.storage.local.set({ mcpStatus: { ...mcpStatus, ...patch, at: Date.now() } });
}

async function log(entry) {
  const { mcpLog = [] } = await chrome.storage.local.get('mcpLog');
  await chrome.storage.local.set({ mcpLog: [{ ...entry, at: Date.now() }, ...mcpLog].slice(0, 100) });
}

// Badge on the toolbar icon while Claude is running something.
function setBusy(n) {
  chrome.action.setBadgeText({ text: n > 0 ? 'AI' : '' }).catch(() => {});
  if (n > 0) chrome.action.setBadgeBackgroundColor({ color: '#6A5CFF' }).catch(() => {});
}

// ---------- operations requested by the bridge ----------
const tabInfo = (t) => ({ tab_id: t.id, title: t.title, url: t.url, active: t.active, window_id: t.windowId });

async function guardOpts() {
  const { mcp } = await getSettings();
  return { blocked: mcp.blocked, allowPrivate: !!mcp.allowLocal };
}

async function allowedTab(tabId) {
  const tab = tabId != null ? await chrome.tabs.get(tabId) : await getActiveTab();
  assertAllowed(tab.url || tab.pendingUrl || '', await guardOpts());
  return tab;
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?)$/i;

const OPS = {
  status: (patch) => setStatus(patch),
  log: (entry) => log(entry),
  busy: (n) => setBusy(n),
  useMcpCall: () => useMcpCall(),
  // Settings the bridge needs — never the API key.
  async settings() {
    const s = await getSettings();
    // Messaging is JSON: send "unlimited" as a big number.
    const limits = Object.fromEntries(Object.entries(limitsFor(await getLicense())).map(([k, v]) => [k, Number.isFinite(v) ? v : 1e9]));
    return { delayMs: s.delayMs, concurrency: s.concurrency, limits, mcp: { allowActions: !!s.mcp.allowActions, allowDownloads: !!s.mcp.allowDownloads, blocked: s.mcp.blocked, allowLocal: !!s.mcp.allowLocal } };
  },
  getDataset: async () => (await chrome.storage.local.get('dataset')).dataset || null,
  getRecipes: async () => (await chrome.storage.local.get('recipes')).recipes || [],
  activeTab: async () => tabInfo(await allowedTab()),
  async listTabs() {
    const opts = await guardOpts();
    return (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url || '') && !blockedReason(t.url, opts)).map(tabInfo);
  },
  async open({ url, tabId, newTab, waitMs = 1500 }) {
    assertAllowed(url, await guardOpts());
    let tab;
    if (newTab ?? tabId == null) {
      tab = await chrome.tabs.create({ url, active: true });
      await waitForLoad(tab.id, 45000);
    } else {
      const id = (await allowedTab(tabId)).id;
      await navigate(id, url, 45000);
      tab = await chrome.tabs.get(id);
    }
    if (waitMs) await sleep(waitMs);
    const now = await chrome.tabs.get(tab.id);
    assertAllowed(now.url || url, await guardOpts()); // after redirects
    return tabInfo(now);
  },
  async callInTab({ tabId, method, args = [] }) {
    const tab = await allowedTab(tabId);
    return callInTab(tab.id, method, ...args);
  },
  async runInNewTab({ url, method, args = [], waitMs }) {
    assertAllowed(url, await guardOpts());
    return runInNewTab(url, method, args, { waitMs });
  },
  // Open a feed / search page, scroll it and collect the posts it shows (Trend Finder).
  async collectPosts({ url, tabId, steps, want, stepMs, patience }) {
    assertAllowed(url, await guardOpts());
    if (tabId != null) await allowedTab(tabId);
    return collectPosts(url, { steps: Math.min(Number(steps) || 12, 120), want: Math.min(Number(want) || 50, 500), stepMs: Math.min(Math.max(Number(stepMs) || 1200, 500), 5000), patience: Math.min(Number(patience) || 3, 8), reuseTabId: tabId ?? undefined });
  },
  async clickAndWait({ tabId, buttonSelector, itemSelector }) {
    await allowedTab(tabId);
    return clickAndWait(tabId, buttonSelector, itemSelector);
  },
  // Chrome pauses rendering/lazy-loading in hidden tabs: bring the tab (and its window) to the front.
  async focusTab({ tabId }) {
    const tab = await allowedTab(tabId);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await sleep(300);
    return true;
  },
  async screenshot({ tabId }) {
    const tab = await allowedTab(tabId);
    if (!tab.active) { await chrome.tabs.update(tab.id, { active: true }); await sleep(400); }
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    return { dataUrl, title: tab.title, url: tab.url };
  },
  async download({ urls, folder }) {
    const { mcp } = await getSettings();
    if (!mcp.allowDownloads) throw new Error('Downloads by Claude are turned off. The user can allow them in PullRows → Settings → Claude connector → "Allow downloads".');
    const opts = await guardOpts();
    const safe = String(folder || 'claude').replace(/[^\w.-]+/g, '_').slice(0, 60);
    let ok = 0;
    const list = urls.filter((u) => /^https?:/i.test(u) && !blockedReason(u, opts)).slice(0, 200);
    for (const [i, url] of list.entries()) {
      let name = (url.split(/[?#]/)[0].split('/').pop() || '').replace(/[^\w.-]+/g, '_').slice(0, 80);
      if (!IMAGE_EXT.test(name)) name = `${name.replace(/\.[^.]*$/, '') || `image-${i + 1}`}.jpg`; // images only
      try {
        await chrome.downloads.download({ url, filename: `pullrows/${safe}/${name}`, conflictAction: 'uniquify', saveAs: false });
        ok++;
      } catch (e) { console.warn('download failed', url, e); }
    }
    return { requested: urls.length, started: ok, folder: `Downloads/pullrows/${safe}/` };
  },
  async saveDataset({ title, url, source, sheets }) {
    const dataset = { title, url, source, sheets, active: Math.max(0, sheets.findIndex((s) => s.rows.length)), updatedBy: 'claude', updatedAt: Date.now() };
    await chrome.storage.local.set({ dataset });
    await addHistory({ title, url, source, pages: [url], results: Object.fromEntries(sheets.map((s) => [s.name, s.rows])) });
    return true;
  },
};

const BRIDGE_URL = chrome.runtime.getURL(OFFSCREEN);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'bridge-op') return false;
  // Only our own offscreen bridge page — never a content script or another extension.
  if (sender.id !== chrome.runtime.id || sender.tab || !String(sender.url || '').startsWith(BRIDGE_URL)) {
    sendResponse({ err: 'Not allowed' });
    return false;
  }
  const op = Object.hasOwn(OPS, msg.op) ? OPS[msg.op] : null;
  if (!op) { sendResponse({ err: `Unknown op ${msg.op}` }); return false; }
  Promise.resolve()
    .then(() => op(msg.arg))
    .then((ok) => sendResponse({ ok }), (e) => sendResponse({ err: String(e?.message || e) }));
  return true;
});

// Re-create the bridge whenever the worker wakes up (e.g. after Chrome restarts).
syncBridge();
