// PAGE TEXT EXTRACTOR — clean, AI-ready main content (plain text + Markdown) with metadata.
import { h, fill, toast, runJob, plural } from '../ui.js';
import { capList } from '../plan.js';
import { makeSheet, setDataset } from '../state.js';
import { urlSource, card, numberField, select, actions, primary, secondary } from '../widgets.js';
import { getActiveTab, callInTab, runInNewTab } from '../../lib/tab.js';
import { fetchDoc, runPool } from '../../lib/net.js';
import { download, fileStem } from '../../lib/export.js';

const META = [{ name: 'description', builtin: 'description' }, { name: 'author', builtin: 'author' }, { name: 'published', builtin: 'published' }, { name: 'language', builtin: 'language' }];

export default {
  id: 'text',
  title: 'Page Text Extractor',
  icon: '¶',
  desc: 'Clean article text & Markdown from pages — ready for AI, notes or analysis.',
  usesPage: true,
  render(ctx) {
    const preset = ctx.preset || {};
    const urls = urlSource({ initial: preset.urls || [] });
    const mode = select('Mode', [
      { value: 'fast', label: 'Fast — fetch HTML in background' },
      { value: 'browser', label: 'Browser — open each page (JS sites)' },
    ], preset.mode || 'fast');
    const conc = numberField('Parallel', preset.concurrency || ctx.settings.concurrency, { min: 1, max: 10 });
    const out = h('div', { class: 'preview' });

    const rowFrom = (url, r, m) => ({ url, title: r.title, words: r.words, ...m, text: r.text, markdown: r.markdown });
    const metaOf = (res) => Object.fromEntries(res.cols.map((c, i) => [c, res.data[0][i]]));

    async function current() {
      try {
        const tab = await getActiveTab();
        const r = await callInTab(tab.id, 'readable');
        const m = metaOf(await callInTab(tab.id, 'extractPage', META));
        fill(out, 
          h('div', { class: 'row' },
            h('strong', { class: 'grow' }, `${r.title} · ${plural(r.words, 'word')}`),
            h('button', { type: 'button', class: 'btn tiny', onclick: () => navigator.clipboard.writeText(r.markdown).then(() => toast('Markdown copied.', 'ok')) }, 'Copy Markdown'),
            h('button', { type: 'button', class: 'btn tiny', onclick: () => download(`# ${r.title}\n\nSource: ${tab.url}\n\n${r.markdown}`, `${fileStem(r.title)}.md`, 'text/markdown') }, '.md'),
            h('button', { type: 'button', class: 'btn tiny', onclick: async () => {
              await setDataset({ title: r.title, url: tab.url, source: 'Page Text Extractor', sheets: [makeSheet('Text', [rowFrom(tab.url, r, m)])] });
              ctx.go('table');
            } }, 'To table')),
          h('pre', { class: 'text-preview' }, r.markdown.slice(0, 20000)));
      } catch (e) { toast(e.message, 'error'); }
    }

    async function run() {
      const list = capList(urls.get(), 'textUrls', 'Page Text');
      if (!list.length) { toast('Add some URLs, or use “This page”.', 'error'); return; }
      const m = mode.get();
      await runJob(`Reading ${plural(list.length, 'page')}…`, async (signal, progress) => {
        const engine = globalThis.__webScraper;
        const rows = new Array(list.length);
        await runPool(list, m === 'browser' ? Math.min(conc.get(), 4) : conc.get(), async (url, i) => {
          try {
            if (m === 'browser') {
              const r = await runInNewTab(url, 'readable', []);
              rows[i] = rowFrom(url, r, {});
            } else {
              const { doc } = await fetchDoc(url, { signal });
              rows[i] = rowFrom(url, engine.readable(doc), metaOf(engine.extractPage(META, doc)));
            }
          } catch (e) { rows[i] = { url, error: String(e.message || e) }; }
        }, { signal, onProgress: (d, t) => progress(`${d} / ${t} pages`, d, t) });
        const res = rows.filter(Boolean);
        await setDataset({ title: `Page text — ${plural(res.length, 'page')}`, url: list[0], source: 'Page Text Extractor', sheets: [makeSheet('Text', res)] });
        ctx.go('table');
      });
    }

    if (ctx.autoRun) setTimeout(() => (urls.get().length ? run() : current()), 50);
    return h('div', { class: 'stack' },
      card('This page', h('button', { type: 'button', class: 'btn secondary', onclick: current }, 'Extract text from the current page'), out),
      card('Many pages', urls.el, mode.el, conc.el),
      actions(primary('Extract text', run), secondary('Save recipe', () => ctx.saveRecipe(ctx.tool, { urls: urls.get(), mode: mode.get(), concurrency: conc.get() }))));
  },
};
