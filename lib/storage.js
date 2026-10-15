// Settings, history and recipes in chrome.storage.local (stays on this device).

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — most accurate' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — balanced' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, cheapest' },
];

const DEFAULTS = {
  apiKey: '',
  model: MODELS[0].id,
  delayMs: 1000,
  concurrency: 3,
  quickTypes: ['emails', 'phones', 'links', 'social'],
  mcp: { enabled: false, server: '', token: '' }, // Claude connector (see server/)
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
  return { ...DEFAULTS, ...settings };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

// ---------- history ----------
export async function getHistory() {
  const { history } = await chrome.storage.local.get('history');
  return history || [];
}

export async function addHistory(entry) {
  const trimmed = {
    ...entry,
    id: crypto.randomUUID(),
    at: Date.now(),
    results: Object.fromEntries(Object.entries(entry.results).map(([k, v]) => [k, v.slice(0, HISTORY_ROW_LIMIT)])),
  };
  const history = [trimmed, ...(await getHistory())].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ history });
  return trimmed;
}

export async function deleteHistory(id) {
  await chrome.storage.local.set({ history: (await getHistory()).filter((h) => h.id !== id) });
}

export async function clearHistory() {
  await chrome.storage.local.set({ history: [] });
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
