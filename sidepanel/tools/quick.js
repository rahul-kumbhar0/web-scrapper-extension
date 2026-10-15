// QUICK SCAN — one click: emails, phones, links, images, tables, text, socials, prices, pagination
// (+ custom selector), optionally following "Next" links across pages. One sheet per type.
import { h, toast, runJob, plural } from '../ui.js';
import { makeSheet, setDataset } from '../state.js';
import { pick } from '../picker.js';
import { card, numberField, checkbox, actions, primary, secondary } from '../widgets.js';
import { getActiveTab, callInTab, navigate, sleep } from '../../lib/tab.js';
import { saveSettings } from '../../lib/storage.js';

export const QUICK_TYPES = {
  emails: 'Emails', phones: 'Phones', links: 'Links', images: 'Images', tables: 'Tables',
  text: 'Text', social: 'Social profiles', prices: 'Prices', pagination: 'Pagination',
};

const unpack = (p) => (p?.data || []).map((v) => Object.fromEntries(p.cols.map((c, i) => [c, v[i]])));

export default {
  id: 'quick',
  title: 'Quick Scan',
  icon: '⚡',
  desc: 'Everything on this page in one click: emails, phones, links, tables, prices…',
  usesPage: true,
  render(ctx) {
    const preset = ctx.preset || {};
    const chosen = new Set(preset.types || ctx.settings.quickTypes);
    const grid = h('div', { class: 'chip-grid' }, Object.entries(QUICK_TYPES).map(([k, label]) => h('label', { class: 'chip' },
      h('input', { type: 'checkbox', checked: chosen.has(k), onchange: (e) => {
        if (e.target.checked) chosen.add(k); else chosen.delete(k);
        saveSettings({ quickTypes: [...chosen] }).then(() => ctx.reloadSettings());
      } }), label)));
    const selector = h('input', { placeholder: 'Custom CSS selector (optional), e.g. .product h2', value: preset.selector || '', spellcheck: false });
    const scroll = checkbox('Scroll to the bottom first (infinite scroll / lazy content)', preset.scroll ?? false);
    const follow = checkbox('Follow “Next” links', preset.follow ?? false);
    const maxPages = numberField('Max pages', preset.maxPages || 5, { min: 2, max: 200 });

    const getConfig = () => ({ types: [...chosen], selector: selector.value.trim(), scroll: scroll.get(), follow: follow.get(), maxPages: maxPages.get() });

    async function run() {
      const cfg = getConfig();
      const types = [...cfg.types];
      if (cfg.selector) types.push('custom');
      if (!types.length) { toast('Choose at least one thing to extract.', 'error'); return; }
      const max = cfg.follow ? cfg.maxPages : 1;
      await runJob('Scanning…', async (signal, progress) => {
        const tab = await getActiveTab();
        const sheets = Object.fromEntries(types.map((t) => [t, { rows: [], seen: new Set(), cols: null }]));
        const pages = [];
        let first;
        for (let i = 0; i < max && !signal.aborted; i++) {
          progress(max > 1 ? `Page ${i + 1} of up to ${max}` : 'Scanning…', i, max);
          if (cfg.scroll) await callInTab(tab.id, 'autoScroll', {});
          const res = await callInTab(tab.id, 'quick', types, { selector: cfg.selector });
          first ??= res;
          pages.push(res.url);
          for (const t of types) {
            const s = sheets[t];
            s.cols ??= res.results[t].cols;
            for (const row of unpack(res.results[t])) {
              const key = JSON.stringify(row);
              if (s.seen.has(key)) continue;
              s.seen.add(key);
              s.rows.push(max > 1 ? { ...row, page_url: res.url } : row);
            }
          }
          if (i === max - 1 || !res.next || pages.includes(res.next)) break;
          await sleep(ctx.settings.delayMs);
          await navigate(tab.id, res.next);
        }
        const out = types.map((t) => makeSheet(t === 'custom' ? 'Custom' : QUICK_TYPES[t], sheets[t].rows, [...(sheets[t].cols || []), ...(max > 1 ? ['page_url'] : [])]));
        const total = out.reduce((n, s) => n + s.rows.length, 0);
        await setDataset({ title: first.title, url: first.url, source: 'Quick Scan', sheets: out });
        toast(`Found ${plural(total, 'item')} on ${plural(pages.length, 'page')}.`, 'ok');
        ctx.go('table');
      });
    }

    if (ctx.autoRun) setTimeout(run, 50);
    return h('div', { class: 'stack' },
      card('What to extract', grid),
      card('Custom selector', h('div', { class: 'row' }, selector, h('button', { type: 'button', class: 'btn secondary', onclick: async () => {
        const r = await pick('selector');
        if (r) { selector.value = r.selector; toast(`${plural(r.count, 'match', 'matches')}.`, 'ok'); }
      } }, 'Pick'))),
      card('Options', scroll.el, follow.el, maxPages.el),
      actions(primary('Scan page', run), secondary('Save recipe', () => ctx.saveRecipe(ctx.tool, getConfig()))));
  },
};
