// AI EXTRACT (Claude) — describe the data you want in plain English; Claude reads the page
// (optionally after scrolling / across several URLs) and returns a clean table.
import { h, toast, runJob, plural } from '../ui.js';
import { makeSheet, setDataset } from '../state.js';
import { urlSource, card, checkbox, actions, primary, secondary } from '../widgets.js';
import { getActiveTab, callInTab, runInNewTab } from '../../lib/tab.js';
import { aiExtract, MAX_PAGE_CHARS } from '../../lib/ai.js';
import { MODELS } from '../../lib/storage.js';

const EXAMPLES = [
  'Every product with name, price, rating and link',
  'People listed: name, job title, company, email, LinkedIn',
  'Job postings: title, company, location, salary, link',
  'Businesses: name, address, phone, website, rating',
  'Article headlines with date, author and URL',
];

export default {
  id: 'ai',
  title: 'AI Extract (Claude)',
  icon: '✦',
  desc: 'Describe what you want in plain English — Claude turns the page into a table.',
  usesPage: true,
  render(ctx) {
    const preset = ctx.preset || {};
    const goal = h('textarea', { rows: 4, placeholder: 'e.g. Every product with name, price, rating and link', value: preset.goal || '' });
    const scroll = checkbox('Scroll the page first (loads more items)', preset.scroll ?? false);
    const urls = urlSource({ placeholder: 'Optional: run the same request on many URLs (one per line)', initial: preset.urls || [] });
    const model = MODELS.find((m) => m.id === ctx.settings.model)?.label || ctx.settings.model;

    const getConfig = () => ({ goal: goal.value.trim(), scroll: scroll.get(), urls: urls.get() });

    async function run() {
      const cfg = getConfig();
      if (!cfg.goal) { toast('Describe what to extract.', 'error'); return; }
      if (!ctx.settings.apiKey) { toast('Add your Anthropic API key in Settings first.', 'error'); ctx.go('settings'); return; }
      await runJob('Asking Claude…', async (signal, progress) => {
        const rows = [];
        let tokens = 0;
        let title = '';
        let firstUrl = '';
        const one = async (page) => {
          const res = await aiExtract({ apiKey: ctx.settings.apiKey, model: ctx.settings.model, goal: cfg.goal, page, signal });
          tokens += (res.usage?.input_tokens || 0) + (res.usage?.output_tokens || 0);
          return res.rows;
        };
        if (cfg.urls.length) {
          for (const [i, url] of cfg.urls.entries()) {
            if (signal.aborted) break;
            progress(`Page ${i + 1} of ${cfg.urls.length}`, i, cfg.urls.length);
            try {
              const page = await runInNewTab(url, 'pageText', [MAX_PAGE_CHARS]);
              for (const r of await one(page)) rows.push({ ...r, source_url: url });
            } catch (e) { rows.push({ source_url: url, error: String(e.message || e) }); }
          }
          title = `AI extract — ${plural(cfg.urls.length, 'page')}`;
          firstUrl = cfg.urls[0];
        } else {
          const tab = await getActiveTab();
          if (cfg.scroll) { progress('Scrolling…'); await callInTab(tab.id, 'autoScroll', {}); }
          const page = await callInTab(tab.id, 'pageText', MAX_PAGE_CHARS);
          progress(`Claude is reading the page${page.truncated ? ' (truncated to fit)' : ''}…`);
          rows.push(...await one(page));
          title = page.title;
          firstUrl = page.url;
        }
        await setDataset({ title, url: firstUrl, source: 'AI Extract', sheets: [makeSheet('AI', rows)] });
        toast(`Claude found ${plural(rows.length, 'row')} · ${tokens.toLocaleString()} tokens.`, 'ok');
        ctx.go('table');
      });
    }

    if (ctx.autoRun) setTimeout(run, 50);
    return h('div', { class: 'stack' },
      card('What do you want?', goal,
        h('div', { class: 'example-list' }, EXAMPLES.map((ex) => h('button', { type: 'button', onclick: () => { goal.value = ex; goal.focus(); } }, ex))),
        scroll.el,
        h('p', { class: 'hint' }, ctx.settings.apiKey ? `Model: ${model} · uses your Anthropic API key` : '⚠ No API key yet — add one in Settings.')),
      card('Many pages (optional)', urls.el),
      actions(primary('Extract with Claude', run), secondary('Save recipe', () => ctx.saveRecipe(ctx.tool, getConfig()))),
      h('p', { class: 'hint' }, 'The page’s visible text is sent to the Anthropic API with your request. Nothing is sent anywhere else.'));
  },
};
