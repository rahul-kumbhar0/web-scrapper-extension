import { h, $, toast, stopJob, plural } from './ui.js';
import './picker.js';
import { state, loadDataset, onChange } from './state.js';
import { getSettings, saveRecipe } from '../lib/storage.js';
import { getActiveTab, navigate } from '../lib/tab.js';

import listTool from './tools/list.js';
import pageTool from './tools/page.js';
import { emailTool, socialTool } from './tools/contacts.js';
import imagesTool from './tools/images.js';
import shopifyTool from './tools/shopify.js';
import sitemapTool from './tools/sitemap.js';
import textTool from './tools/text.js';
import quickTool from './tools/quick.js';
import aiTool from './tools/ai.js';
import tableView from './views/table.js';
import recipesView from './views/recipes.js';
import historyView from './views/history.js';
import settingsView from './views/settings.js';

export const TOOLS = [listTool, pageTool, emailTool, socialTool, imagesTool, shopifyTool, sitemapTool, textTool, quickTool, aiTool];
const VIEWS = { table: tableView, recipes: recipesView, history: historyView, settings: settingsView };
const ALL = Object.fromEntries([...TOOLS, ...Object.values(VIEWS)].map((t) => [t.id, t]));

let settings;
let currentId = 'home';
let cleanup = null;

export const ctx = {
  get settings() { return settings; },
  async reloadSettings() { settings = await getSettings(); return settings; },
  go,
  async saveRecipe(tool, config, defaultName) {
    const { formDialog } = await import('./ui.js');
    const tab = await getActiveTab().catch(() => null);
    const res = await formDialog({
      title: 'Save as recipe',
      text: 'Recipes remember this setup so you can run it again in one click.',
      fields: [
        { name: 'name', label: 'Name', value: defaultName || `${tool.title} — ${tab?.url ? new URL(tab.url).host : ''}` },
        { name: 'url', label: 'Start page (opened before running; leave empty to use the current tab)', value: tool.usesPage ? tab?.url || '' : '' },
      ],
      submit: 'Save recipe',
    });
    if (!res) return;
    await saveRecipe({ name: res.name, tool: tool.id, url: res.url, config });
    toast('Recipe saved.', 'ok');
  },
  async runRecipe(recipe) {
    const tool = ALL[recipe.tool];
    if (!tool) { toast(`Unknown tool “${recipe.tool}”.`, 'error'); return; }
    if (recipe.url && tool.usesPage) {
      const tab = await getActiveTab();
      if (tab.url !== recipe.url) {
        toast('Opening the recipe page…', '', true);
        await navigate(tab.id, recipe.url);
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    go(tool.id, { preset: recipe.config, autoRun: true });
  },
};

export function go(id, opts = {}) {
  cleanup?.();
  cleanup = null;
  currentId = id;
  const view = $('#view');
  view.replaceChildren();
  $('#back').hidden = id === 'home';
  $('#title').textContent = id === 'home' ? 'Web Scraper' : ALL[id].title;
  document.body.dataset.view = id;
  if (id === 'home') { view.append(renderHome()); return; }
  const tool = ALL[id];
  const out = tool.render({ ...ctx, ...opts, tool });
  view.append(out.el || out);
  cleanup = out.cleanup || null;
  window.scrollTo(0, 0);
}

function renderHome() {
  const d = state.dataset;
  const rows = d ? d.sheets.reduce((n, s) => n + s.rows.length, 0) : 0;
  return h('div', { class: 'home' },
    h('button', { type: 'button', class: 'table-banner', onclick: () => go('table') },
      h('span', { class: 'icon' }, '▦'),
      h('span', { class: 'grow' },
        h('strong', {}, 'Data Table'),
        h('span', { class: 'muted small block' }, d ? `${plural(rows, 'row')} · ${d.title || d.source}` : 'Results from every tool land here')),
      h('span', { class: 'chev' }, '›')),
    h('div', { class: 'tool-grid' }, TOOLS.map((t) =>
      h('button', { type: 'button', class: 'tool-card', onclick: () => go(t.id), dataset: { tool: t.id } },
        h('span', { class: 'icon' }, t.icon),
        h('strong', {}, t.title),
        h('span', { class: 'muted small' }, t.desc)))),
    h('div', { class: 'home-links' },
      ['recipes', 'history', 'settings'].map((id) => h('button', { type: 'button', class: 'btn secondary', onclick: () => go(id) }, `${VIEWS[id].icon} ${VIEWS[id].title}`))));
}

async function updateHost() {
  try {
    const tab = await getActiveTab();
    $('#host').textContent = tab.url ? new URL(tab.url).host || tab.url : '';
  } catch { $('#host').textContent = ''; }
}

// ---------- init ----------
$('#back').addEventListener('click', () => go('home'));
$('#job-stop').addEventListener('click', stopJob);
chrome.tabs.onActivated.addListener(updateHost);
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (tab.active && info.url) updateHost(); });
onChange(() => { if (currentId === 'home') go('home'); });

// Results written by Claude (via the MCP connector) appear live.
chrome.storage.onChanged.addListener((changes, area) => {
  const d = area === 'local' && changes.dataset?.newValue;
  if (!d || d.updatedBy !== 'claude' || d.updatedAt === state.dataset?.updatedAt) return;
  state.dataset = d;
  for (const fn of state.listeners) fn();
  if (currentId === 'table') go('table');
  toast(`Claude added results: ${d.title}`, 'ok');
});

settings = await getSettings();
await loadDataset();
updateHost();
go('home');
