// Settings, history and recipes in chrome.storage.local (stays on this device).
import { DEFAULT_RELAY } from './config.js';
import { DEFAULT_BLOCKED } from './guard.js';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — most accurate' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — balanced' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, cheapest' },
];

const DEFAULTS = {
  sheetUrl: '', // Google Sheets: the user's Apps Script web app (lib/sheets.js)
  apiKey: '',
  model: MODELS[0].id,
  delayMs: 1000,
  concurrency: 3,
  quickTypes: ['emails', 'phones', 'links', 'social'],
  aiConsentAt: 0, // when the user agreed that AI features send page text to Anthropic
  // Claude connector (see server/). Off by default; read-only unless actions/downloads are allowed.
  // actionOrigins: the sites Claude may click and type on. Empty + actionAnySite false means
  // "allow actions" is on but no site has been approved yet, so every action is refused.
  // pairedAt: the user approved the first Claude client that used this link (see background.js).
  mcp: {
    enabled: false, server: DEFAULT_RELAY, token: '', consentAt: 0,
    allowActions: false, allowDownloads: false, blocked: DEFAULT_BLOCKED,
    actionOrigins: [], actionAnySite: false,
    pairedAt: 0, pairingRequestedAt: 0, lastUsedAt: 0, tokenScope: 'synced',
  },
};

// Secret that identifies this browser to the MCP relay (part of the MCP link).
export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const HISTORY_LIMIT = 30;
const HISTORY_ROW_LIMIT = 5000; // per sheet

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const mcp = { ...DEFAULTS.mcp, ...settings?.mcp };
  if (!mcp.server) mcp.server = DEFAULT_RELAY;
  return { ...DEFAULTS, ...settings, mcp };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

// ---------- history ----------
// The index (`history`) holds only metadata and row counts; each entry's rows live under their own
// key (`history:rows:<id>`). Writing one result used to rewrite every stored row of the last 30
// runs — megabytes serialised per scrape.
export const historyRowsKey = (id) => `history:rows:${id}`;

export async function getHistory() {
  const { history } = await chrome.storage.local.get('history');
  return (history || []).map(withCounts);
}

// Entries written before 1.5.2 carry their rows inline; report them the same way.
function withCounts(h) {
  if (h.sheets) return h;
  const results = h.results || {};
  return { ...h, sheets: Object.entries(results).map(([name, rows]) => ({ name, rows: rows.length })) };
}

/** The rows of one history entry: { [sheetName]: rows }. */
export async function getHistoryRows(id) {
  const key = historyRowsKey(id);
  const stored = (await chrome.storage.local.get(key))[key];
  if (stored) return stored;
  const entry = (await getHistory()).find((h) => h.id === id);
  return entry?.results || {}; // pre-1.5.2 entry, rows still inline
}

// keep: a snapshot of the user's own table (saved before Claude replaced it). Kept in full and not
// pushed out by later runs (up to 10 such snapshots).
export async function addHistory(entry, { keep = false } = {}) {
  const limit = keep ? 200000 : HISTORY_ROW_LIMIT;
  const id = crypto.randomUUID();
  const results = Object.fromEntries(Object.entries(entry.results).map(([k, v]) => [k, v.slice(0, limit)]));
  const { results: _drop, ...meta } = entry;
  const index = {
    ...meta,
    ...(keep ? { keep: true } : {}),
    id,
    at: Date.now(),
    sheets: Object.entries(results).map(([name, rows]) => ({ name, rows: rows.length })),
  };
  const all = [index, ...(await getHistory())];
  const kept = new Set(all.filter((h) => h.keep).slice(0, 10));
  const rest = all.filter((h) => !h.keep).slice(0, HISTORY_LIMIT);
  const history = all.filter((h) => kept.has(h) || rest.includes(h));
  const evicted = all.filter((h) => !history.includes(h)).map((h) => historyRowsKey(h.id));
  await chrome.storage.local.set({ [historyRowsKey(id)]: results, history });
  if (evicted.length) await chrome.storage.local.remove(evicted);
  return index;
}

export async function deleteHistory(id) {
  await chrome.storage.local.set({ history: (await getHistory()).filter((h) => h.id !== id) });
  await chrome.storage.local.remove(historyRowsKey(id));
}

export async function clearHistory() {
  const keys = (await getHistory()).map((h) => historyRowsKey(h.id));
  await chrome.storage.local.set({ history: [] });
  if (keys.length) await chrome.storage.local.remove(keys);
}

/** One-off: move rows stored inline before 1.5.2 into their own keys. Returns how many moved. */
export async function migrateHistoryRows() {
  const { history } = await chrome.storage.local.get('history');
  if (!history?.some((h) => h.results)) return 0;
  const writes = {};
  const index = history.map((h) => {
    if (!h.results) return h;
    const { results, ...meta } = h;
    writes[historyRowsKey(h.id)] = results;
    return { ...meta, sheets: Object.entries(results).map(([name, rows]) => ({ name, rows: rows.length })) };
  });
  await chrome.storage.local.set({ ...writes, history: index });
  return Object.keys(writes).length;
}

// ---------- recipes: a saved tool setup that can be re-run ----------
export async function getRecipes() {
  const { recipes } = await chrome.storage.local.get('recipes');
  return recipes || [];
}

export async function saveRecipe(recipe) {
  const recipes = await getRecipes();
  const r = { id: recipe.id || crypto.randomUUID(), created: recipe.created || Date.now(), updated: Date.now(), ...recipe };
  const i = recipes.findIndex((x) => x.id === r.id);
  if (i >= 0) recipes[i] = r; else recipes.unshift(r);
  await chrome.storage.local.set({ recipes });
  return r;
}

export async function deleteRecipe(id) {
  await chrome.storage.local.set({ recipes: (await getRecipes()).filter((r) => r.id !== id) });
}

export async function importRecipes(list) {
  const recipes = await getRecipes();
  for (const r of list) {
    if (!r?.tool || !r?.config) continue;
    recipes.unshift({ ...r, id: crypto.randomUUID(), created: Date.now(), updated: Date.now() });
  }
  await chrome.storage.local.set({ recipes });
}
