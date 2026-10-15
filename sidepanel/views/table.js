// DATA TABLE — the shared, editable workspace every tool writes into.
import { h, fill, toast, runJob, plural, formDialog, confirmDialog, menu, markdown } from '../ui.js';
import { state, activeSheet, changed, columnsOf, isUrl, urlColumns, onChange } from '../state.js';
import { toCSV, toTSV, toJSON, toXLSX, download, fileStem } from '../../lib/export.js';
import { exportToSheets, sheetsConfigured } from '../../lib/sheets.js';
import { aiColumn, aiAsk } from '../../lib/ai.js';
import { downloadImages } from '../tools/images.js';

const PAGE_SIZE = 200;
const SEND_TARGETS = [['page', 'Page Extractor'], ['email', 'Email Extractor'], ['social', 'Social Link Extractor'], ['text', 'Page Text Extractor'], ['ai', 'AI Extract']];

export default {
  id: 'table',
  title: 'Data Table',
  icon: '▦',
  render(ctx) {
    let page = 0;
    let sortState = null;
    const filter = h('input', { type: 'search', placeholder: 'Search rows…', oninput: () => { page = 0; renderTable(); } });
    const tabs = h('div', { class: 'sheet-tabs' });
    const tableWrap = h('div', { class: 'table-wrap big' });
    const pager = h('div', { class: 'row pager' });
    const answer = h('div', { class: 'answer', hidden: true });
    const head = h('div', { class: 'table-head' });

    const sheet = () => activeSheet();
    const rowsView = () => {
      const s = sheet();
      if (!s) return [];
      const q = filter.value.trim().toLowerCase();
      const idx = s.rows.map((_, i) => i);
      return q ? idx.filter((i) => s.cols.some((c) => String(s.rows[i][c] ?? '').toLowerCase().includes(q))) : idx;
    };

    function renderHead() {
      const d = state.dataset;
      fill(head, d
        ? h('div', {}, h('strong', {}, d.title || 'Results'), h('div', { class: 'muted small ellipsis' }, `${d.source || ''}${d.url ? ' · ' + d.url : ''}`))
        : h('p', { class: 'hint' }, 'No data yet. Run any tool and the results appear here.'));
      if (!d) { fill(tabs); return; }
      fill(tabs, ...d.sheets.map((s, i) => h('button', {
        type: 'button', class: `sheet-tab ${i === d.active ? 'on' : ''}`,
        onclick: () => { d.active = i; page = 0; sortState = null; renderAll(); },
        oncontextmenu: (e) => { e.preventDefault(); sheetMenu(e.currentTarget, i); },
      }, s.name, h('span', { class: 'count' }, s.rows.length))));
    }

    function sheetMenu(anchor, i) {
      const d = state.dataset;
      menu(anchor, [
        { label: 'Rename sheet', run: async () => { const r = await formDialog({ title: 'Rename sheet', fields: [{ name: 'n', label: 'Name', value: d.sheets[i].name }] }); if (r?.n) { d.sheets[i].name = r.n; changed(); renderAll(); } } },
        d.sheets.length > 1 && { label: 'Delete sheet', danger: true, run: () => { d.sheets.splice(i, 1); d.active = 0; changed(); renderAll(); } },
      ]);
    }

    function colMenu(anchor, col) {
      const s = sheet();
      const i = s.cols.indexOf(col);
      const urlish = s.rows.slice(0, 50).some((r) => isUrl(r[col]));
      menu(anchor, [
        { label: 'Rename…', run: () => renameCol(col) },
        { label: 'Sort A → Z', run: () => sortBy(col, 1) },
        { label: 'Sort Z → A', run: () => sortBy(col, -1) },
        { label: 'Move left', disabled: i === 0, run: () => { s.cols.splice(i - 1, 0, s.cols.splice(i, 1)[0]); commit(); } },
        { label: 'Move right', disabled: i === s.cols.length - 1, run: () => { s.cols.splice(i + 1, 0, s.cols.splice(i, 1)[0]); commit(); } },
        { label: 'Remove duplicates by this column', run: () => dedupe([col]) },
        urlish && '-',
        ...(urlish ? SEND_TARGETS.map(([id, label]) => ({ label: `Send URLs → ${label}`, run: () => sendUrls(col, id) })) : []),
        urlish && { label: 'Download as images', run: () => downloadCol(col) },
        '-',
        { label: 'Delete column', danger: true, run: () => { s.cols.splice(i, 1); s.rows.forEach((r) => delete r[col]); commit(); } },
      ]);
    }

    function renderTable() {
      const s = sheet();
      if (!s) { fill(tableWrap); fill(pager); return; }
      const idx = rowsView();
      const pages = Math.max(1, Math.ceil(idx.length / PAGE_SIZE));
      page = Math.min(page, pages - 1);
      const shown = idx.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const table = h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', { class: 'rownum' }, '#'),
          s.cols.map((c) => h('th', { title: 'Click for column options', onclick: (e) => colMenu(e.currentTarget, c) },
            c, sortState?.col === c ? (sortState.dir > 0 ? ' ▲' : ' ▼') : '')))),
        h('tbody', {}, shown.length ? shown.map((ri) => h('tr', { dataset: { row: ri } },
          h('td', { class: 'rownum' }, h('span', {}, ri + 1), h('button', { type: 'button', class: 'row-del', title: 'Delete row', onclick: () => { s.rows.splice(ri, 1); commit(); } }, '×')),
          s.cols.map((c) => cell(s, ri, c))))
          : h('tr', {}, h('td', { class: 'empty', colSpan: s.cols.length + 1 }, filter.value ? 'No matching rows.' : 'No rows.'))));
      fill(tableWrap, table);
      fill(pager, 
        h('span', { class: 'muted small grow' }, `${plural(idx.length, 'row')}${idx.length !== s.rows.length ? ` (of ${s.rows.length})` : ''} · ${plural(s.cols.length, 'column')} · double-click a cell to edit`),
        pages > 1 ? h('button', { type: 'button', class: 'btn tiny', disabled: page === 0, onclick: () => { page--; renderTable(); } }, '‹') : null,
        pages > 1 ? h('span', { class: 'small' }, `${page + 1}/${pages}`) : null,
        pages > 1 ? h('button', { type: 'button', class: 'btn tiny', disabled: page >= pages - 1, onclick: () => { page++; renderTable(); } }, '›') : null);
    }

    function cell(s, ri, c) {
      const v = String(s.rows[ri][c] ?? '');
      const td = h('td', { title: v.length > 80 ? v.slice(0, 500) : '' });
      if (isUrl(v) && /\.(jpe?g|png|webp|gif|avif|svg)(\?|$)/i.test(v)) td.append(h('img', { src: v, alt: '', loading: 'lazy', class: 'thumb', referrerPolicy: 'no-referrer' }));
      else if (isUrl(v)) td.append(h('a', { href: v, target: '_blank', rel: 'noreferrer' }, v));
      else td.append(v.length > 300 ? v.slice(0, 300) + '…' : v);
      td.addEventListener('dblclick', () => {
        fill(td, v);
        td.contentEditable = 'true';
        td.classList.add('editing');
        td.focus();
        const done = (save) => {
          td.contentEditable = 'false';
          td.classList.remove('editing');
          if (save) { s.rows[ri][c] = td.textContent; changed(); }
          td.replaceWith(cell(s, ri, c));
        };
        td.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(true); }
          if (e.key === 'Escape') done(false);
        });
        td.addEventListener('blur', () => done(true), { once: true });
      });
      return td;
    }

    const commit = () => { changed(); renderAll(); };

    async function renameCol(col) {
      const r = await formDialog({ title: 'Rename column', fields: [{ name: 'n', label: 'Name', value: col }] });
      const n = r?.n?.trim();
      if (!n || n === col) return;
      const s = sheet();
      if (s.cols.includes(n)) { toast('A column with that name exists.', 'error'); return; }
      s.cols[s.cols.indexOf(col)] = n;
      for (const row of s.rows) { row[n] = row[col]; delete row[col]; }
      commit();
    }

    function sortBy(col, dir) {
      const s = sheet();
      const num = (v) => { const n = parseFloat(String(v).replace(/[^\d.-]/g, '')); return Number.isNaN(n) ? null : n; };
      const numeric = s.rows.slice(0, 50).every((r) => r[col] === '' || r[col] == null || num(r[col]) !== null);
      s.rows.sort((a, b) => {
        const x = a[col] ?? '';
        const y = b[col] ?? '';
        if (x === '' && y !== '') return 1;
        if (y === '' && x !== '') return -1;
        return dir * (numeric ? (num(x) ?? 0) - (num(y) ?? 0) : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }));
      });
      sortState = { col, dir };
      commit();
    }

    function dedupe(cols) {
      const s = sheet();
      const keys = cols || s.cols;
      const seen = new Set();
      const before = s.rows.length;
      s.rows = s.rows.filter((r) => { const k = keys.map((c) => String(r[c] ?? '').trim().toLowerCase()).join('\u0001'); if (seen.has(k)) return false; seen.add(k); return true; });
      commit();
      toast(`Removed ${plural(before - s.rows.length, 'duplicate')}.`, 'ok');
    }

    function clean() {
      const s = sheet();
      const before = s.rows.length;
      const colsBefore = s.cols.length;
      for (const r of s.rows) for (const c of s.cols) if (typeof r[c] === 'string') r[c] = r[c].trim();
      s.rows = s.rows.filter((r) => s.cols.some((c) => String(r[c] ?? '').trim()));
      const filled = (c) => s.rows.filter((r) => String(r[c] ?? '').trim()).length;
      s.cols = s.cols.filter((c) => filled(c) >= Math.max(1, s.rows.length * 0.05));
      commit();
      toast(`Removed ${plural(before - s.rows.length, 'empty row')} and ${plural(colsBefore - s.cols.length, 'mostly-blank column')}.`, 'ok');
    }

    async function merge() {
      const s = sheet();
      const r = await formDialog({
        title: 'Merge columns',
        text: 'Join several columns into one (e.g. street + city + postcode → address).',
        fields: [
          { name: 'cols', label: 'Columns', type: 'multiselect', options: s.cols.map((c) => ({ value: c, label: c })), value: [] },
          { name: 'sep', label: 'Separator', value: ', ' },
          { name: 'name', label: 'New column name', value: 'merged' },
          { name: 'drop', label: 'Remove the original columns', type: 'checkbox', value: false },
        ],
        submit: 'Merge',
      });
      if (!r || r.cols.length < 2) return;
      const ordered = s.cols.filter((c) => r.cols.includes(c));
      let name = r.name.trim() || 'merged';
      while (s.cols.includes(name) && !r.cols.includes(name)) name += '_';
      for (const row of s.rows) row[name] = ordered.map((c) => String(row[c] ?? '').trim()).filter(Boolean).join(r.sep);
      if (r.drop) { s.cols = s.cols.filter((c) => !r.cols.includes(c)); s.rows.forEach((row) => r.cols.forEach((c) => { if (c !== name) delete row[c]; })); }
      if (!s.cols.includes(name)) s.cols.splice(Math.min(...ordered.map((c) => s.cols.indexOf(c)).filter((x) => x >= 0), s.cols.length), 0, name);
      commit();
    }

    async function addAiColumn() {
      if (!ctx.settings.apiKey) { toast('Add your Anthropic API key in Settings first.', 'error'); ctx.go('settings'); return; }
      const s = sheet();
      const r = await formDialog({
        title: '✦ AI column',
        text: 'Claude reads each row and fills a new column. Examples: “Classify the company’s industry”, “Summarise the description in 10 words”, “Is this a B2B company? yes/no”, “Extract the city from the address”.',
        fields: [
          { name: 'instruction', label: 'Instruction', type: 'textarea', placeholder: 'What should the new column contain?' },
          { name: 'name', label: 'Column name', value: 'ai' },
          { name: 'cols', label: 'Columns Claude can read', type: 'multiselect', options: s.cols.map((c) => ({ value: c, label: c })), value: s.cols.slice(0, 8) },
          { name: 'onlyVisible', label: `Only rows matching the search (${rowsView().length})`, type: 'checkbox', value: !!filter.value },
        ],
        submit: 'Run on rows',
      });
      if (!r?.instruction?.trim()) return;
      const idx = r.onlyVisible ? rowsView() : s.rows.map((_, i) => i);
      let name = r.name.trim() || 'ai';
      while (s.cols.includes(name)) name += '_';
      await runJob(`Claude is filling “${name}”…`, async (signal, progress) => {
        const { values, tokens } = await aiColumn({
          apiKey: ctx.settings.apiKey, model: ctx.settings.model, instruction: r.instruction,
          rows: idx.map((i) => s.rows[i]), columns: r.cols.length ? r.cols : s.cols, signal,
          onProgress: (d, t) => progress(`${d} / ${t} rows`, d, t),
        });
        s.cols.push(name);
        idx.forEach((ri, k) => { s.rows[ri][name] = values[k] ?? ''; });
        commit();
        toast(`Filled ${plural(idx.length, 'row')} · ${tokens.toLocaleString()} tokens.`, 'ok');
      });
    }

    async function ask() {
      if (!ctx.settings.apiKey) { toast('Add your Anthropic API key in Settings first.', 'error'); ctx.go('settings'); return; }
      const r = await formDialog({
        title: '✦ Ask Claude about this data',
        fields: [{ name: 'q', label: 'Question', type: 'textarea', placeholder: 'e.g. Which 5 products have the best rating for the price? Summarise the main trends.' }],
        submit: 'Ask',
      });
      if (!r?.q?.trim()) return;
      const s = sheet();
      await runJob('Claude is analysing the table…', async (signal) => {
        const idx = rowsView();
        const res = await aiAsk({ apiKey: ctx.settings.apiKey, model: ctx.settings.model, question: r.q, rows: idx.map((i) => s.rows[i]), columns: s.cols, signal });
        answer.hidden = false;
        fill(answer, 
          h('div', { class: 'row' }, h('strong', { class: 'grow' }, `✦ ${r.q}`),
            h('button', { type: 'button', class: 'btn tiny', onclick: () => navigator.clipboard.writeText(res.answer).then(() => toast('Copied.', 'ok')) }, 'Copy'),
            h('button', { type: 'button', class: 'icon-btn', onclick: () => { answer.hidden = true; } }, '×')),
          markdown(res.answer));
      });
    }

    function sendUrls(col, toolId) {
      const s = sheet();
      const urls = [...new Set(rowsView().map((i) => String(s.rows[i][col] || '').trim()).filter(isUrl))];
      state.pendingUrls = urls;
      ctx.go(toolId);
      toast(`Sent ${plural(urls.length, 'URL')}.`, 'ok');
    }

    async function downloadCol(col) {
      const s = sheet();
      const imgs = rowsView().map((i) => ({ src: String(s.rows[i][col] || '').trim(), alt: '' })).filter((x) => isUrl(x.src));
      await runJob(`Downloading ${plural(imgs.length, 'image')}…`, async (signal, progress) => {
        const n = await downloadImages(imgs, 'web-scraper/table-images', { signal, progress });
        toast(`Saved ${plural(n, 'file')}.`, 'ok');
      });
    }

    async function exportAs(kind) {
      const d = state.dataset;
      const s = sheet();
      if (!s) return;
      const stem = fileStem(d.title);
      const visible = rowsView().map((i) => Object.fromEntries(s.cols.map((c) => [c, s.rows[i][c] ?? ''])));
      const sheets = d.sheets.filter((x) => x.rows.length).map((x) => ({ name: x.name, rows: x.rows.map((r) => Object.fromEntries(x.cols.map((c) => [c, r[c] ?? '']))) }));
      try {
        if (kind === 'csv') download(toCSV(visible), `${stem}-${s.name}.csv`, 'text/csv;charset=utf-8');
        if (kind === 'copy') { await navigator.clipboard.writeText(toTSV(visible)); toast(`Copied ${plural(visible.length, 'row')} — paste into any spreadsheet.`, 'ok'); }
        if (kind === 'xlsx') download(toXLSX(sheets), `${stem}.xlsx`);
        if (kind === 'json') download(toJSON({ title: d.title, url: d.url, source: d.source, exportedAt: new Date().toISOString(), sheets: Object.fromEntries(sheets.map((x) => [x.name, x.rows])) }), `${stem}.json`, 'application/json');
        if (kind === 'sheets') {
          await runJob('Creating Google Sheet…', async () => {
            const url = await exportToSheets(`${d.title || 'Scrape'} — ${new Date().toLocaleString()}`, sheets);
            chrome.tabs.create({ url });
            toast('Google Sheet created.', 'ok');
          });
        }
      } catch (e) { toast(e.message, 'error'); }
    }

    function renderAll() { renderHead(); renderTable(); }

    const hasData = () => !!state.dataset;
    const toolbar = h('div', { class: 'toolbar' },
      h('button', { type: 'button', class: 'btn tiny', onclick: () => hasData() && dedupe() }, 'Dedupe'),
      h('button', { type: 'button', class: 'btn tiny', onclick: () => hasData() && clean() }, 'Clean'),
      h('button', { type: 'button', class: 'btn tiny', onclick: () => hasData() && merge() }, 'Merge cols'),
      h('button', { type: 'button', class: 'btn tiny ai', onclick: () => hasData() && addAiColumn() }, '✦ AI column'),
      h('button', { type: 'button', class: 'btn tiny ai', onclick: () => hasData() && ask() }, '✦ Ask Claude'),
      h('button', { type: 'button', class: 'btn tiny', onclick: (e) => {
        const s = sheet();
        const cols = urlColumns(s);
        if (!cols.length) { toast('No URL column to send.', 'error'); return; }
        menu(e.currentTarget, cols.flatMap((c) => SEND_TARGETS.map(([id, label]) => ({ label: `${c} → ${label}`, run: () => sendUrls(c, id) }))));
      } }, 'Send URLs ▾'),
      h('button', { type: 'button', class: 'btn tiny', onclick: async () => {
        if (hasData() && await confirmDialog('Clear the Data Table?', 'It stays available in History.', 'Clear')) { state.dataset = null; changed(); renderAll(); }
      } }, 'Clear'));

    const exportBar = h('div', { class: 'export' },
      h('span', { class: 'muted small' }, 'Export:'),
      h('button', { type: 'button', class: 'btn secondary', onclick: () => exportAs('csv') }, 'CSV'),
      h('button', { type: 'button', class: 'btn secondary', onclick: () => exportAs('xlsx') }, 'Excel'),
      h('button', { type: 'button', class: 'btn secondary', onclick: () => exportAs('json') }, 'JSON'),
      h('button', { type: 'button', class: 'btn secondary', onclick: () => exportAs('copy') }, 'Copy'),
      h('button', { type: 'button', class: 'btn secondary', title: sheetsConfigured() ? '' : 'Needs a Google OAuth client ID — see README', onclick: () => exportAs('sheets') }, 'Google Sheets'));

    renderAll();
    const off = onChange(() => {}); // table re-renders itself on edits; keep hook for future live updates
    return {
      el: h('div', { class: 'stack' }, head, tabs, h('div', { class: 'row' }, filter), toolbar, answer, tableWrap, pager, exportBar),
      cleanup: off,
    };
  },
};

export { columnsOf };
