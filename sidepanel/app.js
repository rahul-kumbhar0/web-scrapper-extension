import { h, $, fill, toast, stopJob, plural } from './ui.js';
import './picker.js';
import { state, loadDataset, onChange } from './state.js';
import { getSettings, saveRecipe, getRecipes } from '../lib/storage.js';
import { getActiveTab, navigate } from '../lib/tab.js';
import { icon, TOOL_ICONS } from './icons.js';
import { plan, loadPlan, bindNavigation, upsell } from './plan.js';

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
import upgradeView from './views/upgrade.js';

export const TOOLS = [listTool, pageTool, emailTool, socialTool, imagesTool, shopifyTool, sitemapTool, textTool, quickTool, aiTool];
const GROUPS = [
  { label: 'On this page', ids: ['list', 'quick', 'images', 'text'] },
  { label: 'Across many pages', ids: ['page', 'email', 'social', 'sitemap', 'shopify'] },
  { label: 'AI', ids: ['ai'] },
];
const VIEWS = { table: tableView, recipes: recipesView, history: historyView, settings: settingsView, upgrade: upgradeView };
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
    if ((await getRecipes()).length >= plan.limits.recipes) {
      upsell(`The free plan keeps ${plan.limits.recipes} saved recipes. Delete one, or upgrade for unlimited recipes.`);
      return;
    }
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
bindNavigation((id) => go(id));

export function go(id, opts = {}) {
  cleanup?.();
  cleanup = null;
  currentId = id;
  const view = $('#view');
  view.replaceChildren();
  // Replay the entrance animation on every navigation.
  view.style.animation = 'none';
  void view.offsetHeight;
  view.style.animation = '';
  $('#back').hidden = id === 'home';
  $('#title').textContent = id === 'home' ? 'PullRows' : ALL[id].title;
  document.body.dataset.view = id;
  if (id === 'home') { view.append(renderHome()); return; }
  const tool = ALL[id];
  const out = tool.render({ ...ctx, ...opts, tool });
  view.append(out.el || out);
  cleanup = out.cleanup || null;
  window.scrollTo(0, 0);
}

let pageInfo = { host: '', title: '', url: '' };

function renderHome() {
  const d = state.dataset;
  const rows = d ? d.sheets.reduce((n, s) => n + s.rows.length, 0) : 0;
  const scrapable = /^https?:/i.test(pageInfo.url);
  const toolCard = (t) => h('button', { type: 'button', class: 'tool-card', onclick: () => go(t.id), dataset: { tool: t.id } },
    h('span', { class: 'icon' }, icon(TOOL_ICONS[t.id] || 'list', { size: 17 })),
    h('strong', {}, t.title),
    h('span', { class: 'muted small' }, t.desc));
  const mcpOn = settings.mcp?.enabled && settings.mcp?.consentAt;

  return h('div', { class: 'home' },
    h('section', { class: 'hero' },
      h('div', { class: 'hero-top' },
        h('span', { class: 'site-dot' }, (pageInfo.host || '?').replace(/^www\./, '').slice(0, 1)),
        h('div', { class: 'grow' },
          h('div', { class: 'site-host' }, scrapable ? pageInfo.host.replace(/^www\./, '') : 'Open any website'),
          h('div', { class: 'site-title' }, scrapable ? pageInfo.title || pageInfo.url : 'then pull its lists, contacts and text into rows'))),
      h('div', { class: 'hero-actions' },
        h('button', { type: 'button', class: 'btn on-dark', disabled: !scrapable, onclick: () => go('list', { autoDetect: true }) }, icon('scan', { size: 15 }), 'Auto-detect list'),
        h('button', { type: 'button', class: 'btn on-dark-ghost', disabled: !scrapable, onclick: () => go('quick') }, icon('bolt', { size: 15 }), 'Quick scan')),
      h('div', { class: 'hero-note' }, scrapable ? 'Or click one item on the page with List Extractor — every similar item becomes a row.' : 'Chrome pages and the Web Store can’t be scraped.')),
    h('button', { type: 'button', class: 'table-banner', onclick: () => go('table') },
      h('span', { class: 'icon' }, icon('table', { size: 18 })),
      h('span', { class: 'grow' },
        h('strong', {}, 'Data Table'),
        h('span', { class: 'muted small block ellipsis' }, d ? `${d.title || d.source}` : 'Results from every tool land here')),
      d ? h('span', { class: 'count-pill' }, plural(rows, 'row')) : null,
      h('span', { class: 'chev' }, icon('chevron', { size: 16 }))),
    GROUPS.map((g) => [
      h('div', { class: 'section-label' }, g.label),
      h('div', { class: 'tool-grid' }, g.ids.map((id) => toolCard(ALL[id]))),
    ]),
    h('button', { type: 'button', class: 'connector-card', onclick: () => go('settings') },
      h('span', { class: 'icon' }, icon('plug', { size: 18 })),
      h('span', { class: 'grow' },
        h('strong', {}, 'Claude connector'),
        h('span', { class: 'muted small block' }, h('span', { class: `status-dot ${mcpOn ? 'on' : ''}` }), mcpOn ? 'On — Claude can run these tools for you' : 'Let Claude drive PullRows in this browser')),
      h('span', { class: 'chev muted' }, icon('chevron', { size: 16 }))),
    plan.pro ? null : h('div', { class: 'upsell' },
      h('span', { class: 'icon' }, icon('crown', { size: 18 })),
      h('span', { class: 'grow small' }, h('strong', {}, 'PullRows Pro'), h('span', { class: 'muted block' }, 'No limits, Excel & JSON export, unlimited Claude calls.')),
      h('button', { type: 'button', class: 'btn tiny primary', onclick: () => go('upgrade') }, 'Upgrade')),
    h('div', { class: 'home-links' },
      ['recipes', 'history', 'settings'].map((id) => h('button', { type: 'button', class: 'btn secondary', onclick: () => go(id) }, icon(TOOL_ICONS[id], { size: 15 }), VIEWS[id].title))));
}

function renderBadge() {
  const b = $('#plan-badge');
  b.hidden = false;
  b.className = `plan-badge ${plan.pro ? 'pro' : ''}`;
  fill(b, plan.pro ? icon('crown', { size: 12 }) : null, plan.pro ? 'Pro' : 'Free');
  b.title = plan.pro ? 'PullRows Pro — manage your plan' : 'Free plan — see what Pro adds';
}

async function updateHost() {
  try {
    const tab = await getActiveTab();
    let host = '';
    try { host = new URL(tab.url).host; } catch { /* chrome:// etc */ }
    pageInfo = { host, title: tab.title || '', url: tab.url || '' };
    $('#host').textContent = host || tab.url || '';
  } catch {
    pageInfo = { host: '', title: '', url: '' };
    $('#host').textContent = '';
  }
  if (currentId === 'home') go('home');
}

// ---------- init ----------
$('#back').append(icon('back', { size: 18 }));
$('#back').addEventListener('click', () => go('home'));
$('#job-stop').addEventListener('click', stopJob);
$('#plan-badge').addEventListener('click', () => go('upgrade'));
chrome.tabs.onActivated.addListener(updateHost);
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (tab.active && (info.url || info.title || info.status === 'complete')) updateHost(); });
onChange(() => { if (currentId === 'home') go('home'); });
plan.listeners.add(() => { renderBadge(); if (currentId === 'home') go('home'); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) ctx.reloadSettings().then(() => { if (currentId === 'home') go('home'); });
  // Results written by Claude (via the MCP connector) appear live.
  const d = changes.dataset?.newValue;
  if (!d || d.updatedBy !== 'claude' || d.updatedAt === state.dataset?.updatedAt) return;
  state.dataset = d;
  for (const fn of state.listeners) fn();
  if (currentId === 'table') go('table');
  toast(`Claude added results: ${d.title}`, 'ok');
});

settings = await getSettings();
await Promise.all([loadDataset(), loadPlan()]);
renderBadge();
go('home');
updateHost();
const { whatsNew } = await chrome.storage.local.get('whatsNew');
if (whatsNew) {
  toast(`PullRows updated to v${whatsNew}. See what’s new in Settings → About.`, 'ok');
  chrome.storage.local.remove('whatsNew');
}
