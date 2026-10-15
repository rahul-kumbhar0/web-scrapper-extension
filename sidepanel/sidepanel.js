import { getActiveTab, callInTab, navigate, sleep } from '../lib/tab.js';
import { toCSV, toTSV, toJSON, toXLSX, download, fileStem } from '../lib/export.js';
import { aiExtract, MAX_PAGE_CHARS } from '../lib/ai.js';
import { exportToSheets, sheetsConfigured } from '../lib/sheets.js';
import { MODELS, getSettings, saveSettings, getHistory, addHistory, deleteHistory, clearHistory } from '../lib/storage.js';

const EXTRACTORS = {
  emails: 'Emails',
  phones: 'Phones',
  links: 'Links',
  images: 'Images',
  tables: 'Tables',
  text: 'Text',
  social: 'Social profiles',
  prices: 'Prices',
  pagination: 'Pagination',
};
const LABELS = { ...EXTRACTORS, custom: 'Custom', ai: 'AI' };
const MAX_RENDERED_ROWS = 500;
const AI_EXAMPLES = [
  'Every product with name, price and link',
  'People listed: name, job title, company, email',
  'Job postings: title, company, location, salary',
  'Article headlines with date and author',
];

const $ = (id) => document.getElementById(id);
let settings;
let current = null; // { title, url, pages, results: { type: rows[] } }
let activeType = null;
let abort = null;

// ---------- small DOM helper (always textContent — page data is untrusted) ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : String(c));
  return el;
}

let statusTimer;
function status(msg, kind = '', sticky = false) {
  const el = $('status');
  clearTimeout(statusTimer);
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.className = `status ${kind}`;
  el.hidden = false;
  if (!sticky) statusTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 7000 : 3500);
}

// ---------- tabs ----------
function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `tab-${name}`;
  $('results').hidden = !current || name === 'settings' || name === 'history';
  if (name === 'history') renderHistory();
  if (name === 'ai') refreshAiMeta();
}

// ---------- scrape tab ----------
function renderExtractorGrid() {
  const grid = $('extractor-grid');
  grid.replaceChildren(...Object.entries(EXTRACTORS).map(([key, label]) =>
    h('label', { className: 'chip' },
      h('input', { type: 'checkbox', value: key, checked: settings.extractors.includes(key), onchange: persistExtractors }),
      label)));
  updateToggleAll();
}

function selectedExtractors() {
  return [...$('extractor-grid').querySelectorAll('input:checked')].map((i) => i.value);
}

function persistExtractors() {
  updateToggleAll();
  saveSettings({ extractors: selectedExtractors() }).then((s) => { settings = s; });
}

function updateToggleAll() {
  const all = selectedExtractors().length === Object.keys(EXTRACTORS).length;
  $('toggle-all').textContent = all ? 'Select none' : 'Select all';
}

$('toggle-all').addEventListener('click', () => {
  const all = selectedExtractors().length === Object.keys(EXTRACTORS).length;
  for (const i of $('extractor-grid').querySelectorAll('input')) i.checked = !all;
  persistExtractors();
});

async function updateSelectorCount() {
  const sel = $('selector').value.trim();
  if (!sel) { $('selector-count').textContent = ''; return; }
  try {
    const tab = await getActiveTab();
    const n = await callInTab(tab.id, 'countSelector', sel);
    $('selector-count').textContent = `${n} match${n === 1 ? '' : 'es'}`;
  } catch {
    $('selector-count').textContent = 'invalid selector';
  }
}
let countTimer;
$('selector').addEventListener('input', () => { clearTimeout(countTimer); countTimer = setTimeout(updateSelectorCount, 400); });

$('pick').addEventListener('click', async () => {
  try {
    const tab = await getActiveTab();
    await callInTab(tab.id, 'startPicker');
    status('Click an element on the page (Esc to cancel)…', '', true);
  } catch (e) {
    status(e.message, 'error');
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'PICKER_RESULT') return;
  if (msg.cancelled) { status('Picker cancelled.'); return; }
  $('selector').value = msg.selector;
  $('selector-count').textContent = `${msg.count} match${msg.count === 1 ? '' : 'es'}`;
  status(`Selected ${msg.count} similar element${msg.count === 1 ? '' : 's'}.`, 'ok');
});

function setBusy(busy, which = 'scrape') {
  $('run-scrape').disabled = busy;
  $('run-ai').disabled = busy;
  $(which === 'ai' ? 'stop-ai' : 'stop').hidden = !busy;
}

const unpack = (packed) => (packed?.data || []).map((vals) => Object.fromEntries(packed.cols.map((c, i) => [c, vals[i]])));

function mergeRows(target, rows, pageUrl, multi) {
  const seen = new Set(target.map((r) => JSON.stringify({ ...r, page_url: undefined })));
  for (const r of rows) {
    const key = JSON.stringify({ ...r, page_url: undefined });
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(multi ? { ...r, page_url: pageUrl } : r);
  }
}

$('run-scrape').addEventListener('click', async () => {
  const types = selectedExtractors();
  const selector = $('selector').value.trim();
  if (selector) types.push('custom');
  if (!types.length) { status('Pick at least one thing to extract, or enter a custom selector.', 'error'); return; }

  const follow = $('opt-pages').checked;
  const maxPages = follow ? Math.max(2, Math.min(100, Number($('opt-max-pages').value) || 5)) : 1;
  const scroll = $('opt-scroll').checked;
  abort = { stopped: false };
  const token = abort;
  setBusy(true);

  try {
    const tab = await getActiveTab();
    const results = Object.fromEntries(types.map((t) => [t, []]));
    const pages = [];
    let first = null;
    for (let i = 0; i < maxPages && !token.stopped; i++) {
      status(maxPages > 1 ? `Scraping page ${i + 1} of up to ${maxPages}…` : 'Scraping…', '', true);
      if (scroll) await callInTab(tab.id, 'autoScroll', {});
      const res = await callInTab(tab.id, 'run', types, { selector });
      first ??= res;
      pages.push(res.url);
      for (const t of types) mergeRows(results[t], unpack(res.results[t]), res.url, maxPages > 1);
      const errs = Object.entries(res.errors || {});
      if (errs.length) console.warn('Extractor errors', errs);

      if (i === maxPages - 1 || token.stopped) break;
      if (!res.next || pages.includes(res.next)) { status('No more “Next” pages found.'); break; }
      await sleep(settings.pageDelayMs);
      if (token.stopped) break;
      await navigate(tab.id, res.next);
    }
    setResults({ title: first.title, url: first.url, pages, results, source: 'scrape' });
    const total = Object.values(results).reduce((n, r) => n + r.length, 0);
    status(`Found ${total} item${total === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}${token.stopped ? ' (stopped)' : ''}.`, 'ok');
  } catch (e) {
    status(e.message, 'error');
  } finally {
    setBusy(false);
    abort = null;
  }
});

$('stop').addEventListener('click', () => { if (abort) abort.stopped = true; status('Stopping after this page…', '', true); });

// ---------- AI tab ----------
$('ai-examples').replaceChildren(...AI_EXAMPLES.map((ex) =>
  h('button', { type: 'button', onclick: () => { $('ai-goal').value = ex; $('ai-goal').focus(); } }, ex)));

async function refreshAiMeta() {
  const meta = $('ai-meta');
  const model = MODELS.find((m) => m.id === settings.model)?.label || settings.model;
  meta.textContent = settings.apiKey ? `Model: ${model}` : 'No API key yet — add one in Settings.';
}

$('run-ai').addEventListener('click', async () => {
  const goal = $('ai-goal').value.trim();
  if (!goal) { status('Describe what you want to extract.', 'error'); return; }
  if (!settings.apiKey) { status('Add your Anthropic API key in Settings first.', 'error'); showTab('settings'); return; }
  const controller = new AbortController();
  abort = { stopped: false, controller };
  setBusy(true, 'ai');
  try {
    const tab = await getActiveTab();
    const page = await callInTab(tab.id, 'pageText', MAX_PAGE_CHARS);
    status(`Asking Claude${page.truncated ? ' (page text truncated to fit)' : ''}…`, '', true);
    const { rows, usage } = await aiExtract({ apiKey: settings.apiKey, model: settings.model, goal, page, signal: controller.signal });
    setResults({ title: page.title, url: page.url, pages: [page.url], results: { ai: rows }, source: 'ai', goal });
    const tokens = usage ? ` · ${usage.input_tokens + usage.output_tokens} tokens` : '';
    status(`Claude found ${rows.length} row${rows.length === 1 ? '' : 's'}${tokens}.`, 'ok');
  } catch (e) {
    status(e.name === 'AbortError' ? 'Stopped.' : e.message, 'error');
  } finally {
    setBusy(false, 'ai');
    abort = null;
  }
});

$('stop-ai').addEventListener('click', () => abort?.controller?.abort());

// ---------- results ----------
async function setResults(data, { save = true } = {}) {
  current = data;
  const types = Object.keys(data.results);
  activeType = types.find((t) => data.results[t].length) || types[0];
  $('filter').value = '';
  renderResults();
  $('results').hidden = false;
  if (save) await addHistory(data);
}

function renderResults() {
  const { title, url, pages, results } = current;
  $('results-title').textContent = title || 'Results';
  $('results-sub').textContent = pages.length > 1 ? `${url} (+${pages.length - 1} more pages)` : url;
  $('type-tabs').replaceChildren(...Object.entries(results).map(([t, rows]) =>
    h('button', {
      type: 'button',
      'aria-pressed': String(t === activeType),
      onclick: () => { activeType = t; renderResults(); },
    }, LABELS[t] || t, h('span', { className: 'count' }, rows.length))));
  renderTable();
}

function filteredRows() {
  const rows = current.results[activeType] || [];
  const q = $('filter').value.trim().toLowerCase();
  return q ? rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(q))) : rows;
}

function renderCell(key, value) {
  const v = String(value ?? '');
  if (/^https?:\/\//i.test(v)) {
    if ((activeType === 'images' && key === 'src') || key === 'image') {
      return h('a', { href: v, target: '_blank', rel: 'noreferrer', title: v }, h('img', { src: v, alt: '', loading: 'lazy' }));
    }
    return h('a', { href: v, target: '_blank', rel: 'noreferrer' }, v);
  }
  return v;
}

function renderTable() {
  const rows = filteredRows();
  const table = $('table');
  if (!rows.length) {
    table.replaceChildren(h('tbody', {}, h('tr', {}, h('td', { className: 'empty' }, 'Nothing found.'))));
    $('table-note').textContent = '';
    return;
  }
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const shown = rows.slice(0, MAX_RENDERED_ROWS);
  table.replaceChildren(
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))),
    h('tbody', {}, shown.map((r) => h('tr', {}, cols.map((c) => h('td', {}, renderCell(c, r[c])))))),
  );
  $('table-note').textContent = rows.length > shown.length
    ? `Showing ${shown.length} of ${rows.length} rows — exports include all rows.`
    : `${rows.length} row${rows.length === 1 ? '' : 's'}`;
}

$('filter').addEventListener('input', renderTable);
$('clear-results').addEventListener('click', () => { current = null; $('results').hidden = true; });

function allSheets() {
  return Object.entries(current.results).filter(([, rows]) => rows.length).map(([t, rows]) => ({ name: LABELS[t] || t, rows }));
}

for (const btn of document.querySelectorAll('[data-export]')) {
  btn.addEventListener('click', async () => {
    if (!current) return;
    const stem = fileStem(current.title);
    const rows = filteredRows();
    try {
      switch (btn.dataset.export) {
        case 'csv':
          if (!rows.length) throw new Error('Nothing to export in this tab.');
          download(toCSV(rows), `${stem}-${activeType}.csv`, 'text/csv;charset=utf-8');
          break;
        case 'copy':
          if (!rows.length) throw new Error('Nothing to copy in this tab.');
          await navigator.clipboard.writeText(toTSV(rows));
          status(`Copied ${rows.length} rows — paste into any spreadsheet.`, 'ok');
          break;
        case 'xlsx': {
          const sheets = allSheets();
          if (!sheets.length) throw new Error('Nothing to export.');
          download(toXLSX(sheets), `${stem}.xlsx`);
          break;
        }
        case 'json':
          download(toJSON({ url: current.url, title: current.title, pages: current.pages, scrapedAt: new Date().toISOString(), results: current.results }),
            `${stem}.json`, 'application/json');
          break;
        case 'sheets': {
          const sheets = allSheets();
          if (!sheets.length) throw new Error('Nothing to export.');
          status('Creating Google Sheet…', '', true);
          const url = await exportToSheets(`${current.title || 'Scrape'} — ${new Date().toLocaleString()}`, sheets);
          chrome.tabs.create({ url });
          status('Google Sheet created.', 'ok');
          break;
        }
      }
    } catch (e) {
      status(e.message, 'error');
    }
  });
}

// ---------- history ----------
async function renderHistory() {
  const list = $('history-list');
  const items = await getHistory();
  if (!items.length) { list.replaceChildren(h('li', { className: 'empty' }, 'No scrapes yet.')); return; }
  list.replaceChildren(...items.map((item) => {
    const counts = Object.entries(item.results).map(([t, r]) => `${LABELS[t] || t}: ${r.length}`).join(' · ');
    return h('li', {},
      h('div', { className: 'title', title: item.title }, item.title || item.url),
      h('div', { className: 'meta' }, `${new Date(item.at).toLocaleString()} · ${item.pages?.length || 1} page(s)`),
      h('div', { className: 'meta' }, counts),
      h('div', { className: 'actions' },
        h('button', { className: 'link-btn', type: 'button', onclick: () => { setResults(item, { save: false }); showTab(item.source === 'ai' ? 'ai' : 'scrape'); } }, 'Open'),
        h('button', { className: 'link-btn', type: 'button', onclick: async () => { await deleteHistory(item.id); renderHistory(); } }, 'Delete')));
  }));
}

$('clear-history').addEventListener('click', async () => {
  if (!confirm('Delete all saved scrapes?')) return;
  await clearHistory();
  renderHistory();
});

// ---------- settings ----------
function fillSettings() {
  $('api-key').value = settings.apiKey;
  $('model').replaceChildren(...MODELS.map((m) => h('option', { value: m.id, selected: m.id === settings.model }, m.label)));
  $('page-delay').value = settings.pageDelayMs;
  $('opt-max-pages').value = settings.maxPages;
  $('opt-scroll').checked = settings.autoScroll;
  $('sheets-status').textContent = sheetsConfigured()
    ? 'Ready — you will be asked to sign in with Google on first export.'
    : 'Not set up: add your Google OAuth client ID to manifest.json (see README). CSV / Excel / JSON work without it.';
}

$('show-key').addEventListener('click', () => {
  const input = $('api-key');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('show-key').textContent = input.type === 'password' ? 'Show' : 'Hide';
});

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  settings = await saveSettings({
    apiKey: $('api-key').value.trim(),
    model: $('model').value,
    pageDelayMs: Math.max(0, Number($('page-delay').value) || 0),
  });
  $('settings-saved').hidden = false;
  setTimeout(() => { $('settings-saved').hidden = true; }, 2000);
  refreshAiMeta();
});

$('opt-max-pages').addEventListener('change', () => saveSettings({ maxPages: Number($('opt-max-pages').value) || 5 }).then((s) => { settings = s; }));
$('opt-scroll').addEventListener('change', () => saveSettings({ autoScroll: $('opt-scroll').checked }).then((s) => { settings = s; }));

// ---------- page indicator ----------
async function updateHost() {
  try {
    const tab = await getActiveTab();
    $('page-host').textContent = tab.url ? new URL(tab.url).host || tab.url : '';
  } catch { $('page-host').textContent = ''; }
}
chrome.tabs.onActivated.addListener(updateHost);
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (tab.active && info.url) updateHost(); });

// ---------- init ----------
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

settings = await getSettings();
renderExtractorGrid();
fillSettings();
updateHost();
