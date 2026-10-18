// PAGE EXTRACTOR — define fields once (click on a sample page, or presets) and extract them from
// every URL in a list: one row per page. Fast mode fetches HTML in the background; Browser mode
// opens each page in a background tab so JavaScript-rendered content is included.
import { h, fill, toast, runJob, plural, formDialog } from '../ui.js';
import { makeSheet, setDataset } from '../state.js';
import { pick } from '../picker.js';
import { urlSource, card, numberField, select, actions, primary, secondary } from '../widgets.js';
import { getActiveTab, callInTab, runInNewTab, sleep } from '../../lib/tab.js';
import { fetchDoc, runPool } from '../../lib/net.js';
import { smartRun } from '../../lib/smart.js';
import { capList } from '../plan.js';

const BUILTINS = [
  { group: 'Page metadata', items: ['title', 'h1', 'description', 'canonical', 'og_image', 'author', 'published', 'language', 'word_count'] },
  { group: 'Contacts', items: ['emails', 'phones', 'socials'] },
  { group: 'Product', items: ['price'] },
  { group: 'Instagram post / Reel', items: ['ig_type', 'ig_likes', 'ig_comments', 'ig_author', 'ig_date', 'ig_caption'] },
  { group: 'Google Maps place', items: ['maps_name', 'maps_rating', 'maps_reviews', 'maps_category', 'maps_address', 'maps_phone', 'maps_website', 'maps_hours'] },
  { group: 'Content', items: ['main_text'] },
];
const PRESETS = {
  metadata: ['title', 'description', 'h1', 'canonical', 'og_image', 'author', 'published', 'language'],
  contacts: ['title', 'emails', 'phones', 'socials'],
  instagram: ['ig_type', 'ig_author', 'ig_date', 'ig_likes', 'ig_comments', 'ig_caption'],
  maps: ['maps_name', 'maps_rating', 'maps_reviews', 'maps_category', 'maps_address', 'maps_phone', 'maps_website', 'maps_hours'],
};
const label = (b) => b.replace(/^(maps|ig)_/, '').replace(/_/g, ' ');

export default {
  id: 'page',
  title: 'Page Extractor',
  icon: '⧉',
  desc: 'Same fields from a list of URLs — one row per page. Products, profiles, Maps places.',
  render(ctx) {
    const preset = ctx.preset || {};
    let fields = preset.fields ? structuredClone(preset.fields) : [];
    const urls = urlSource({ initial: preset.urls || [] });
    const mode = select('Mode', [
      { value: 'auto', label: 'Auto — in the background; a hidden tab only for pages that need it' },
      { value: 'fast', label: 'Background only — never open tabs (fastest)' },
      { value: 'browser', label: 'Browser — open every page in a tab (JS-heavy sites, Google Maps)' },
    ], preset.mode || 'auto');
    const conc = numberField('Parallel', preset.concurrency || ctx.settings.concurrency, { min: 1, max: 10 });
    const wait = numberField('Wait after load (ms)', preset.waitMs ?? 1500, { min: 0, max: 30000, step: 250 });
    const fieldsBox = h('div', { class: 'fields' });
    const previewBox = h('div', { class: 'preview' });

    const addBuiltin = (b) => {
      if (!fields.some((f) => f.builtin === b)) fields.push({ name: label(b), builtin: b });
    };

    function renderFields() {
      fill(fieldsBox, 
        fields.length ? null : h('p', { class: 'hint' }, 'No fields yet. Open a sample page and click “Pick field”, or add a preset.'),
        ...fields.map((f, i) => h('div', { class: 'field-row' },
          h('input', { class: 'name-input', value: f.name, onchange: (e) => { f.name = e.target.value.trim() || f.name; } }),
          f.builtin
            ? h('span', { class: 'badge' }, 'auto')
            : h('select', { class: 'attr', onchange: (e) => { f.attr = e.target.value; } },
              (f.attrs || ['text', 'href', 'src', 'html']).map((a) => h('option', { value: a, selected: a === f.attr }, a))),
          f.builtin ? null : h('label', { class: 'check small', title: 'Join all matches instead of the first' },
            h('input', { type: 'checkbox', checked: !!f.multiple, onchange: (e) => { f.multiple = e.target.checked; } }), 'all'),
          h('button', { type: 'button', class: 'icon-btn', title: 'Remove', onclick: () => { fields.splice(i, 1); renderFields(); } }, '×'),
          f.selector ? h('code', { class: 'selector small', contentEditable: 'true', spellcheck: false, onblur: (e) => { f.selector = e.target.textContent.trim(); } }, f.selector) : null)));
    }

    async function pickField() {
      const r = await pick('field').catch((e) => { toast(e.message, 'error'); return null; });
      if (!r) return;
      const base = r.name || 'field';
      let name = base;
      for (let i = 2; fields.some((f) => f.name === name); i++) name = `${base} ${i}`;
      fields.push({ name, selector: r.selector, attr: r.defaultAttr || 'text', attrs: r.attrs });
      renderFields();
      toast(`Added “${name}” = ${r.sample || '(empty)'}`, 'ok');
    }

    async function addBuiltinDialog() {
      const res = await formDialog({
        title: 'Add built-in fields',
        fields: BUILTINS.map((g) => ({ name: g.group, label: g.group, type: 'multiselect', options: g.items.map((b) => ({ value: b, label: label(b) })), value: [] })),
        submit: 'Add',
      });
      if (!res) return;
      Object.values(res).flat().forEach(addBuiltin);
      renderFields();
    }

    const getConfig = () => ({ fields, mode: mode.get(), concurrency: conc.get(), waitMs: wait.get() });

    async function testHere() {
      if (!fields.length) { toast('Add some fields first.', 'error'); return; }
      try {
        const tab = await getActiveTab();
        const res = await callInTab(tab.id, 'extractPage', fields);
        fill(previewBox, h('div', { class: 'muted small' }, 'This page:'),
          h('dl', { class: 'kv' }, res.cols.flatMap((c, i) => [h('dt', {}, c), h('dd', {}, String(res.data[0][i]).slice(0, 300) || '—')])));
      } catch (e) { toast(e.message, 'error'); }
    }

    async function run() {
      const list = capList(urls.get(), 'pageUrls', 'Page Extractor');
      if (!list.length) { toast('Add some URLs.', 'error'); return; }
      if (!fields.length) { toast('Add some fields first.', 'error'); return; }
      const cfg = getConfig();
      if (cfg.mode !== 'browser' && fields.some((f) => f.builtin?.startsWith('maps_'))) {
        toast('Google Maps pages need Browser mode — switching.', '');
        cfg.mode = 'browser';
      }
      await runJob(`Extracting ${plural(list.length, 'page')}…`, async (signal, progress) => {
        const rows = new Array(list.length);
        let inTabs = 0;
        const io = { fetchDoc, signal, renderInTab: (url, method, args) => runInNewTab(url, method, args, { waitMs: cfg.waitMs }) };
        await runPool(list, cfg.mode === 'browser' ? Math.min(cfg.concurrency, 4) : cfg.concurrency, async (url, i) => {
          try {
            const { result: res, via } = await smartRun(url, 'extractPage', [cfg.fields], io, { mode: cfg.mode });
            if (via === 'tab') inTabs++;
            rows[i] = { url, ...Object.fromEntries(res.cols.map((c, k) => [c, res.data[0][k]])), error: '' };
          } catch (e) {
            rows[i] = { url, error: String(e.message || e) };
          }
          if (cfg.mode === 'fast' && ctx.settings.delayMs) await sleep(Math.min(ctx.settings.delayMs, 2000));
        }, { signal, onProgress: (done, total) => progress(`${done} / ${total} pages`, done, total) });
        const out = rows.filter(Boolean);
        const failed = out.filter((r) => r.error).length;
        const cols = ['url', ...fields.map((f) => f.name), ...(failed ? ['error'] : [])];
        await setDataset({ title: `Page Extractor — ${plural(out.length, 'page')}`, url: list[0], source: 'Page Extractor', sheets: [makeSheet('Pages', out.map((r) => { if (!failed) delete r.error; return r; }), cols)] });
        const tabNote = cfg.mode === 'auto' && inTabs ? ` ${inTabs} needed a background tab.` : '';
        toast(`Done: ${plural(out.length - failed, 'page')}${failed ? `, ${failed} failed (see “error” column)` : ''}.${tabNote}`, failed ? '' : 'ok');
        ctx.go('table');
      });
    }

    renderFields();
    const el = h('div', { class: 'stack' },
      card('1. URLs', urls.el),
      card('2. Fields',
        h('div', { class: 'row wrap' },
          h('button', { type: 'button', class: 'btn primary', onclick: pickField }, '⌖ Pick field on this page'),
          h('button', { type: 'button', class: 'btn secondary', onclick: addBuiltinDialog }, '+ Built-in'),
          h('button', { type: 'button', class: 'btn secondary', onclick: testHere }, 'Test here')),
        h('div', { class: 'row wrap' },
          h('span', { class: 'muted small' }, 'Presets:'),
          ...Object.entries({ metadata: 'Page metadata', contacts: 'Contacts', instagram: 'Instagram stats', maps: 'Google Maps place' }).map(([k, v]) =>
            h('button', { type: 'button', class: 'btn tiny', onclick: () => { PRESETS[k].forEach(addBuiltin); if (k === 'maps') mode.input.value = 'browser'; renderFields(); } }, v))),
        fieldsBox, previewBox),
      card('3. Options', mode.el, h('div', { class: 'row' }, conc.el, wait.el)),
      actions(primary('Extract pages', run), secondary('Save recipe', () => ctx.saveRecipe(ctx.tool, { ...getConfig(), urls: urls.get() }))));
    if (ctx.autoRun) setTimeout(run, 50);
    return el;
  },
};
