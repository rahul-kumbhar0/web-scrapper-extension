// Reusable pieces of tool UIs.
import { h, toast } from './ui.js';
import { state, activeSheet, urlColumns, isUrl } from './state.js';
import { parseUrlList } from '../lib/net.js';
import { getActiveTab } from '../lib/tab.js';

// A URL list input: paste, upload CSV/TXT, take a Data Table column, or the current tab.
// Returns { el, get(): string[], set(urls) }.
export function urlSource({ placeholder = 'Paste URLs or domains, one per line…', initial = [] } = {}) {
  const area = h('textarea', { rows: 5, placeholder, spellcheck: false });
  const count = h('span', { class: 'muted small' });
  const update = () => { const n = parseUrlList(area.value).length; count.textContent = n ? `${n} URL${n === 1 ? '' : 's'}` : ''; };
  area.addEventListener('input', update);
  const set = (urls) => { area.value = urls.join('\n'); update(); };

  const file = h('input', { type: 'file', accept: '.csv,.txt,.tsv', hidden: true, onchange: async () => {
    const f = file.files[0];
    if (!f) return;
    const urls = parseUrlList(await f.text());
    set([...parseUrlList(area.value), ...urls]);
    toast(`Loaded ${urls.length} URLs from ${f.name}`, 'ok');
    file.value = '';
  } });

  const fromTable = () => {
    const sheet = activeSheet();
    const cols = urlColumns(sheet);
    if (!cols.length) { toast('The Data Table has no column of URLs yet.', 'error'); return; }
    const col = cols[0];
    const urls = sheet.rows.map((r) => String(r[col] || '').trim()).filter(isUrl);
    set([...new Set(urls)]);
    toast(`Took ${urls.length} URLs from column “${col}”.`, 'ok');
  };

  const fromTab = async () => {
    const tab = await getActiveTab().catch(() => null);
    if (tab?.url && /^https?:/.test(tab.url)) set([...parseUrlList(area.value), tab.url]);
  };

  if (state.pendingUrls?.length) { set(state.pendingUrls); state.pendingUrls = null; } else if (initial.length) set(initial);

  const el = h('div', { class: 'stack' },
    area,
    h('div', { class: 'row wrap' },
      h('button', { type: 'button', class: 'btn tiny', onclick: () => file.click() }, 'Upload CSV/TXT'),
      h('button', { type: 'button', class: 'btn tiny', onclick: fromTable }, 'From Data Table'),
      h('button', { type: 'button', class: 'btn tiny', onclick: fromTab }, 'Add current tab'),
      h('span', { class: 'grow' }), count),
    file);
  return { el, get: () => parseUrlList(area.value), set };
}

export function card(title, ...children) {
  return h('section', { class: 'card' }, title ? h('h2', {}, title) : null, ...children);
}

export function numberField(label, value, { min = 0, max = 100000, step = 1 } = {}) {
  const input = h('input', { type: 'number', value, min, max, step });
  return { el: h('label', { class: 'field inline-field' }, label, input), get: () => Number(input.value), input };
}

export function checkbox(label, checked = false) {
  const input = h('input', { type: 'checkbox', checked });
  return { el: h('label', { class: 'check' }, input, label), get: () => input.checked, input };
}

export function select(label, options, value) {
  const input = h('select', {}, options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  return { el: h('label', { class: 'field' }, label, input), get: () => input.value, input };
}

export function actions(...buttons) {
  return h('div', { class: 'actions-bar' }, ...buttons);
}

export const primary = (label, onclick) => h('button', { type: 'button', class: 'btn primary grow', onclick }, label);
export const secondary = (label, onclick) => h('button', { type: 'button', class: 'btn secondary', onclick }, label);
