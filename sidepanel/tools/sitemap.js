// SITEMAP EXPLORER — find every URL a site publishes, filter by section/pattern, hand them to
// another tool (Page / Email / Social / Text extractors) or the Data Table.
import { h, fill, toast, runJob, plural } from '../ui.js';
import { state, makeSheet, setDataset } from '../state.js';
import { card, numberField, actions, primary, secondary } from '../widgets.js';
import { getActiveTab } from '../../lib/tab.js';
import { normalizeUrl } from '../../lib/net.js';
import { discoverSitemaps, crawlSitemaps } from '../../lib/sitemap.js';

export default {
  id: 'sitemap',
  title: 'Sitemap Explorer',
  icon: '⌗',
  desc: 'Find all URLs of a site from its sitemaps. Filter, then send to other tools.',
  render(ctx) {
    const preset = ctx.preset || {};
    const site = h('input', { placeholder: 'example.com', value: preset.site || '', spellcheck: false });
    const maxUrls = numberField('Max URLs', preset.maxUrls || 50000, { min: 10, max: 200000 });
    const filter = h('input', { type: 'search', placeholder: 'Filter: text or /regex/', value: preset.filter || '' });
    const sections = new Set(preset.sections || []);
    const secBox = h('div', { class: 'chip-grid tight' });
    const list = h('div', { class: 'url-list' });
    let rows = [];
    let found = [];

    getActiveTab().then((t) => { if (!site.value && /^https?:/.test(t.url)) site.value = new URL(t.url).host; }).catch(() => {});

    const matcher = () => {
      const f = filter.value.trim();
      if (!f) return () => true;
      const re = f.match(/^\/(.+)\/([a-z]*)$/);
      if (re) { try { const r = new RegExp(re[1], re[2] || 'i'); return (u) => r.test(u); } catch { return () => false; } }
      return (u) => u.toLowerCase().includes(f.toLowerCase());
    };
    const filtered = () => { const m = matcher(); return rows.filter((r) => (!sections.size || sections.has(r.section)) && m(r.url)); };

    function render() {
      const counts = new Map();
      for (const r of rows) counts.set(r.section, (counts.get(r.section) || 0) + 1);
      fill(secBox, ...[...counts].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([s, n]) => h('label', { class: 'chip' },
        h('input', { type: 'checkbox', checked: sections.has(s), onchange: (e) => { if (e.target.checked) sections.add(s); else sections.delete(s); render(); } }), `${s} (${n})`)));
      const f = filtered();
      fill(list, 
        h('div', { class: 'muted small' }, rows.length ? `${f.length} of ${plural(rows.length, 'URL')} · ${plural(found.length, 'sitemap')}` : ''),
        ...f.slice(0, 200).map((r) => h('div', { class: 'url-row', title: r.url }, r.url)),
        f.length > 200 ? h('div', { class: 'muted small' }, `…and ${f.length - 200} more`) : null);
    }
    filter.addEventListener('input', render);

    async function load() {
      const url = normalizeUrl(site.value);
      if (!url) { toast('Enter a website.', 'error'); return; }
      const origin = new URL(url).origin;
      await runJob('Looking for sitemaps…', async (signal, progress) => {
        found = await discoverSitemaps(origin, { signal });
        if (!found.length) throw new Error('No sitemap found (checked robots.txt and common locations).');
        progress(`Reading ${plural(found.length, 'sitemap')}…`);
        const res = await crawlSitemaps(found, { maxUrls: maxUrls.get(), signal, onProgress: (n, s) => progress(`${plural(n, 'URL')} from ${plural(s, 'sitemap')}`) });
        rows = res.rows;
        found = res.sitemaps;
        render();
        toast(`Found ${plural(rows.length, 'URL')}.`, 'ok');
      });
    }

    const send = (toolId) => {
      const urls = filtered().map((r) => r.url);
      if (!urls.length) { toast('No URLs selected.', 'error'); return; }
      state.pendingUrls = urls;
      ctx.go(toolId);
      toast(`Sent ${plural(urls.length, 'URL')}.`, 'ok');
    };

    async function toTable() {
      const f = filtered();
      if (!f.length) { toast('No URLs to save.', 'error'); return; }
      await setDataset({ title: `Sitemap — ${site.value}`, url: normalizeUrl(site.value), source: 'Sitemap Explorer', sheets: [makeSheet('URLs', f, ['url', 'lastmod', 'section', 'sitemap'])] });
      ctx.go('table');
    }

    if (ctx.autoRun) setTimeout(async () => { await load(); }, 50);
    return h('div', { class: 'stack' },
      card('Website', h('div', { class: 'row' }, site, h('button', { type: 'button', class: 'btn primary', onclick: load }, 'Find URLs')), maxUrls.el),
      card('Filter', filter, secBox),
      card(null, list),
      h('div', { class: 'actions-bar wrap' },
        h('span', { class: 'muted small' }, 'Send to:'),
        secondary('Page Extractor', () => send('page')),
        secondary('Emails', () => send('email')),
        secondary('Socials', () => send('social')),
        secondary('Page Text', () => send('text')),
        primary('Data Table', toTable)),
      h('div', { class: 'row' }, secondary('Save recipe', () => ctx.saveRecipe(ctx.tool, { site: site.value, maxUrls: maxUrls.get(), filter: filter.value, sections: [...sections] }))));
  },
};
