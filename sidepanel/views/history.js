// HISTORY — the last 30 results, re-openable into the Data Table.
import { h, fill, confirmDialog, plural, toast } from '../ui.js';
import { state, makeSheet, changed } from '../state.js';
import { getHistory, getHistoryRows, deleteHistory, clearHistory } from '../../lib/storage.js';

export default {
  id: 'history',
  title: 'History',
  icon: '⟲',
  render(ctx) {
    const list = h('ul', { class: 'item-list' });

    async function render() {
      const items = await getHistory();
      if (!items.length) { fill(list, h('li', { class: 'empty' }, 'Nothing yet.')); return; }
      fill(list, ...items.map((item) => {
        // Rows live under their own storage key and are only read when the entry is opened.
        const counts = (item.sheets || []).map((s) => `${s.name}: ${s.rows}`).join(' · ');
        return h('li', {},
          h('div', { class: 'title', title: item.title }, item.title || item.url),
          h('div', { class: 'meta' }, `${new Date(item.at).toLocaleString()} · ${item.source || ''}`),
          h('div', { class: 'meta' }, counts),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'link-btn', onclick: async (e) => {
              e.target.disabled = true;
              const results = await getHistoryRows(item.id);
              e.target.disabled = false;
              const sheets = Object.entries(results).map(([name, rows]) => makeSheet(name, rows));
              if (!sheets.length) { toast('That result is no longer stored.', 'error'); return; }
              state.dataset = { title: item.title, url: item.url, source: item.source, sheets, active: Math.max(0, sheets.findIndex((s) => s.rows.length)) };
              changed();
              ctx.go('table');
            } }, 'Open'),
            h('button', { type: 'button', class: 'link-btn danger', onclick: async () => { await deleteHistory(item.id); render(); } }, 'Delete')));
      }));
    }

    render();
    return h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('p', { class: 'hint grow' }, `Last ${plural(30, 'result')} are kept on this device.`),
        h('button', { type: 'button', class: 'btn tiny', onclick: async () => { if (await confirmDialog('Delete all history?', '', 'Delete all')) { await clearHistory(); render(); } } }, 'Clear all')),
      list);
  },
};
