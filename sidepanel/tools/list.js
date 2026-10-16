// LIST EXTRACTOR — click one item of any list/grid/table; every similar item becomes a row.
// Handles "Next" buttons/links, "Load more" buttons and infinite scroll (incl. scrollable panels
// like Google Maps' results feed).
import { h, fill, toast, runJob, plural } from '../ui.js';
import { makeSheet, setDataset } from '../state.js';
import { pick } from '../picker.js';
import { card, numberField, actions, primary, secondary } from '../widgets.js';
import { getActiveTab, callInTab, clickAndWait, sleep } from '../../lib/tab.js';
import { runList } from '../../lib/list-runner.js';
import { plan, capNumber } from '../plan.js';

const MODES = [
  { value: 'none', label: 'This page only (scrolls through it)' },
  { value: 'next', label: 'Click “Next” page' },
  { value: 'loadmore', label: 'Click “Load more”' },
  { value: 'scroll', label: 'Infinite scroll (feeds, Maps, Instagram)' },
];

export default {
  id: 'list',
  title: 'List Extractor',
  icon: '☰',
  desc: 'Click one item — get the whole list, grid or table. Pagination & infinite scroll.',
  usesPage: true,
  render(ctx) {
    let candidates = [];
    let index = 0;
    let config = ctx.preset ? structuredClone(ctx.preset) : null; // { itemSelector, fields, pagination }
    let pagination = config?.pagination || { mode: 'none', selector: '', max: 10, delayMs: ctx.settings.delayMs };

    const summary = h('div', { class: 'list-summary muted' }, 'Pick an item on the page, or let the extension find lists automatically.');
    const fieldsBox = h('div', { class: 'fields' });
    const pagBox = h('div', { class: 'stack' });
    const preview = h('div', { class: 'preview' });


    async function highlightCurrent() {
      if (!config) return;
      const tab = await getActiveTab();
      await callInTab(tab.id, 'highlight', config.itemSelector).catch(() => {});
    }

    function setCandidates(list, i = 0) {
      candidates = list;
      index = i;
      if (!list.length) { config = null; toast('No repeating list found here. Try clicking a different item.', 'error'); renderAll(); return; }
      const c = list[index];
      if (c.pagination && pagination.mode === 'none') {
        pagination = { ...pagination, mode: c.pagination.mode, selector: c.pagination.selector || '', max: c.pagination.mode === 'scroll' ? 60 : c.pagination.max || 5 };
      }
      config = { itemSelector: c.itemSelector, fields: c.fields.map((f) => ({ ...f, enabled: true })), preset: c.preset, pagination };
      renderAll();
      highlightCurrent();
      runPreview();
    }

    async function onPick() {
      const res = await pick('list').catch((e) => { toast(e.message, 'error'); return null; });
      if (res) setCandidates(res.candidates || []);
    }

    async function onAuto() {
      try {
        const tab = await getActiveTab();
        setCandidates(await callInTab(tab.id, 'autoDetectLists'));
        if (candidates.length) await autoPagination();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function autoPagination() {
      if (pagination.mode !== 'none') return;
      const tab = await getActiveTab();
      const next = await callInTab(tab.id, 'findNextButton').catch(() => null);
      const more = next ? null : await callInTab(tab.id, 'findLoadMoreButton').catch(() => null);
      if (next) pagination = { ...pagination, mode: 'next', selector: next };
      else if (more) pagination = { ...pagination, mode: 'loadmore', selector: more };
      if (config) config.pagination = pagination;
      renderPagination();
    }

    function renderSummary() {
      if (!config) { fill(summary, 'Pick an item on the page, or let the extension find lists automatically.'); return; }
      const c = candidates[index];
      fill(summary, 
        h('div', { class: 'row' },
          h('strong', { class: 'grow' }, c ? `${plural(c.count, 'item')} found` : 'Saved list', config.preset ? h('span', { class: 'badge preset' }, `Preset: ${config.preset}`) : null),
          candidates.length > 1 ? h('button', { type: 'button', class: 'btn tiny', title: 'Try another list on this page', onclick: () => setCandidates(candidates, (index + 1) % candidates.length) }, `Try another (${index + 1}/${candidates.length})`) : null,
          h('button', { type: 'button', class: 'btn tiny', onclick: highlightCurrent }, 'Show')),
        h('code', { class: 'selector', title: 'Item selector (editable)', contentEditable: 'true', spellcheck: false,
          onblur: (e) => { config.itemSelector = e.target.textContent.trim(); runPreview(); } }, config.itemSelector));
    }

    function renderFields() {
      if (!config) { fill(fieldsBox); return; }
      fill(fieldsBox, 
        h('p', { class: 'hint' }, 'Untick columns you don’t need; click a name to rename it.'),
        ...config.fields.map((f) => h('div', { class: `field-row ${f.enabled ? '' : 'off'}` },
          h('input', { type: 'checkbox', checked: f.enabled, onchange: (e) => { f.enabled = e.target.checked; renderFields(); runPreview(); } }),
          h('input', { class: 'name-input', value: f.name, onchange: (e) => { f.name = e.target.value.trim() || f.name; runPreview(); } }),
          h('span', { class: 'badge' }, { href: 'link', src: 'image', text: 'text', datetime: 'date' }[f.attr] || f.attr))));
    }

    function renderPagination() {
      const mode = h('select', { onchange: (e) => { pagination.mode = e.target.value; if (config) config.pagination = pagination; renderPagination(); } },
        MODES.map((m) => h('option', { value: m.value, selected: m.value === pagination.mode }, m.label)));
      const needsButton = pagination.mode === 'next' || pagination.mode === 'loadmore';
      const sel = h('input', { value: pagination.selector || '', placeholder: 'CSS selector of the button', spellcheck: false, onchange: (e) => { pagination.selector = e.target.value.trim(); } });
      const max = numberField(pagination.mode === 'scroll' ? 'Max scrolls' : pagination.mode === 'loadmore' ? 'Max clicks' : 'Max pages', pagination.max, { min: 1, max: 1000 });
      max.input.addEventListener('change', () => { pagination.max = max.get(); });
      const delay = numberField('Delay (ms)', pagination.delayMs, { min: 0, max: 60000, step: 250 });
      delay.input.addEventListener('change', () => { pagination.delayMs = delay.get(); });
      fill(pagBox, 
        h('label', { class: 'field' }, 'Pagination', mode),
        needsButton ? h('div', { class: 'row' }, sel,
          h('button', { type: 'button', class: 'btn secondary', onclick: async () => {
            const r = await pick('element');
            if (r) { pagination.selector = r.selector; sel.value = r.selector; toast(`Button set: “${r.text || r.selector}”`, 'ok'); }
          } }, 'Pick'),
          h('button', { type: 'button', class: 'btn secondary', title: 'Find it automatically', onclick: async () => {
            const tab = await getActiveTab();
            const found = await callInTab(tab.id, pagination.mode === 'next' ? 'findNextButton' : 'findLoadMoreButton');
            if (found) { pagination.selector = found; sel.value = found; } else toast('No such button found — use Pick.', 'error');
          } }, 'Auto')) : null,
        pagination.mode !== 'none' ? h('div', { class: 'row' }, max.el, delay.el) : null);
    }

    function renderAll() { renderSummary(); renderFields(); renderPagination(); }

    let previewTimer;
    function runPreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        if (!config) { fill(preview); return; }
        try {
          const tab = await getActiveTab();
          const res = await callInTab(tab.id, 'extractList', activeConfig());
          const cols = res.cols;
          const rows = res.data.slice(0, 5);
          fill(preview, 
            h('div', { class: 'muted small' }, `Preview (${plural(res.data.length, 'row')} on this page)`),
            h('div', { class: 'table-wrap mini' }, h('table', {},
              h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))),
              h('tbody', {}, rows.map((r) => h('tr', {}, r.map((v) => h('td', {}, String(v).slice(0, 80)))))))));
        } catch (e) { fill(preview, h('p', { class: 'hint error' }, e.message)); }
      }, 250);
    }

    const activeConfig = () => ({ ...config, fields: config.fields.filter((f) => f.enabled !== false) });

    async function run() {
      if (!config) { toast('Pick a list first.', 'error'); return; }
      const cfg = { ...activeConfig(), pagination: { ...pagination } };
      const limitKey = pagination.mode === 'scroll' ? 'scrollSteps' : 'listPages';
      const capped = pagination.mode !== 'none' && pagination.max > plan.limits[limitKey];
      if (capped) cfg.pagination.max = capNumber(pagination.max, limitKey);
      await runJob('Extracting list…', async (signal, progress) => {
        const tab = await getActiveTab();
        await callInTab(tab.id, 'clearHighlight').catch(() => {});
        const r = await runList(cfg, {
          call: (method, ...a) => callInTab(tab.id, method, ...a),
          clickAndWait: (btn, items) => clickAndWait(tab.id, btn, items),
          sleep,
          signal,
          onProgress: (n, steps, mode) => progress(`${plural(n, 'row')}${mode === 'none' ? '' : ` · ${steps} scroll steps`}`),
        });
        await setDataset({ title: r.title, url: r.url, source: 'List Extractor', sheets: [makeSheet('List', r.rows, r.cols)] });
        const capNote = capped && (r.pages >= cfg.pagination.max || r.steps >= cfg.pagination.max) ? ` Free plan stops at ${cfg.pagination.max} ${pagination.mode === 'scroll' ? 'scrolls' : 'pages'} — upgrade for no limit.` : '';
        toast(`Extracted ${plural(r.rows.length, 'row')}${r.pages > 1 ? ` from ${r.pages} pages` : ''}.${r.warning ? ` ⚠ ${r.warning}` : ''}${capNote}`, r.warning || capNote ? '' : 'ok');
        ctx.go('table');
      });
    }

    const el = h('div', { class: 'stack' },
      card('1. Select the list',
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary grow', onclick: onPick }, '⌖ Pick an item on the page'),
          h('button', { type: 'button', class: 'btn secondary', onclick: onAuto }, 'Auto-detect')),
        summary),
      card('2. Columns', fieldsBox, preview),
      card('3. Pages', pagBox),
      actions(
        primary('Extract list', run),
        secondary('Save recipe', () => config ? ctx.saveRecipe(ctx.tool, { ...activeConfig(), pagination }) : toast('Pick a list first.', 'error'))));

    renderAll();
    if (config) { runPreview(); highlightCurrent(); }
    if (ctx.autoRun && config) setTimeout(run, 50);
    else if (ctx.autoDetect && !config) setTimeout(onAuto, 50);
    return { el, cleanup: () => getActiveTab().then((t) => callInTab(t.id, 'clearHighlight')).catch(() => {}) };
  },
};
