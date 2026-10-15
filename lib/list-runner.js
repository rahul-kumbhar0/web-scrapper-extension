// Runs a List Extractor job in a tab. Shared by the side panel and the Claude (MCP) bridge.
//
// Real sites only render what is on screen (LinkedIn "occludes" job cards, Instagram lazy-loads
// captions, Google Maps appends results when its panel scrolls), so the runner:
//   • scrolls ONE screen at a time and collects after every step,
//   • merges rows by a key column (job id / link …): a half-loaded row is completed later instead
//     of being duplicated or kept blank,
//   • sweeps each page before clicking Next / Load more,
//   • waits for new items at the bottom and stops when nothing new arrives.
//
// io = { call(method, ...args) → engine call in the tab, clickAndWait(buttonSel, itemSel),
//        focus?(), sleep(ms), signal?, onProgress?(rowsSoFar, step, maxSteps) }

const KEY_NAMES = /^(link|url|href|.*_link|.*_url|job_?id|asin|id|post_?id)$/i;

export function pickKeyField(fields) {
  return (
    fields.find((f) => /^data-/.test(f.attr || ''))?.name ||
    fields.find((f) => f.attr === 'href' && KEY_NAMES.test(f.name))?.name ||
    fields.find((f) => f.attr === 'href')?.name ||
    null
  );
}

export async function runList(cfg, io) {
  const sel = cfg.itemSelector;
  const pag = { mode: 'none', max: 5, delayMs: 1000, ...(cfg.pagination || {}) };
  const stepMs = Math.max(250, Math.min(pag.stepMs ?? 600, 5000));
  const keyField = pickKeyField(cfg.fields);
  const store = new Map();
  let cols = null;
  let first = null;
  let steps = 0;
  let pages = 1;
  const aborted = () => io.signal?.aborted;

  const hasData = (row) => cols.some((c) => c !== keyField && row[c]);

  // Merge one extraction into the store; returns how many rows were added or completed.
  async function collect() {
    const res = await io.call('extractList', cfg);
    first ??= res;
    cols ??= res.cols;
    let changed = 0;
    for (const vals of res.data) {
      const row = Object.fromEntries(res.cols.map((c, i) => [c, vals[i] ?? '']));
      const key = keyField ? row[keyField] : vals.join('\u0001');
      if (!key) continue;
      const prev = store.get(key);
      if (!prev) {
        store.set(key, row);
        if (hasData(row)) changed++;
        continue;
      }
      let filled = false;
      for (const c of res.cols) if (!prev[c] && row[c]) { prev[c] = row[c]; filled = true; }
      if (filled) changed++;
    }
    io.onProgress?.(rowsOut().length, steps, pag.mode);
    return changed;
  }

  const rowsOut = () => [...store.values()].filter((r) => (cols ? hasData(r) || !keyField : true));

  // Scroll through what is loaded (and whatever loads while scrolling), collecting each screen.
  async function sweep(maxSteps, patience, waitMs) {
    let idle = 0;
    for (let i = 0; i < maxSteps && !aborted(); i++) {
      const s = await io.call('scrollStep', sel);
      steps++;
      await io.sleep(stepMs);
      let changed = await collect();
      if (s.atBottom) {
        if (!changed) {
          const fp = await io.call('fingerprint', sel);
          if (await io.call('waitForChange', sel, fp, waitMs)) changed = await collect();
        }
        idle = changed ? 0 : idle + 1;
        if (idle >= patience) return;
      } else if (!s.moved) {
        idle++;
        if (idle >= patience + 1) return;
      } else {
        idle = 0;
      }
    }
  }

  if (pag.mode !== 'none') await io.focus?.(); // lazy loaders only run in a visible tab
  await collect();

  if (pag.mode === 'scroll') {
    await sweep(Math.max(1, Math.min(pag.max || 60, 500)), 2, 3500);
  } else {
    const maxPages = pag.mode === 'none' ? 1 : Math.max(1, Math.min(pag.max || 5, 200));
    for (let p = 0; p < maxPages && !aborted(); p++) {
      pages = p + 1;
      await sweep(40, 1, 1200); // render every card on this page
      if (pag.mode === 'none' || p === maxPages - 1 || !pag.selector) break;
      const ok = await io.clickAndWait(pag.selector, sel);
      if (!ok) break; // no more pages / button gone
      if (pag.mode === 'next') { try { await io.call('scrollToTop', sel); } catch { /* page may have navigated */ } }
      if (pag.delayMs) await io.sleep(pag.delayMs);
      await collect();
    }
  }

  return { rows: rowsOut(), cols: cols || cfg.fields.map((f) => f.name), title: first?.title || 'List', url: first?.url || '', pages, steps, keyField };
}
