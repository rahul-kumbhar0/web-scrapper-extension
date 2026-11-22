// MONITORS — a saved recipe re-run on a schedule; each run is compared with the previous one:
// new rows, rows that disappeared, changed values and price drops / rises.
// Stored in chrome.storage.local (stays on this device). Used by the service worker (scheduling,
// alerts), the side panel (Monitors view) and the Claude connector.
import { toNumber } from './clean.js';

export const EVERY = [
  { minutes: 60, label: 'Every hour' },
  { minutes: 360, label: 'Every 6 hours' },
  { minutes: 1440, label: 'Every day' },
  { minutes: 10080, label: 'Every week' },
];
export const ALERTS = {
  any: 'Any change (new, gone or changed rows)',
  new: 'Only new rows',
  drops: 'Only price drops',
};
export const KEEP_ROWS = 5000;
const KEEP_RUNS = 30;

// Each monitor's baseline rows (up to KEEP_ROWS of them) live under their own key: the monitor
// list itself is rewritten on every run, badge update and pause, and must stay small.
export const monitorRowsKey = (id) => `monitor:rows:${id}`;

export async function getMonitors() {
  const { monitors } = await chrome.storage.local.get('monitors');
  return monitors || [];
}

/** The rows kept from a monitor's last successful run, or null if it has never run. */
export async function getMonitorRows(id) {
  const key = monitorRowsKey(id);
  const stored = (await chrome.storage.local.get(key))[key];
  if (stored) return stored;
  const mon = (await getMonitors()).find((m) => m.id === id);
  return mon?.lastRows || null; // pre-1.5.2 monitor, rows still inline
}

// Saving is a read-modify-write of the whole list: two monitors finishing together (or a run and
// a side-panel edit) used to overwrite each other's update, so writes go through one queue.
let writeQueue = Promise.resolve();
const serialise = (fn) => { const run = writeQueue.then(fn); writeQueue = run.catch(() => {}); return run; };

// `lastRows` on the passed object is written to its own key and never stored in the list.
export function saveMonitor(m) {
  return serialise(async () => {
    const list = await getMonitors();
    const { lastRows, ...rest } = m;
    const mon = { id: rest.id || crypto.randomUUID(), created: rest.created || Date.now(), ...rest };
    const i = list.findIndex((x) => x.id === mon.id);
    if (i >= 0) {
      // Merge over the stored monitor: a patch that carries no `runs`/`unseen` keeps them.
      const { lastRows: _old, ...prev } = list[i];
      list[i] = { ...prev, ...mon };
    } else {
      list.unshift({ runs: [], unseen: 0, ...mon });
    }
    if (lastRows) await chrome.storage.local.set({ [monitorRowsKey(mon.id)]: lastRows });
    await chrome.storage.local.set({ monitors: list });
    return { ...(i >= 0 ? list[i] : list[0]), hasRows: !!(lastRows || list[i]?.hasRows) };
  });
}

export function deleteMonitor(id) {
  return serialise(async () => {
    await chrome.storage.local.set({ monitors: (await getMonitors()).filter((m) => m.id !== id) });
    await chrome.storage.local.remove(monitorRowsKey(id));
  });
}

/** One-off: move rows stored inline before 1.5.2 into their own keys. */
export async function migrateMonitorRows() {
  const { monitors } = await chrome.storage.local.get('monitors');
  if (!monitors?.some((m) => m.lastRows)) return 0;
  const writes = {};
  const list = monitors.map((m) => {
    if (!m.lastRows) return m;
    const { lastRows, ...rest } = m;
    writes[monitorRowsKey(m.id)] = lastRows;
    return { ...rest, hasRows: true };
  });
  await chrome.storage.local.set({ ...writes, monitors: list });
  return Object.keys(writes).length;
}

// The column that identifies a row across runs: a link/URL/id column with unique values, else the
// first column whose values are unique, else the whole row.
export function keyColumnOf(rows, cols) {
  const unique = (c) => {
    const vals = rows.map((r) => String(r[c] ?? '').trim()).filter(Boolean);
    return vals.length >= Math.max(1, rows.length * 0.9) && new Set(vals).size === vals.length;
  };
  return cols.find((c) => /^(url|link|href|asin|sku|id|.*[ _](link|url|id))$/i.test(c) && unique(c))
    || cols.find(unique)
    || null;
}

const PRICE_COL = /price|cost|amount|mrp|rate|fee|salary|₹|\$/i;
const looksLikeMoney = (v) => /[₹$€£¥]|\b(usd|eur|inr|gbp|rs\.?)\b/i.test(String(v));

/** Compare two runs. Returns { first, key, added, removed, changed, drops, rises, summary, rows }. */
export function diffRows(prev, rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (!prev) return { first: true, key: keyColumnOf(rows, cols), added: [], removed: [], changed: [], drops: [], rises: [], summary: `First run: ${rows.length} rows saved as the baseline.`, rows: [] };
  const key = keyColumnOf(rows, cols) || keyColumnOf(prev, cols);
  const k = (r) => (key ? String(r[key] ?? '').trim() : JSON.stringify(cols.map((c) => r[c] ?? '')));
  const before = new Map(prev.map((r) => [k(r), r]));
  const now = new Map(rows.map((r) => [k(r), r]));
  const added = rows.filter((r) => !before.has(k(r)));
  const removed = prev.filter((r) => !now.has(k(r)));
  const changed = [];
  const drops = [];
  const rises = [];
  for (const r of rows) {
    const old = before.get(k(r));
    if (!old) continue;
    const fields = [];
    for (const c of cols) {
      const a = String(old[c] ?? '').trim();
      const b = String(r[c] ?? '').trim();
      if (a === b || c === key) continue;
      const na = toNumber(a);
      const nb = toNumber(b);
      const money = na != null && nb != null && (PRICE_COL.test(c) || looksLikeMoney(a) || looksLikeMoney(b));
      const pct = money && na ? Math.round(((nb - na) / na) * 1000) / 10 : null;
      const f = { col: c, from: a, to: b, pct };
      fields.push(f);
      if (money && nb < na) drops.push({ row: r, ...f });
      if (money && nb > na) rises.push({ row: r, ...f });
    }
    if (fields.length) changed.push({ row: r, fields });
  }
  // A readable name for the row in alerts: its title/name column, else the key value.
  const nameCol = cols.find((c) => /^(title|name|product|item|job|company|heading)/i.test(c) && c !== key);
  const label = (r) => String((nameCol && r[nameCol]) || (key && r[key]) || Object.values(r)[0] || '').slice(0, 60);
  const parts = [
    added.length && `${added.length} new`,
    removed.length && `${removed.length} gone`,
    changed.length && `${changed.length} changed`,
    drops.length && `${drops.length} price drop${drops.length > 1 ? 's' : ''}`,
    rises.length && `${rises.length} price rise${rises.length > 1 ? 's' : ''}`,
  ].filter(Boolean);
  const top = drops.sort((a, b) => a.pct - b.pct)[0];
  const summary = parts.length
    ? `${parts.join(', ')}${top ? ` · biggest drop: ${label(top.row)} ${top.from} → ${top.to} (${top.pct}%)` : ''}`
    : 'No changes.';
  // One sheet row per change, for the Data Table / History / Google Sheets.
  const sheet = [
    ...drops.map((d) => ({ change: 'price down', item: label(d.row), column: d.col, before: d.from, after: d.to, percent: d.pct })),
    ...rises.map((d) => ({ change: 'price up', item: label(d.row), column: d.col, before: d.from, after: d.to, percent: d.pct })),
    ...added.map((r) => ({ change: 'new', item: label(r), column: '', before: '', after: '', percent: '' })),
    ...removed.map((r) => ({ change: 'gone', item: label(r), column: '', before: '', after: '', percent: '' })),
    ...changed.flatMap((c) => c.fields.filter((f) => f.pct == null).map((f) => ({ change: 'changed', item: label(c.row), column: f.col, before: f.from, after: f.to, percent: '' }))),
  ];
  return { first: false, key, added, removed, changed, drops, rises, summary, rows: sheet };
}

/** Whether this diff should alert, given the monitor's alert setting. */
export function shouldAlert(diff, alertOn = 'any') {
  if (diff.first) return false;
  if (alertOn === 'drops') return diff.drops.length > 0;
  if (alertOn === 'new') return diff.added.length > 0;
  return diff.added.length + diff.removed.length + diff.changed.length > 0;
}

/** Record a finished run on the monitor (keeps the last KEEP_RUNS run summaries). */
export function recordRun(mon, { rows, diff, error }) {
  const run = { at: Date.now(), ok: !error, error: error || '', summary: error ? `Failed: ${error}` : diff.summary, rows: rows?.length ?? 0, alerted: !error && shouldAlert(diff, mon.alertOn) };
  return {
    ...mon,
    lastRunAt: run.at,
    lastSummary: run.summary,
    lastOk: run.ok,
    ...(error ? {} : { lastRows: rows.slice(0, KEEP_ROWS), hasRows: true, key: diff.key }),
    unseen: (mon.unseen || 0) + (run.alerted ? 1 : 0),
    runs: [run, ...(mon.runs || [])].slice(0, KEEP_RUNS),
  };
}
