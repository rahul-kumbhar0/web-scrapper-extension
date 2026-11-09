// Service worker: opens the side panel, keeps the Claude (MCP) bridge running, and performs the
// browser operations the bridge asks for (tabs, screenshots, downloads, storage).
// Only the extension's own offscreen bridge may call these operations, and every page Claude
// touches is checked against the user's safety settings (lib/guard.js).
import { getActiveTab, callInTab, callInTabChecked, navigate, waitForLoad, runInNewTab, clickAndWait, collectPosts, sleep } from './lib/tab.js';
import { getSettings, saveSettings, addHistory, newToken, saveRecipe, migrateHistoryRows } from './lib/storage.js';
import { blockedReason, assertAllowed, DEFAULT_BLOCKED, DEFAULT_BLOCKED_V1 } from './lib/guard.js';
import { refreshLicense, getLicense, limitsFor, useMcpCall, releaseMcpCall, isPro } from './lib/license.js';
import { LINKS } from './lib/config.js';
import { getMonitors, saveMonitor, deleteMonitor, diffRows, recordRun, shouldAlert, getMonitorRows, migrateMonitorRows } from './lib/monitor.js';
import { isSheetUrl, sheetRows } from './lib/sheets.js';

const OFFSCREEN = 'offscreen/bridge.html';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  chrome.runtime.setUninstallURL(LINKS.uninstall).catch(() => {});
  await migrate(reason);
  const s = await getSettings();
  const { token, scope } = await claimConnectorToken(s.mcp?.token);
  if (token !== s.mcp?.token || scope !== s.mcp?.tokenScope) await saveSettings({ mcp: { ...s.mcp, token, tokenScope: scope } });
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/welcome.html') }).catch(() => {});
  if (reason === 'update') await chrome.storage.local.set({ whatsNew: chrome.runtime.getManifest().version });
  syncBridge();
});
chrome.runtime.onStartup.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  refreshLicense().catch(() => {});
  const s = await getSettings();
  if (s.mcp?.token && s.mcp.tokenScope !== 'device') publishToken(s.mcp.token).catch(() => {}); // keep our claim fresh
  syncBridge();
});

// ---------- one-off data migrations ----------
async function migrate(reason) {
  const version = chrome.runtime.getManifest().version;
  const { schemaVersion } = await chrome.storage.local.get('schemaVersion');
  if (schemaVersion === version) return;
  await migrateHistoryRows().catch(console.error);
  await migrateMonitorRows().catch(console.error);
  const s = await getSettings();
  const mcp = { ...s.mcp };
  // An untouched blocked-sites list is upgraded to the current default (which now covers the banks
  // and payment providers the word rules can't catch). A list the user edited is left alone.
  if ([...(mcp.blocked || [])].sort().join(',') === [...DEFAULT_BLOCKED_V1].sort().join(',')) {
    mcp.blocked = DEFAULT_BLOCKED;
  }
  // A connector that was already running keeps running: approval is asked for new links, not for
  // one the user set up and has been using.
  if (mcp.enabled && mcp.consentAt && !mcp.pairedAt) mcp.pairedAt = mcp.consentAt;
  // Likewise "Allow actions" was an all-sites switch, and the user turned it on deliberately:
  // keep that meaning rather than silently stopping their automations. The new per-site list is
  // right above it in Settings for anyone who wants to narrow it.
  if (reason === 'update' && mcp.allowActions && !mcp.actionAnySite && !(mcp.actionOrigins || []).length) {
    mcp.actionAnySite = true;
  }
  await saveSettings({ mcp });
  await chrome.storage.local.set({ schemaVersion: version });
}

// ---------- the connector token: one live link per browser ----------
// The token is the password to this browser, mirrored to chrome.storage.sync so that reinstalling
// keeps the link already added in Claude working. A SECOND browser signed into the same Google
// account must not inherit it: both would poll the same relay slot and Claude's calls would land in
// whichever answered first. The owning browser therefore keeps a dated claim, and a browser that
// finds someone else's live claim mints its own link instead.
const ACTIVE_CLAIM_MS = 7 * 24 * 3600 * 1000;

async function installId() {
  const stored = (await chrome.storage.local.get('installId')).installId;
  if (stored) return stored;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installId: id });
  return id;
}

async function publishToken(token) {
  await chrome.storage.sync.set({ connectorToken: token, connectorOwner: { id: await installId(), at: Date.now() } });
}

async function claimConnectorToken(existing) {
  const me = await installId();
  const sync = await chrome.storage.sync.get(['connectorToken', 'connectorOwner']).catch(() => ({}));
  const owner = sync.connectorOwner;
  const otherBrowserIsLive = !!owner && owner.id !== me && Date.now() - (owner.at || 0) < ACTIVE_CLAIM_MS;
  if (existing) {
    if (!otherBrowserIsLive) { await publishToken(existing).catch(() => {}); return { token: existing, scope: 'synced' }; }
    return { token: existing, scope: 'device' };
  }
  const inherited = /^[A-Za-z0-9_-]{32,}$/.test(sync.connectorToken || '') ? sync.connectorToken : '';
  if (inherited && otherBrowserIsLive) return { token: newToken(), scope: 'device' }; // this browser gets its own link
  const token = inherited || newToken();
  await publishToken(token).catch(() => {});
  return { token, scope: 'synced' };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const a = changes.settings.oldValue?.mcp || {};
  const b = changes.settings.newValue?.mcp || {};
  // "Generate new link": publish it only from the browser that owns the shared link.
  if (b.token && a.token !== b.token && b.tokenScope !== 'device') publishToken(b.token).catch(() => {});
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

// Read-modify-write on shared keys, one at a time: parallel Claude calls used to drop log entries
// and status updates by overwriting each other's reads.
let writeQueue = Promise.resolve();
const serialise = (fn) => {
  const run = writeQueue.then(fn);
  writeQueue = run.catch(() => {});
  return run;
};

function setStatus(patch) {
  return serialise(async () => {
    const { mcpStatus } = await chrome.storage.local.get('mcpStatus');
    await chrome.storage.local.set({ mcpStatus: { ...mcpStatus, ...patch, at: Date.now() } });
  });
}

function log(entry) {
  return serialise(async () => {
    const { mcpLog = [] } = await chrome.storage.local.get('mcpLog');
    await chrome.storage.local.set({ mcpLog: [{ ...entry, at: Date.now() }, ...mcpLog].slice(0, 100) });
  });
}

// ---------- the toolbar badge ----------
// One place decides what the badge says, because two sources want it: "Claude is working" and
// "a monitor found something". Clearing one used to wipe the other.
let busyCount = 0;

async function renderBadge() {
  if (busyCount > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: '#6A5CFF' }).catch(() => {});
    await chrome.action.setBadgeText({ text: 'AI' }).catch(() => {});
    return;
  }
  const unseen = (await getMonitors()).reduce((n, m) => n + (m.unseen || 0), 0);
  if (unseen) {
    await chrome.action.setBadgeBackgroundColor({ color: '#E5484D' }).catch(() => {});
    await chrome.action.setBadgeText({ text: String(Math.min(unseen, 99)) }).catch(() => {});
  } else {
    await chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }
}

function setBusy(n) {
  busyCount = Math.max(0, Number(n) || 0);
  renderBadge().catch(() => {});
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
  async useMcpCall() {
    setStatus({ lastUsedAt: Date.now() }).catch(() => {});
    return useMcpCall();
  },
  releaseMcpCall: () => releaseMcpCall(),
  // The first Claude client to use a link has to be approved by the user, so that a link which
  // leaked (a screenshot, a shared project) cannot quietly drive this browser.
  async requestPairing() {
    const s = await getSettings();
    if (s.mcp.pairedAt) return { paired: true };
    if (!s.mcp.pairingRequestedAt) {
      await saveSettings({ mcp: { ...s.mcp, pairingRequestedAt: Date.now() } });
      chrome.notifications?.create('mcp-pairing', {
        type: 'basic', iconUrl: 'icons/icon128.png', title: 'PullRows · approve Claude?',
        message: 'A Claude client used your connector link. Open PullRows → Settings to allow or reject it.',
        priority: 2,
      }, () => void chrome.runtime.lastError);
    }
    return { paired: false };
  },
  // Settings the bridge needs — never the API key.
  async settings() {
    const s = await getSettings();
    // Messaging is JSON: send "unlimited" as a big number.
    const limits = Object.fromEntries(Object.entries(limitsFor(await getLicense())).map(([k, v]) => [k, Number.isFinite(v) ? v : 1e9]));
    return {
      delayMs: s.delayMs,
      concurrency: s.concurrency,
      limits,
      mcp: {
        allowActions: !!s.mcp.allowActions,
        allowDownloads: !!s.mcp.allowDownloads,
        blocked: s.mcp.blocked,
        allowLocal: !!s.mcp.allowLocal,
        actionOrigins: s.mcp.actionOrigins || [],
        actionAnySite: !!s.mcp.actionAnySite,
        pairedAt: s.mcp.pairedAt || 0,
      },
    };
  },
  getDataset: async () => (await chrome.storage.local.get('dataset')).dataset || null,
  getRecipes: async () => (await chrome.storage.local.get('recipes')).recipes || [],
  activeTab: async () => tabInfo(await allowedTab()),
  tabInfo: async ({ tabId }) => tabInfo(await allowedTab(tabId)),
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
  monitors: async () => (await getMonitors()).map(({ lastRows, ...m }) => ({ ...m, runs: (m.runs || []).slice(0, 5) })), // lastRows: pre-1.5.2 monitors only
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
  async screenshot({ tabId, quiet = false }) {
    const tab = await allowedTab(tabId);
    // Chrome can only capture the tab the user is looking at. In quiet mode (the picture that goes
    // with a tool result) we never switch tabs or windows to get it.
    if (!tab.active) {
      if (quiet) return null;
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(400);
    }
    if (!quiet) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
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

const updateMonitorBadge = () => renderBadge();

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
    const diff = error ? null : diffRows(await getMonitorRows(id), rows);
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

// The side panel hands over its pending Data Table edit as it closes: a storage write started in
// `pagehide` is not guaranteed to finish, but a message the worker has already received is.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'dataset:persist') return false;
  if (sender.id !== chrome.runtime.id || sender.tab || !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) {
    sendResponse({ err: 'Not allowed' });
    return false;
  }
  (async () => {
    const { dataset: cur } = await chrome.storage.local.get('dataset');
    // Never overwrite newer results Claude wrote while the edit was pending.
    if (cur?.updatedBy === 'claude' && cur.updatedAt > (msg.dataset?.updatedAt || 0)) return false;
    await chrome.storage.local.set({ dataset: msg.dataset });
    return true;
  })().then((ok) => sendResponse({ ok }), (e) => sendResponse({ err: String(e.message || e) }));
  return true;
});

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
