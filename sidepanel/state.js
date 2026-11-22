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

// Edits still waiting to be saved when Claude's results arrive go to History in full.
export async function snapshotUnsaved() {
  if (!saveTimer || !state.dataset?.sheets?.length || state.dataset.updatedBy === 'claude') return false;
  clearTimeout(saveTimer);
  saveTimer = null;
  const d = state.dataset;
  await addHistory({ title: `${d.title || 'Data Table'} (your edits before Claude's results)`, url: d.url || '', source: d.source || 'Data Table',
    pages: [d.url].filter(Boolean), results: Object.fromEntries(d.sheets.map((s) => [s.name, s.rows])) }, { keep: true });
  return true;
}
let lastChangeAt = 0; // when the user last changed the table here — also covers "Clear" (null dataset)

async function persistNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  // Never overwrite newer results Claude wrote while this edit was pending. The comparison uses
  // when the USER last acted, so an opened History entry, a cleared table or an edit always wins
  // over an older Claude-written table (those used to carry no updatedAt and silently lose).
  const { dataset: cur } = await chrome.storage.local.get('dataset');
  if (cur?.updatedBy === 'claude' && cur.updatedAt > Math.max(state.dataset?.updatedAt || 0, lastChangeAt)) return;
  await chrome.storage.local.set({ dataset: state.dataset });
}

export function changed({ persist = true } = {}) {
  lastChangeAt = Date.now();
  if (state.dataset && !state.dataset.updatedAt) state.dataset.updatedAt = lastChangeAt;
  for (const fn of state.listeners) fn();
  if (persist) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 150);
  }
}

// Closing the panel right after an edit must not lose it. A storage write started during
// `pagehide` is not guaranteed to finish, so the pending table is also handed to the service
// worker, which is still alive once the message has been delivered.
function persistOnUnload() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const dataset = state.dataset; // may be null: a pending "Clear" must persist too
  try { chrome.runtime.sendMessage({ type: 'dataset:persist', dataset, at: lastChangeAt }, () => void chrome.runtime.lastError); } catch { /* worker gone */ }
  chrome.storage.local.set({ dataset }).catch(() => {});
}
addEventListener('pagehide', persistOnUnload);
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
