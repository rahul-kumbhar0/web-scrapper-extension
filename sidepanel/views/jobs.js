// SCANS — long jobs Claude started that outlive a single tool call (an account scan can run for
// many minutes). Without this view the work would be invisible: the user would see tabs scrolling
// and no explanation.
import { h, fill, toast, confirmDialog, plural } from '../ui.js';
import { state, makeSheet, changed } from '../state.js';
import { listJobs, getJob, cancelJob, deleteJob } from '../../lib/jobs.js';

const ago = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)}h ago`;
};

const STATUS = {
  running: ['Running', ''],
  done: ['Finished', 'ok'],
  error: ['Failed', 'error'],
  cancelled: ['Cancelled', ''],
  stalled: ['Stopped', 'error'],
};

export default {
  id: 'jobs',
  title: 'Scans',
  icon: '⏱',
  render(ctx) {
    const list = h('ul', { class: 'item-list' });

    const open = async (id) => {
      const job = await getJob(id);
      if (!job?.rows?.length) { toast('No rows in this scan yet.', 'error'); return; }
      state.dataset = {
        title: job.title, url: job.target || '', source: `Scan · ${job.kind}`,
        sheets: [makeSheet('Rows', job.rows, job.columns?.length ? job.columns : undefined)], active: 0,
      };
      changed();
      ctx.go('table');
    };

    async function render() {
      const jobs = await listJobs();
      if (!jobs.length) {
        fill(list, h('li', { class: 'empty' },
          h('p', {}, 'Nothing running.'),
          h('p', { class: 'muted small' }, 'Ask Claude to scan an account — “scan @nasa on Instagram and get every reel with its transcript”. Long scans run here in the background and the rows land in your Data Table.')));
        return;
      }
      fill(list, ...jobs.map((j) => {
        const [label, cls] = STATUS[j.status] || [j.status, ''];
        const pct = j.total ? Math.min(100, Math.round(((j.done || 0) / j.total) * 100)) : 0;
        return h('li', { class: j.status === 'running' ? 'highlight' : '' },
          h('div', { class: 'title' }, j.title || j.kind),
          h('div', { class: `meta ${cls}` }, `${label}${j.total ? ` · ${j.done || 0} / ${j.total}` : ''} · started ${ago(j.startedAt)}`),
          j.status === 'running'
            ? h('div', { class: 'job-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', ...(j.total ? { 'aria-valuenow': String(pct) } : {}) },
              h('div', { class: `job-fill ${j.total ? '' : 'indeterminate'}`, style: j.total ? `width:${pct}%` : '' }))
            : null,
          h('div', { class: 'meta wrap' }, j.note || ''),
          j.error ? h('div', { class: 'meta wrap danger' }, j.error) : null,
          (j.notes || []).length ? h('details', {}, h('summary', { class: 'muted small' }, plural(j.notes.length, 'note')),
            h('ul', { class: 'hint' }, j.notes.map((n) => h('li', {}, n)))) : null,
          h('div', { class: 'actions' },
            (j.rows || []).length ? h('button', { type: 'button', class: 'link-btn', onclick: () => open(j.id) }, `Open ${plural(j.rows.length, 'row')}`) : null,
            j.status === 'running' ? h('button', { type: 'button', class: 'link-btn danger', onclick: async () => {
              if (await confirmDialog('Stop this scan?', 'Rows collected so far are kept.', 'Stop')) { await cancelJob(j.id); render(); }
            } }, 'Stop') : null,
            j.status !== 'running' ? h('button', { type: 'button', class: 'link-btn danger', onclick: async () => { await deleteJob(j.id); render(); } }, 'Remove') : null));
      }));
    }

    const onStore = (c, area) => { if (area === 'local' && Object.keys(c).some((k) => k === 'jobs' || k.startsWith('job:'))) render(); };
    chrome.storage.onChanged.addListener(onStore);
    render();
    const tick = setInterval(render, 5000); // the "started 3 min ago" line, and stalled detection

    return {
      el: h('div', { class: 'stack' },
        h('p', { class: 'hint' }, 'Scans Claude started that take longer than one request — a whole account, every reel, each transcript. They keep running while Chrome is open and this connector is on; rows appear in your Data Table as they arrive.'),
        list),
      cleanup: () => { chrome.storage.onChanged.removeListener(onStore); clearInterval(tick); },
    };
  },
};
