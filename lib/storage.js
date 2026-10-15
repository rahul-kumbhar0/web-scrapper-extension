// Settings and scrape history in chrome.storage.local (stays on this device).

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — most accurate' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — balanced' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, cheapest' },
];

const DEFAULTS = {
  apiKey: '',
  model: MODELS[0].id,
  maxPages: 5,
  pageDelayMs: 1500,
  autoScroll: false,
  extractors: ['emails', 'phones', 'links', 'social'],
};

const HISTORY_LIMIT = 20;
const HISTORY_ROW_LIMIT = 2000; // per type, keeps storage well under quota

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...settings };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

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
  const history = (await getHistory()).filter((h) => h.id !== id);
  await chrome.storage.local.set({ history });
}

export async function clearHistory() {
  await chrome.storage.local.set({ history: [] });
}
