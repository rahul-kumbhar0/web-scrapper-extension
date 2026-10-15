// Executes MCP tool calls from Claude inside the extension (runs in the offscreen bridge page).
// `sw(op, arg)` performs browser operations in the service worker (see background.js OPS).
import { fetchDoc, runPool, normalizeUrl } from './net.js';
import { crawlContacts } from './crawl.js';
import { storeOrigin, isShopify, fetchProducts, productRows } from './shopify.js';
import { discoverSitemaps, crawlSitemaps, urlMatcher } from './sitemap.js';

const engine = () => globalThis.__webScraper;
const MAX_REPLY_CHARS = 120000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const unpack = (p) => (p?.data || []).map((v) => Object.fromEntries(p.cols.map((c, i) => [c, v[i]])));
const columnsOf = (rows) => { const c = []; for (const r of rows) for (const k of Object.keys(r)) if (!c.includes(k)) c.push(k); return c; };
const sheet = (name, rows, cols = columnsOf(rows)) => ({ name, cols, rows });

function text(obj) {
  let s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1);
  if (s.length > MAX_REPLY_CHARS) s = s.slice(0, MAX_REPLY_CHARS) + '\n…(truncated — the full result is in the extension Data Table)';
  return { content: [{ type: 'text', text: s }] };
}

function rowsReply(rows, max = 100, extra = {}) {
  const n = Math.max(0, Math.min(Number(max) || 100, 2000));
  return text({
    ...extra,
    total_rows: rows.length,
    columns: columnsOf(rows),
    rows: rows.slice(0, n),
    ...(rows.length > n ? { note: `Showing ${n} of ${rows.length} rows. All rows are in the extension Data Table (the user can export them), or call data_table_read with an offset.` } : {}),
  });
}

export async function execute(tool, args, sw) {
  const settings = await sw('settings');
  const delay = (ms) => sleep(ms ?? settings.delayMs ?? 1000);
  const call = (tabId, method, ...a) => sw('callInTab', { tabId, method, args: a });
  const save = (title, url, source, sheets) => sw('saveDataset', { title, url, source, sheets });

  // Tab for "current page" tools: open args.url first if given.
  async function tabFor(a) {
    if (a.url) {
      const t = await sw('open', { url: normalizeUrl(a.url), tabId: a.tab_id, waitMs: a.wait_ms ?? 1500 });
      return t.tab_id;
    }
    return a.tab_id ?? (await sw('activeTab')).tab_id;
  }

  // ---------- shared runners (also used by recipe_run) ----------
  async function runList(tabId, cfg) {
    const rows = [];
    const seen = new Set();
    let first = null;
    const pag = cfg.pagination || { mode: 'none' };
    const max = pag.mode === 'none' ? 1 : Math.max(1, Math.min(pag.max || 5, 200));
    let stalls = 0;
    for (let step = 0; step < max; step++) {
      const res = await call(tabId, 'extractList', cfg);
      first ??= res;
      let added = 0;
      for (const vals of res.data) {
        const key = vals.join('\u0001');
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(Object.fromEntries(res.cols.map((c, i) => [c, vals[i]])));
        added++;
      }
      if (pag.mode === 'none' || step === max - 1) break;
      if (pag.mode === 'scroll') {
        const fp = await call(tabId, 'fingerprint', cfg.itemSelector);
        await call(tabId, 'scrollStep', cfg.itemSelector);
        const changed = await call(tabId, 'waitForChange', cfg.itemSelector, fp, 5000);
        stalls = changed || added ? 0 : stalls + 1;
        if (stalls >= 2) break;
      } else {
        if (!pag.selector) break;
        if (!(await sw('clickAndWait', { tabId, buttonSelector: pag.selector, itemSelector: cfg.itemSelector }))) break;
      }
      await delay(pag.delayMs);
    }
    return { rows, title: first?.title || 'List', url: first?.url || '' };
  }

  async function runPages(urls, fields, { mode = 'fast', concurrency = 3, waitMs = 1500 } = {}) {
    if (mode === 'fast' && fields.some((f) => f.builtin?.startsWith('maps_'))) mode = 'browser';
    const rows = new Array(urls.length);
    await runPool(urls.map(normalizeUrl).filter(Boolean), mode === 'browser' ? Math.min(concurrency, 4) : concurrency, async (url, i) => {
      try {
        const res = mode === 'browser'
          ? await sw('runInNewTab', { url, method: 'extractPage', args: [fields], waitMs })
          : engine().extractPage(fields, (await fetchDoc(url)).doc);
        rows[i] = { url, ...Object.fromEntries(res.cols.map((c, k) => [c, res.data[0][k]])) };
      } catch (e) { rows[i] = { url, error: String(e.message || e) }; }
    });
    return rows.filter(Boolean);
  }

  async function runContacts(urls, opts) {
    return crawlContacts(urls, { deep: opts.deep ?? true, maxSubpages: opts.maxSubpages ?? 5, concurrency: opts.concurrency ?? 4, emailDomainFilter: opts.domain || '' });
  }

  async function runShopify(store, collection, format) {
    const origin = storeOrigin(store);
    if (!origin) throw new Error('Invalid store address');
    if (!(await isShopify(origin))) throw new Error(`${origin} does not look like a Shopify store (no public /products.json).`);
    const products = await fetchProducts(origin, { collection });
    return { origin, products, rows: productRows(origin, products, format || 'variants') };
  }

  async function runSitemap(site, { filter = '', maxUrls = 5000, sections = [] } = {}) {
    const url = normalizeUrl(site);
    if (!url) throw new Error('Invalid site');
    const origin = new URL(url).origin;
    const found = await discoverSitemaps(origin);
    if (!found.length) throw new Error('No sitemap found (checked robots.txt and common locations).');
    const res = await crawlSitemaps(found, { maxUrls });
    let rows = res.rows;
    if (sections.length) rows = rows.filter((r) => sections.includes(r.section));
    if (filter) { const m = urlMatcher(filter); rows = rows.filter((r) => m(r.url)); }
    return { origin, rows, sitemaps: res.sitemaps };
  }

  async function runQuick(tabId, types, { selector = '', scroll = false } = {}) {
    if (scroll) await call(tabId, 'autoScroll', {});
    const all = [...types, ...(selector ? ['custom'] : [])];
    const res = await call(tabId, 'quick', all, { selector });
    return { res, sheets: all.map((t) => sheet(t, unpack(res.results[t]))) };
  }

  const fieldsFromArgs = (fields = []) => fields.map((f) => ({
    name: f.name,
    path: !f.selector || f.selector === ':scope' ? ':scope' : f.selector,
    idx: 0,
    attr: f.attr || 'text',
  }));

  async function listConfig(tabId, a) {
    let cfg;
    if (a.item_selector) {
      const d = await call(tabId, 'describeSelector', a.item_selector);
      cfg = { itemSelector: a.item_selector, fields: a.fields?.length ? fieldsFromArgs(a.fields) : d.fields };
    } else {
      const cands = await call(tabId, 'autoDetectLists');
      if (!cands.length) throw new Error('No repeating list found on this page. Try browser_screenshot / page_read and pass item_selector.');
      const c = cands[Math.min(a.candidate || 0, cands.length - 1)];
      cfg = { itemSelector: c.itemSelector, fields: a.fields?.length ? fieldsFromArgs(a.fields) : c.fields };
    }
    const p = a.pagination || {};
    let mode = p.mode || 'none';
    let selector = p.button_selector || '';
    if (mode === 'auto' || ((mode === 'next' || mode === 'loadmore') && !selector)) {
      const next = mode !== 'loadmore' ? await call(tabId, 'findNextButton') : null;
      const more = !next && mode !== 'next' ? await call(tabId, 'findLoadMoreButton') : null;
      mode = next ? 'next' : more ? 'loadmore' : 'none';
      selector = next || more || '';
    }
    cfg.pagination = { mode, selector, max: p.max_pages || 5, delayMs: p.delay_ms ?? settings.delayMs };
    return cfg;
  }

  // ---------- tools ----------
  switch (tool) {
    case 'browser_tabs':
      return text(await sw('listTabs'));

    case 'browser_open':
      return text(await sw('open', { url: normalizeUrl(args.url), newTab: !!args.new_tab, waitMs: args.wait_ms ?? 1500 }));

    case 'browser_screenshot': {
      const shot = await sw('screenshot', { tabId: args.tab_id });
      return { content: [
        { type: 'image', data: shot.dataUrl.split(',')[1], mimeType: 'image/jpeg' },
        { type: 'text', text: `${shot.title} — ${shot.url}` },
      ] };
    }

    case 'page_action': {
      const tabId = await tabFor(args);
      if (args.action === 'scroll_bottom') return text({ ok: true, page_height: await call(tabId, 'autoScroll', { maxSteps: 10, pauseMs: 800 }) });
      if (!args.selector) throw new Error('selector is required');
      if (args.action === 'click') {
        const ok = await call(tabId, 'clickElement', args.selector);
        await sleep(1500);
        return text({ ok, note: ok ? 'Clicked.' : 'Element not found or disabled.' });
      }
      if (args.action === 'fill') return text({ ok: await call(tabId, 'fillInput', args.selector, String(args.text ?? '')) });
      throw new Error(`Unknown action ${args.action}`);
    }

    case 'page_read': {
      const max = args.max_chars || 30000;
      let r;
      let meta;
      const META = [{ name: 'description', builtin: 'description' }, { name: 'author', builtin: 'author' }, { name: 'published', builtin: 'published' }, { name: 'language', builtin: 'language' }];
      if (args.url && args.tab_id == null) {
        const { doc, url } = await fetchDoc(normalizeUrl(args.url));
        r = args.full_text ? engine().pageText(max, doc) : { ...engine().readable(doc), url };
        meta = unpack(engine().extractPage(META, doc))[0];
      } else {
        const tabId = args.tab_id ?? (await sw('activeTab')).tab_id;
        r = args.full_text ? await call(tabId, 'pageText', max) : await call(tabId, 'readable');
        r.url ??= (await sw('listTabs')).find((t) => t.tab_id === tabId)?.url;
        meta = unpack(await call(tabId, 'extractPage', META))[0];
      }
      const body = (args.full_text ? r.text : r.markdown) || '';
      return text(`# ${r.title}\nURL: ${r.url || args.url}\n${Object.entries(meta || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${body.slice(0, max)}${body.length > max ? '\n…(truncated)' : ''}`);
    }

    case 'quick_scan': {
      const tabId = await tabFor(args);
      const { res, sheets } = await runQuick(tabId, args.types?.length ? args.types : ['emails', 'phones', 'social', 'links']);
      await save(res.title, res.url, 'Claude · Quick Scan', sheets);
      const n = Math.min(args.max_rows_returned || 100, 2000);
      return text({ url: res.url, title: res.title, results: Object.fromEntries(sheets.map((s) => [s.name, { total: s.rows.length, rows: s.rows.slice(0, n) }])) });
    }

    case 'list_detect': {
      const tabId = await tabFor(args);
      const cands = await call(tabId, 'autoDetectLists');
      const out = [];
      for (const [i, c] of cands.entries()) {
        const sample = await call(tabId, 'extractList', c);
        out.push({ candidate: i, item_selector: c.itemSelector, items: c.count, fields: c.fields.map((f) => `${f.name} (${f.attr})`), sample_rows: unpack(sample).slice(0, 3) });
      }
      return text({
        candidates: out,
        next_button: await call(tabId, 'findNextButton'),
        load_more_button: await call(tabId, 'findLoadMoreButton'),
        hint: 'Call list_extract with candidate=<n> (or item_selector) and pagination {mode:"auto"|"next"|"loadmore"|"scroll", max_pages}.',
      });
    }

    case 'list_extract': {
      const tabId = await tabFor(args);
      const cfg = await listConfig(tabId, args);
      const r = await runList(tabId, cfg);
      await save(r.title, r.url, 'Claude · List Extractor', [sheet('List', r.rows)]);
      return rowsReply(r.rows, args.max_rows_returned, { url: r.url, item_selector: cfg.itemSelector, pagination: cfg.pagination.mode });
    }

    case 'page_extract': {
      if (!args.urls?.length) throw new Error('urls is required');
      if (!args.fields?.length) throw new Error('fields is required');
      const fields = args.fields.map((f) => (f.builtin ? { name: f.name, builtin: f.builtin } : { name: f.name, selector: f.selector, attr: f.attr || 'text', multiple: !!f.multiple }));
      const rows = await runPages(args.urls, fields, { mode: args.mode, concurrency: args.concurrency || settings.concurrency });
      await save(`Pages (${rows.length})`, args.urls[0], 'Claude · Page Extractor', [sheet('Pages', rows)]);
      return rowsReply(rows, args.max_rows_returned);
    }

    case 'find_emails': {
      const res = await runContacts(args.urls || [], { deep: args.deep, maxSubpages: args.max_subpages });
      const sheets = [sheet('Emails', res.emails, ['site', 'email', 'found_on', 'source'])];
      if (args.include_phones) sheets.push(sheet('Phones', res.phones, ['site', 'phone', 'found_on']));
      await save(`Emails from ${args.urls.length} sites`, args.urls[0], 'Claude · Email Extractor', sheets);
      return rowsReply(res.emails, args.max_rows_returned, { ...(args.include_phones ? { phones: res.phones.slice(0, 200) } : {}), failed: res.failures });
    }

    case 'find_social_links': {
      const res = await runContacts(args.urls || [], { deep: args.deep });
      await save(`Social links from ${args.urls.length} sites`, args.urls[0], 'Claude · Social Link Extractor', [sheet('Social links', res.socials, ['site', 'platform', 'profile', 'found_on'])]);
      return rowsReply(res.socials, args.max_rows_returned, { failed: res.failures });
    }

    case 'shopify_products': {
      const r = await runShopify(args.store, args.collection, args.format);
      await save(`${new URL(r.origin).host} products`, r.origin, 'Claude · Shopify Extractor', [sheet('Products', r.rows)]);
      return rowsReply(r.rows, args.max_rows_returned, { store: r.origin, products: r.products.length });
    }

    case 'sitemap_urls': {
      const r = await runSitemap(args.site, { filter: args.filter, maxUrls: args.max_urls || 5000 });
      await save(`Sitemap — ${new URL(r.origin).host}`, r.origin, 'Claude · Sitemap Explorer', [sheet('URLs', r.rows, ['url', 'lastmod', 'section', 'sitemap'])]);
      const sections = {};
      for (const row of r.rows) sections[row.section] = (sections[row.section] || 0) + 1;
      return rowsReply(r.rows.map((x) => ({ url: x.url, lastmod: x.lastmod })), args.max_rows_returned ?? 300, { sitemaps: r.sitemaps, sections });
    }

    case 'images_find': {
      const tabId = await tabFor(args);
      if (args.scroll ?? true) await call(tabId, 'autoScroll', { maxSteps: 15, pauseMs: 600 });
      const res = await call(tabId, 'quick', ['images']);
      const minW = args.min_width ?? 100;
      const minH = args.min_height ?? 100;
      const rows = unpack(res.results.images).filter((r) => (!Number(r.width) || Number(r.width) >= minW) && (!Number(r.height) || Number(r.height) >= minH));
      await save(`Images — ${res.title}`, res.url, 'Claude · Image Downloader', [sheet('Images', rows)]);
      return rowsReply(rows, args.max_rows_returned ?? 200);
    }

    case 'images_download':
      return text(await sw('download', { urls: (args.urls || []).filter((u) => /^https?:/i.test(u)), folder: args.folder || 'claude' }));

    case 'data_table_read': {
      const d = await sw('getStorage', 'dataset');
      if (!d) return text({ empty: true, note: 'The Data Table is empty.' });
      const s = (args.sheet && d.sheets.find((x) => x.name === args.sheet)) || d.sheets[d.active || 0];
      const off = args.offset || 0;
      const lim = Math.min(args.limit || 100, 2000);
      return text({ title: d.title, source: d.source, url: d.url, sheets: d.sheets.map((x) => `${x.name} (${x.rows.length})`), sheet: s.name, columns: s.cols, total_rows: s.rows.length, offset: off, rows: s.rows.slice(off, off + lim).map((r) => Object.fromEntries(s.cols.map((c) => [c, r[c] ?? '']))) });
    }

    case 'recipes_list': {
      const list = (await sw('getStorage', 'recipes')) || [];
      return text(list.map((r) => ({ recipe_id: r.id, name: r.name, tool: r.tool, start_page: r.url || '', updated: new Date(r.updated || r.created).toISOString() })));
    }

    case 'recipe_run': {
      const list = (await sw('getStorage', 'recipes')) || [];
      const r = list.find((x) => x.id === args.recipe_id || x.name === args.recipe_id);
      if (!r) throw new Error(`No recipe "${args.recipe_id}". Use recipes_list.`);
      const c = r.config || {};
      const max = args.max_rows_returned;
      const pageTab = async () => (r.url ? (await sw('open', { url: r.url, waitMs: 1500 })).tab_id : (await sw('activeTab')).tab_id);
      const done = async (rows, name, extra) => { await save(r.name, r.url || '', `Claude · Recipe: ${r.name}`, [sheet(name, rows)]); return rowsReply(rows, max, extra); };
      switch (r.tool) {
        case 'list': {
          const tabId = await pageTab();
          const res = await runList(tabId, { itemSelector: c.itemSelector, fields: (c.fields || []).filter((f) => f.enabled !== false), pagination: c.pagination });
          return done(res.rows, 'List');
        }
        case 'page': return done(await runPages(c.urls || [], c.fields || [], { mode: c.mode, concurrency: c.concurrency, waitMs: c.waitMs }), 'Pages');
        case 'email': return done((await runContacts(c.urls || [], c)).emails, 'Emails');
        case 'social': return done((await runContacts(c.urls || [], c)).socials.filter((s) => !c.platforms || c.platforms.includes(s.platform)), 'Social links');
        case 'shopify': return done((await runShopify(c.store, c.collection, c.format)).rows, 'Products');
        case 'sitemap': return done((await runSitemap(c.site, c)).rows, 'URLs');
        case 'quick': {
          const tabId = await pageTab();
          const { res, sheets } = await runQuick(tabId, c.types || [], c);
          await save(r.name, res.url, `Claude · Recipe: ${r.name}`, sheets);
          return text(Object.fromEntries(sheets.map((s) => [s.name, { total: s.rows.length, rows: s.rows.slice(0, max || 100) }])));
        }
        case 'text': {
          const rows = await runPool(c.urls || [], 3, async (u) => { const { doc, url } = await fetchDoc(normalizeUrl(u)); const x = engine().readable(doc); return { url, title: x.title, words: x.words, markdown: x.markdown }; });
          return done(rows.map((x, i) => (x.ok ? x.value : { url: c.urls[i], error: x.error })), 'Text');
        }
        default:
          throw new Error(`Recipes of type "${r.tool}" can't be run by Claude yet — run it from the side panel.`);
      }
    }

    default:
      throw new Error(`Unknown tool ${tool}`);
  }
}
