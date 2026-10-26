// MONITORS — saved recipes re-run on a schedule in the background. Each run is compared with the
// last one: new rows, rows that are gone, changed values and price drops, with a Chrome alert.
import { h, fill, toast, confirmDialog, formDialog, plural } from '../ui.js';
import { state, makeSheet, changed } from '../state.js';
import { getRecipes } from '../../lib/storage.js';
import { getMonitors, EVERY, ALERTS } from '../../lib/monitor.js';
import { plan, upsell } from '../plan.js';

// Tools a monitor can re-run without the user's tab (the same set Claude's recipe_run supports).
export const MONITORABLE = new Set(['list', 'page', 'email', 'social', 'shopify', 'sitemap', 'quick', 'text']);

export function ask(type, extra = {}) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage({ type, ...extra }, (res) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (res?.err) return reject(new Error(res.err));
    resolve(res?.ok);
  }));
}

const everyLabel = (m) => EVERY.find((e) => e.minutes === m)?.label || `Every ${plural(Math.round(m / 60), 'hour')}`;
const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

/** Dialog: schedule a monitor for a recipe (also used from the Recipes view). */
export async function monitorDialog(recipe, existing = null) {
  if (!MONITORABLE.has(recipe.tool)) { toast('This kind of recipe can’t run on a schedule yet (it needs you on the page).', 'error'); return null; }
  if (['list', 'quick'].includes(recipe.tool) && !recipe.url) { toast('Edit the recipe and add a start page first — the monitor opens it in the background.', 'error'); return null; }
  const list = await getMonitors();
  if (!existing && list.length >= plan.limits.monitors) {
    upsell(`The free plan includes ${plan.limits.monitors} monitor. Pro monitors as many recipes as you like, as often as every hour.`);
    return null;
  }
  const res = await formDialog({
    title: existing ? 'Edit monitor' : 'Monitor this recipe',
    text: `PullRows re-runs “${recipe.name}” in the background (Chrome must be open) and tells you what changed since the last run.`,
    fields: [
      { name: 'every', label: 'How often', type: 'select', value: String(existing?.everyMinutes || 1440), options: EVERY.map((e) => ({ value: String(e.minutes), label: `${e.label}${e.minutes < 1440 && !plan.pro ? ' (Pro)' : ''}` })) },
      { name: 'alertOn', label: 'Alert me on', type: 'select', value: existing?.alertOn || 'any', options: Object.entries(ALERTS).map(([value, label]) => ({ value, label })) },
      { name: 'sheet', label: `Also add the changes to my Google Sheet${plan.pro ? '' : ' (Pro)'} — set it up in Settings`, type: 'checkbox', value: !!existing?.pushToSheet },
    ],
    submit: existing ? 'Save' : 'Start monitoring',
  });
  if (!res) return null;
  const every = Number(res.every);
  if (every < 1440 && !plan.pro) { upsell('Monitors that run more than once a day are part of PullRows Pro.'); return null; }
  if (res.sheet && !plan.pro) { upsell('Auto-sync to Google Sheets is part of PullRows Pro.'); return null; }
  try {
    if (existing) {
      await ask('monitor:update', { id: existing.id, patch: { everyMinutes: every, alertOn: res.alertOn, pushToSheet: res.sheet } });
      toast('Monitor updated.', 'ok');
    } else {
      await ask('monitor:create', { recipeId: recipe.id, everyMinutes: every, alertOn: res.alertOn });
      if (res.sheet) { const m = (await getMonitors()).find((x) => x.recipeId === recipe.id); if (m) await ask('monitor:update', { id: m.id, patch: { pushToSheet: true } }); }
      toast('Monitoring started — the first run (the baseline) is happening now in the background.', 'ok');
    }
    return true;
  } catch (e) { toast(e.message, 'error'); return null; }
}

export default {
  id: 'monitors',
  title: 'Monitors',
  icon: '🔔',
  render(ctx) {
    const list = h('ul', { class: 'item-list' });
    ask('monitor:seen').catch(() => {});

    const openRun = (m) => {
      const rows = m.lastRows || [];
      const sheets = [makeSheet('Rows', rows), makeSheet('Runs', (m.runs || []).map((r) => ({ when: new Date(r.at).toLocaleString(), ok: r.ok ? 'yes' : 'no', rows: r.rows, summary: r.summary })), ['when', 'ok', 'rows', 'summary'])];
      state.dataset = { title: `Monitor · ${m.name}`, url: '', source: 'Monitor', sheets, active: 0 };
      changed();
      ctx.go('table');
    };

    async function render() {
      const [mons, recipes] = await Promise.all([getMonitors(), getRecipes()]);
      if (!mons.length) {
        const usable = recipes.filter((r) => MONITORABLE.has(r.tool));
        fill(list, h('li', { class: 'empty' },
          h('p', {}, 'Watch a page for changes: new listings, price drops, new jobs, new leads.'),
          h('p', { class: 'muted small' }, usable.length ? 'Pick a saved recipe to monitor:' : 'First set up a tool (e.g. List Extractor on a product or job page) and click “Save recipe”. Then monitor it here.'),
          usable.length ? h('div', { class: 'row wrap' }, usable.map((r) => h('button', { type: 'button', class: 'btn tiny', onclick: async () => { if (await monitorDialog(r)) render(); } }, r.name))) : null));
        return;
      }
      fill(list, ...mons.map((m) => h('li', { class: m.unseen ? 'highlight' : '' },
        h('div', { class: 'title' }, m.paused ? '⏸ ' : '', m.name),
        h('div', { class: 'meta' }, `${everyLabel(m.everyMinutes)} · alerts: ${(ALERTS[m.alertOn] || ALERTS.any).split(' (')[0].toLowerCase()}${m.pushToSheet ? ' · → Google Sheet' : ''}`),
        h('div', { class: `meta wrap ${m.lastOk === false ? 'danger' : ''}` }, `Last run ${ago(m.lastRunAt)}${m.lastSummary ? ` — ${m.lastSummary}` : ''}`),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn tiny primary', onclick: async (e) => {
            e.target.disabled = true; e.target.textContent = 'Running…';
            try { await ask('monitor:run', { id: m.id }); toast('Run finished.', 'ok'); } catch (err) { toast(err.message, 'error'); }
            render();
          } }, '▶ Run now'),
          m.lastRows ? h('button', { type: 'button', class: 'link-btn', onclick: () => openRun(m) }, 'Open rows') : null,
          h('button', { type: 'button', class: 'link-btn', onclick: () => ctx.go('history') }, 'Changes'),
          h('button', { type: 'button', class: 'link-btn', onclick: async () => {
            const r = recipes.find((x) => x.id === m.recipeId);
            if (!r) { toast('The recipe was deleted — delete this monitor too.', 'error'); return; }
            if (await monitorDialog(r, m)) render();
          } }, 'Edit'),
          h('button', { type: 'button', class: 'link-btn', onclick: async () => { await ask('monitor:pause', { id: m.id, paused: !m.paused }); render(); } }, m.paused ? 'Resume' : 'Pause'),
          h('button', { type: 'button', class: 'link-btn danger', onclick: async () => { if (await confirmDialog('Delete monitor?', m.name)) { await ask('monitor:delete', { id: m.id }); render(); } } }, 'Delete')))));
    }

    const onStore = (c, area) => { if (area === 'local' && c.monitors) render(); };
    chrome.storage.onChanged.addListener(onStore);
    render();
    const el = h('div', { class: 'stack' },
      h('p', { class: 'hint' }, `Monitors re-run a saved recipe in the background while Chrome is open and alert you when something changes. Each run’s rows and changes are saved in History.${plan.pro ? '' : ` Free plan: ${plan.limits.monitors} monitor, daily. Pro: unlimited, hourly.`}`),
      list);
    return { el, cleanup: () => chrome.storage.onChanged.removeListener(onStore) };
  },
};
