// The shared Data Table every tool writes into: a set of named sheets.
// Persisted to chrome.storage.local so it survives closing the panel.
import { addHistory } from '../lib/storage.js';
import { recordWin } from './feedback.js';

export const state = {
  dataset: null, // { title, url, source, sheets: [{ name, cols, rows }], active }
  pendingUrls: null, // URLs handed from one tool to another
  listeners: new Set(),
};

export const columnsOf = (rows) => {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return cols;
};

export function makeSheet(name, rows, cols = columnsOf(rows)) {
  return { name, cols, rows };
}

export function activeSheet() {
  const d = state.dataset;
  return d ? d.sheets[Math.min(d.active || 0, d.sheets.length - 1)] : null;
}

let saveTimer = null;
async function persistNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  // Never overwrite newer results Claude wrote while this edit was pending.
  const { dataset: cur } = await chrome.storage.local.get('dataset');
  if (cur?.updatedBy === 'claude' && cur.updatedAt > (state.dataset?.updatedAt || 0)) return;
  await chrome.storage.local.set({ dataset: state.dataset });
}

export function changed({ persist = true } = {}) {
  for (const fn of state.listeners) fn();
  if (persist) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 400);
  }
}

// Closing the panel right after an edit must not lose it.
addEventListener('pagehide', () => { if (saveTimer) persistNow(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) persistNow(); });

// Replace the table with a tool's output and record it in History.
export async function setDataset({ title, url, source, sheets }) {
  state.dataset = { title, url, source, sheets, active: Math.max(0, sheets.findIndex((s) => s.rows.length)), updatedAt: Date.now() };
  changed();
  recordWin('run').catch(() => {});
  await addHistory({
    title, url, source,
    pages: [url],
    results: Object.fromEntries(sheets.map((s) => [s.name, s.rows])),
  }).catch(console.warn);
}

export async function loadDataset() {
  const { dataset } = await chrome.storage.local.get('dataset');
  state.dataset = dataset || null;
}

export function onChange(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

export const isUrl = (v) => /^https?:\/\/\S+$/i.test(String(v || '').trim());
export const urlColumns = (sheet) => sheet ? sheet.cols.filter((c) => sheet.rows.slice(0, 50).some((r) => isUrl(r[c]))) : [];
