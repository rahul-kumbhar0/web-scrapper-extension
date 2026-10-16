// IMAGE DOWNLOADER — collect images from the page (incl. lazy-loaded, srcset, CSS backgrounds) or
// from a Data Table column, filter by size/type, and download the selection into one folder.
import { h, fill, toast, runJob, plural } from '../ui.js';
import { capList } from '../plan.js';
import { activeSheet, makeSheet, setDataset, urlColumns, isUrl } from '../state.js';
import { card, numberField, checkbox, actions, primary, secondary } from '../widgets.js';
import { getActiveTab, callInTab } from '../../lib/tab.js';

const TYPES = ['jpg', 'png', 'webp', 'gif', 'svg', 'avif', 'other'];
const typeOf = (url) => {
  const ext = (url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] || '').toLowerCase();
  return ext === 'jpeg' ? 'jpg' : TYPES.includes(ext) ? ext : 'other';
};
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 60);

export function imageFilename(img, i, used) {
  const path = img.src.split(/[?#]/)[0];
  let base = slug(img.alt) || slug(decodeURIComponent(path.split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '')) || `image-${i + 1}`;
  const type = typeOf(img.src);
  const ext = type === 'other' ? 'jpg' : type;
  let name = `${base}.${ext}`;
  for (let n = 2; used.has(name); n++) name = `${base}-${n}.${ext}`;
  used.add(name);
  return name;
}

export async function downloadImages(images, folder, { signal, progress } = {}) {
  folder = folder.split('/').map((part) => part.replace(/[^\w.-]+/g, '_')).join('/');
  const used = new Set();
  let ok = 0;
  for (const [i, img] of images.entries()) {
    if (signal?.aborted) break;
    try {
      await chrome.downloads.download({ url: img.src, filename: `${folder}/${imageFilename(img, i, used)}`, conflictAction: 'uniquify', saveAs: false });
      ok++;
    } catch (e) { console.warn('download failed', img.src, e); }
    progress?.(`Downloading ${i + 1} / ${images.length}`, i + 1, images.length);
  }
  return ok;
}

export default {
  id: 'images',
  title: 'Image Downloader',
  icon: '▣',
  desc: 'All images on a page — lazy-loaded & backgrounds too. Filter, select, download.',
  usesPage: true,
  render(ctx) {
    const preset = ctx.preset || {};
    let images = [];
    let host = 'images';
    const selected = new Set();
    const minW = numberField('Min width', preset.minWidth ?? 100, { min: 0, max: 10000 });
    const minH = numberField('Min height', preset.minHeight ?? 100, { min: 0, max: 10000 });
    const scroll = checkbox('Scroll page first (loads lazy images)', preset.scroll ?? true);
    const types = new Set(preset.types || TYPES);
    const typeBox = h('div', { class: 'chip-grid tight' }, TYPES.map((t) => h('label', { class: 'chip' },
      h('input', { type: 'checkbox', checked: types.has(t), onchange: (e) => { if (e.target.checked) types.add(t); else types.delete(t); render(); } }), t)));
    const grid = h('div', { class: 'img-grid' });
    const info = h('div', { class: 'row' });

    const passes = (img) => types.has(typeOf(img.src)) &&
      (!img.w || img.w >= minW.get()) && (!img.h || img.h >= minH.get()) && !/^icon$/.test(img.alt);
    const visible = () => images.filter(passes);

    function render() {
      const vis = visible();
      for (const s of [...selected]) if (!vis.some((i) => i.src === s)) selected.delete(s);
      fill(info, 
        h('span', { class: 'grow muted small' }, images.length ? `${vis.length} of ${plural(images.length, 'image')} shown · ${selected.size} selected` : ''),
        images.length ? h('button', { type: 'button', class: 'btn tiny', onclick: () => { vis.forEach((i) => selected.add(i.src)); render(); } }, 'Select all') : null,
        images.length ? h('button', { type: 'button', class: 'btn tiny', onclick: () => { selected.clear(); render(); } }, 'None') : null);
      fill(grid, ...vis.map((img) => {
        const thumb = h('img', { src: img.src, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', onerror: (e) => { e.target.replaceWith(h('span', { class: 'img-broken' }, 'No preview')); } });
        thumb.addEventListener('load', () => {
          const known = img.w && img.h;
          img.w = img.w || thumb.naturalWidth;
          img.h = img.h || thumb.naturalHeight;
          if (!known) { tile.querySelector('.dims').textContent = `${img.w}×${img.h}`; if (!passes(img)) render(); }
        });
        const tile = h('label', { class: `img-tile ${selected.has(img.src) ? 'on' : ''}`, title: img.src },
          h('input', { type: 'checkbox', checked: selected.has(img.src), onchange: (e) => { if (e.target.checked) selected.add(img.src); else selected.delete(img.src); tile.classList.toggle('on', e.target.checked); render(); } }),
          thumb,
          h('span', { class: 'dims' }, img.w && img.h ? `${img.w}×${img.h}` : typeOf(img.src)));
        return tile;
      }));
    }
    [minW, minH].forEach((f) => f.input.addEventListener('change', render));

    async function scan() {
      await runJob('Finding images…', async (signal, progress) => {
        const tab = await getActiveTab();
        host = new URL(tab.url).host.replace(/^www\./, '');
        if (scroll.get()) { progress('Scrolling to load lazy images…'); await callInTab(tab.id, 'autoScroll', { maxSteps: 15, pauseMs: 600 }); }
        const res = await callInTab(tab.id, 'quick', ['images']);
        const { cols, data } = res.results.images;
        images = data.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]]))).map((r) => ({ src: r.src, alt: r.alt, w: Number(r.width) || 0, h: Number(r.height) || 0, source: r.source }));
        selected.clear();
        visible().forEach((i) => selected.add(i.src));
        render();
        toast(`Found ${plural(images.length, 'image')}.`, 'ok');
      });
    }

    function fromTable() {
      const sheet = activeSheet();
      const col = urlColumns(sheet).find((c) => /image|img|src|photo|picture|thumb/i.test(c)) || urlColumns(sheet)[0];
      if (!col) { toast('No image URL column in the Data Table.', 'error'); return; }
      images = sheet.rows.map((r) => r[col]).filter(isUrl).map((src) => ({ src, alt: '', w: 0, h: 0, source: 'table' }));
      host = 'table-images';
      selected.clear();
      images.forEach((i) => selected.add(i.src));
      render();
      toast(`Loaded ${plural(images.length, 'image')} from “${col}”.`, 'ok');
    }

    async function download() {
      const chosen = capList(images.filter((i) => selected.has(i.src)), 'images', 'image downloads');
      if (!chosen.length) { toast('Select some images first.', 'error'); return; }
      await runJob(`Downloading ${plural(chosen.length, 'image')}…`, async (signal, progress) => {
        const n = await downloadImages(chosen, `pullrows/${host}`, { signal, progress });
        toast(`Saved ${plural(n, 'image')} to Downloads/pullrows/${host}/`, 'ok');
      });
    }

    async function toTable() {
      const rows = images.filter((i) => selected.has(i.src)).map((i) => ({ src: i.src, alt: i.alt, width: i.w || '', height: i.h || '', type: typeOf(i.src), source: i.source }));
      await setDataset({ title: `Images — ${host}`, url: '', source: 'Image Downloader', sheets: [makeSheet('Images', rows)] });
      ctx.go('table');
    }

    if (ctx.autoRun) setTimeout(scan, 50);
    render();
    return h('div', { class: 'stack' },
      card('Source',
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary grow', onclick: scan }, 'Find images on this page'),
          h('button', { type: 'button', class: 'btn secondary', onclick: fromTable }, 'From Data Table')),
        scroll.el),
      card('Filter', h('div', { class: 'row' }, minW.el, minH.el), typeBox),
      card(null, info, grid),
      actions(primary('Download selected', download), secondary('To table', toTable),
        secondary('Save recipe', () => ctx.saveRecipe(ctx.tool, { minWidth: minW.get(), minHeight: minH.get(), types: [...types], scroll: scroll.get() }))));
  },
};
