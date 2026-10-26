// Service worker: opens the side panel, keeps the Claude (MCP) bridge running, and performs the
// browser operations the bridge asks for (tabs, screenshots, downloads, storage).
// Only the extension's own offscreen bridge may call these operations, and every page Claude
// touches is checked against the user's safety settings (lib/guard.js).
import { getActiveTab, callInTab, callInTabChecked, navigate, waitForLoad, runInNewTab, clickAndWait, collectPosts, sleep } from './lib/tab.js';
import { getSettings, saveSettings, addHistory, newToken, saveRecipe } from './lib/storage.js';
import { blockedReason, assertAllowed } from './lib/guard.js';
import { refreshLicense, getLicense, limitsFor, useMcpCall, isPro } from './lib/license.js';
import { LINKS } from './lib/config.js';
import { getMonitors, saveMonitor, deleteMonitor, diffRows, recordRun, shouldAlert } from './lib/monitor.js';
import { isSheetUrl, sheetRows } from './lib/sheets.js';

const OFFSCREEN = 'offscreen/bridge.html';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  chrome.runtime.setUninstallURL(LINKS.uninstall).catch(() => {});
  const s = await getSettings();
  if (!s.mcp?.token) {
    // Reinstalled? Reuse the previous link so the connector already added in Claude keeps working.
    const { connectorToken } = await chrome.storage.sync.get('connectorToken').catch(() => ({}));
    const token = /^[A-Za-z0-9_-]{32,}$/.test(connectorToken || '') ? connectorToken : newToken();
    await saveSettings({ mcp: { ...s.mcp, token } });
    chrome.storage.sync.set({ connectorToken: token }).catch(() => {});
  } else {
    chrome.storage.sync.set({ connectorToken: s.mcp.token }).catch(() => {});
  }
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
  if (b.token && a.token !== b.token) chrome.storage.sync.set({ connectorToken: b.token }).catch(() => {}); // "Generate new link"
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
  const connector = !!(mcp?.enabled && mcp.consentAt && mcp.server && mcp.token);
  // The same offscreen document also runs scheduled monitors (it has DOMParser for fetched pages).
  const monitors = (await getMonitors()).some((m) => !m.paused);
  const want = connector || monitors;
  const connectorChanged = contexts.length && !!contexts[0].documentUrl?.includes('token=') !== connector;
  if (contexts.length && (restart || !want || connectorChanged)) await chrome.offscreen.closeDocument().catch(() => {});
  if (!connector) {
    await setStatus({ state: 'off' });
    setBusy(0);
  }
  if (!want) return;
  if (!contexts.length || restart || connectorChanged) {
    const qs = connector ? new URLSearchParams({ server: mcp.server.replace(/\/+$/, ''), token: mcp.token, v: chrome.runtime.getManifest().version }) : new URLSearchParams({ v: chrome.runtime.getManifest().version });
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
  const g = await guardOpts();
  assertAllowed(tab.url || tab.pendingUrl || '', g);
  if (tab.pendingUrl) assertAllowed(tab.pendingUrl, g); // a navigation to a blocked page is under way
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
  async open({ url, tabId, newTab, waitMs = 1500, active = true }) {
    assertAllowed(url, await guardOpts());
    let tab;
    if (newTab ?? tabId == null) {
      tab = await chrome.tabs.create({ url, active: active !== false });
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
    const g = await guardOpts();
    return callInTabChecked(tab.id, (u) => assertAllowed(u, g), method, ...args);
  },
  async runInNewTab({ url, method, args = [], waitMs }) {
    assertAllowed(url, await guardOpts());
    const g = await guardOpts();
    return runInNewTab(url, method, args, { waitMs, check: (u) => assertAllowed(u, g) });
  },
  // Open a feed / search page, scroll it and collect the posts it shows (Trend Finder).
  async collectPosts({ url, tabId, steps, want, stepMs, patience, until }) {
    assertAllowed(url, await guardOpts());
    if (tabId != null) await allowedTab(tabId);
    const g = await guardOpts();
    return collectPosts(url, { until: Number(until) || 0, check: (u) => assertAllowed(u, g), steps: Math.min(Number(steps) || 12, 120), want: Math.min(Number(want) || 50, 500), stepMs: Math.min(Math.max(Number(stepMs) || 1200, 500), 5000), patience: Math.min(Number(patience) || 3, 8), reuseTabId: tabId ?? undefined });
  },
  async closeTab({ tabId }) {
    await chrome.tabs.remove(tabId).catch(() => {});
    return true;
  },
  // Monitors (also managed by Claude through the connector).
  monitors: async () => (await getMonitors()).map(({ lastRows, ...m }) => ({ ...m, runs: (m.runs || []).slice(0, 5) })),
  saveRecipe: (r) => saveRecipe({ name: r.name, tool: r.tool, url: r.url, config: r.config, by: 'claude' }),
  async monitorCreate({ recipeId, everyMinutes, alertOn }) {
    return createMonitor({ recipeId, everyMinutes, alertOn });
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
    assertAllowed((await chrome.tabs.get(tab.id)).url || '', await guardOpts()); // still the same page?
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
    // The user's own table (perhaps edited by hand) is saved in full before Claude's results replace it.
    const { dataset: prev } = await chrome.storage.local.get('dataset');
    const ownTable = prev?.updatedBy !== 'claude' && prev?.sheets?.some((s) => s.rows?.length);
    if (ownTable) {
      await addHistory({ title: `${prev.title || 'Data Table'} (your table before Claude's results)`, url: prev.url || '', source: prev.source || 'Data Table',
        pages: [prev.url].filter(Boolean), results: Object.fromEntries(prev.sheets.map((s) => [s.name, s.rows || []])) }, { keep: true });
    }
    const dataset = { title, url, source, sheets, active: Math.max(0, sheets.findIndex((s) => s.rows.length)), updatedBy: 'claude', updatedAt: Date.now(), ...(ownTable ? { savedPrevious: true } : {}) };
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


// ---------- monitors: scheduled recipe runs with change alerts ----------
const MONITOR_ALARM = 'monitor:';
const minEvery = async () => (isPro(await getLicense()) ? 60 : 1440);

export async function createMonitor({ recipeId, everyMinutes = 1440, alertOn = 'any', id }) {
  const { recipes = [] } = await chrome.storage.local.get('recipes');
  const recipe = recipes.find((r) => r.id === recipeId || r.name === recipeId);
  if (!recipe) throw new Error('No such recipe. Save a recipe first, then monitor it.');
  const list = await getMonitors();
  const cap = limitsFor(await getLicense()).monitors;
  if (!id && list.length >= cap) throw new Error(`The free plan includes ${cap} monitor (daily). Upgrade to PullRows Pro for unlimited, hourly monitors.`);
  const every = Math.max(Number(everyMinutes) || 1440, await minEvery());
  const mon = await saveMonitor({ ...(id ? { id } : {}), recipeId: recipe.id, name: recipe.name, everyMinutes: every, alertOn, paused: false });
  await scheduleMonitors();
  await syncBridge();
  runMonitor(mon.id).catch(console.error); // first run = baseline
  return mon;
}

// Alarms mirror the stored monitors (alarms survive browser restarts; this repairs any drift).
async function scheduleMonitors() {
  const list = await getMonitors();
  const alarms = await chrome.alarms.getAll();
  for (const a of alarms) if (a.name.startsWith(MONITOR_ALARM) && !list.some((m) => !m.paused && a.name === MONITOR_ALARM + m.id)) await chrome.alarms.clear(a.name);
  for (const m of list) {
    if (m.paused) continue;
    const a = alarms.find((x) => x.name === MONITOR_ALARM + m.id);
    if (!a || a.periodInMinutes !== m.everyMinutes) chrome.alarms.create(MONITOR_ALARM + m.id, { periodInMinutes: m.everyMinutes, delayInMinutes: a ? undefined : m.everyMinutes });
  }
  await updateMonitorBadge();
}

async function updateMonitorBadge() {
  const unseen = (await getMonitors()).reduce((n, m) => n + (m.unseen || 0), 0);
  if (unseen) { chrome.action.setBadgeText({ text: String(Math.min(unseen, 99)) }); chrome.action.setBadgeBackgroundColor({ color: '#E5484D' }); }
  else chrome.action.getBadgeText({}).then((t) => { if (/^\d+$/.test(t)) chrome.action.setBadgeText({ text: '' }); }).catch(() => {});
}

const runningMonitors = new Set();
async function runMonitor(id) {
  if (runningMonitors.has(id)) return;
  runningMonitors.add(id);
  try {
    let mon = (await getMonitors()).find((m) => m.id === id);
    if (!mon) return;
    await syncBridge();
    let rows = [];
    let error = '';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'monitor-run', recipeId: mon.recipeId });
      if (!res) throw new Error('The background runner did not answer.');
      if (res.error) throw new Error(res.error);
      rows = res.rows || [];
    } catch (e) { error = String(e.message || e); }
    const diff = error ? null : diffRows(mon.lastRows || null, rows);
    mon = (await getMonitors()).find((m) => m.id === id) || mon; // may have been edited meanwhile
    const next = recordRun(mon, { rows, diff, error });
    await saveMonitor(next);
    if (!error) {
      await addHistory({ title: `Monitor · ${mon.name} — ${diff.summary}`, url: '', source: 'Monitor', pages: [], results: { Rows: rows, ...(diff.rows.length ? { Changes: diff.rows } : {}) } });
      if (shouldAlert(diff, mon.alertOn)) {
        chrome.notifications?.create(`mon-${id}-${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: `PullRows · ${mon.name}`, message: diff.summary.slice(0, 250), priority: 1 }, () => void chrome.runtime.lastError);
      }
      const { settings: s = {} } = await chrome.storage.local.get('settings');
      if (mon.pushToSheet && s.sheetUrl && isPro(await getLicense())) await pushToSheet(s.sheetUrl, mon.name, diff.first ? rows : diff.rows.length ? diff.rows : []).catch(() => {});
    }
    await updateMonitorBadge();
  } finally {
    runningMonitors.delete(id);
  }
}

// Google Sheets: the user's own Apps Script web app appends rows to a sheet tab (no Google sign-in
// or OAuth scopes needed by the extension).
export async function pushToSheet(sheetUrl, tab, rows) {
  if (!isSheetUrl(sheetUrl)) throw new Error('That is not an Apps Script web app URL (https://script.google.com/macros/s/…/exec).');
  if (!rows.length) return { ok: true, rows: 0 };
  rows = sheetRows(rows);
  const res = await fetch(sheetUrl, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ sheet: String(tab).slice(0, 90), rows }), redirect: 'follow' });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* HTML error page */ }
  if (!res.ok || !j?.ok) throw new Error(j?.error || (res.status === 401 || res.status === 403 || /accounts\.google/.test(res.url) ? 'Google asked for a sign-in: deploy the script with access "Anyone".' : `Google Sheets answered ${res.status}`));
  return j;
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name.startsWith(MONITOR_ALARM)) runMonitor(a.name.slice(MONITOR_ALARM.length)).catch(console.error); });
chrome.runtime.onStartup.addListener(() => { scheduleMonitors().catch(console.error); });
chrome.runtime.onInstalled.addListener(() => { scheduleMonitors().catch(console.error); });

// Side panel requests (user actions in the Monitors view).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type?.startsWith?.('monitor:')) return false;
  // Extension pages only (side panel, or it opened as a tab) — never a content script on a website.
  if (sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) { sendResponse({ err: 'Not allowed' }); return false; }
  (async () => {
    switch (msg.type) {
      case 'monitor:create': return createMonitor(msg);
      case 'monitor:run': await runMonitor(msg.id); return true;
      case 'monitor:pause': { const m = (await getMonitors()).find((x) => x.id === msg.id); if (m) await saveMonitor({ ...m, paused: !!msg.paused }); await scheduleMonitors(); await syncBridge(); return true; }
      case 'monitor:delete': await deleteMonitor(msg.id); await scheduleMonitors(); await syncBridge(); return true;
      case 'monitor:seen': { for (const m of await getMonitors()) if (m.unseen) await saveMonitor({ ...m, unseen: 0 }); await updateMonitorBadge(); return true; }
      case 'monitor:update': { const m = (await getMonitors()).find((x) => x.id === msg.id); if (!m) throw new Error('Monitor not found'); await saveMonitor({ ...m, ...msg.patch, everyMinutes: Math.max(Number(msg.patch?.everyMinutes || m.everyMinutes), await minEvery()) }); await scheduleMonitors(); return true; }
      case 'monitor:sheet-test': return pushToSheet(msg.url, 'PullRows test', [{ hello: 'PullRows', at: new Date().toISOString() }]);
      case 'monitor:sheet-push': return pushToSheet(msg.url, msg.tab, msg.rows);
      default: throw new Error('Unknown monitor request');
    }
  })().then((ok) => sendResponse({ ok }), (e) => sendResponse({ err: String(e.message || e) }));
  return true;
});
