// Executes MCP tool calls from Claude inside the extension (runs in the offscreen bridge page).
// `sw(op, arg)` performs browser operations in the service worker (see background.js OPS).
import { fetchDoc, fetchText, fetchJson, postJson, fetchWithTimeout, runPool, normalizeUrl, setFetchGuard } from './net.js';
import { crawlContacts } from './crawl.js';
import { storeOrigin, isShopify, fetchProducts, productRows } from './shopify.js';
import { discoverSitemaps, crawlSitemaps, urlMatcher } from './sitemap.js';
import { runList as runListJob, waitUntilUnblocked } from './list-runner.js';
import { assertAllowed, blockedReason } from './guard.js';
import { smartRun, looksLikeShell } from './smart.js';
import { findTrends, captionsToText, transcriptFor, redditJsonUrl, redditCollect, redditComments, TOP_COLUMNS, ALL_COLUMNS } from './trends.js';
import { searchUrlFor } from './sitesearch.js';
import { scanAccount, resolveAccount, ACCOUNT_COLUMNS } from './account.js';
import { startJob, getJob, cancelJob, listJobs } from './jobs.js';
import { videoFrames, youtubeStills, YT_ID } from './frames.js';

const engine = () => globalThis.__webScraper;
// Every character here lands in the Claude conversation and is paid for on every later turn.
// The full result is always in the Data Table, and data_table_read pages through it.
const MAX_REPLY_CHARS = 40000;
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

// Page tools that also return a screenshot of the page (args.screenshot === false turns it off).
const SHOT_TOOLS = new Set(['browser_open', 'list_detect', 'list_extract', 'page_action', 'quick_scan', 'images_find', 'site_search']);

// A JPEG of the tab, scaled down so it is cheap to show in the chat (and readable on a phone).
async function screenshotFor(tabId, sw) {
  const shot = await sw('screenshot', { tabId, quiet: true });
  if (!shot) return null; // the tab is not the one on screen; never switch tabs for a picture
  let data = shot.dataUrl.split(',')[1];
  try {
    const bmp = await createImageBitmap(await (await fetch(shot.dataUrl)).blob());
    const scale = Math.min(1, 1024 / bmp.width);
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    data = btoa(bin);
  } catch { /* keep the original capture */ }
  return { type: 'image', data, mimeType: 'image/jpeg' };
}

// One of the page's own images, shrunk to something cheap to put in a chat message.
// This is how a page is "shown" to Claude without opening a tab: a screenshot needs a visible
// tab, but the pictures the page itself serves need nothing but a fetch.
async function imageBlock(url, signal, max = 768) {
  const res = await fetchWithTimeout(url, { timeoutMs: 12000, signal });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (!/^image\//i.test(type) || /svg|x-icon/i.test(type)) return null;
  const blob = await res.blob();
  if (blob.size > 12 * 1024 * 1024) return null;
  const bmp = await createImageBitmap(blob);
  if (bmp.width < 120 || bmp.height < 120) return null; // an icon, not a picture of the page
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { type: 'image', data: btoa(bin), mimeType: 'image/jpeg' };
}

// The pictures worth showing: the social preview first, then the biggest real images.
function pickImages(rows, want) {
  const good = rows.filter((r) => /^https?:/i.test(r.src) && !/icon|logo|sprite|avatar|placeholder|pixel|tracking/i.test(`${r.src} ${r.alt} ${r.source}`));
  const area = (r) => (Number(r.width) || 0) * (Number(r.height) || 0);
  const meta = good.filter((r) => r.source === 'meta');
  const rest = good.filter((r) => r.source !== 'meta').sort((a, b) => area(b) - area(a));
  return [...new Set([...meta, ...rest].map((r) => r.src))].slice(0, want);
}

const UPGRADE = 'Upgrade to PullRows Pro for no limits (PullRows side panel → Upgrade).';
const MAX_CONCURRENCY = 6;

// opts.internal: a scheduled monitor run started by the extension itself (not Claude): no Claude
// usage counting or connector safety rules, pages open in background tabs, and the results are
// returned in opts.captured instead of replacing the user's Data Table.
export async function execute(tool, args, sw, signal, opts = {}) {
  const internal = !!opts.internal;
  const settings = await sw('settings');
  const L = settings.limits;
  const guard = { blocked: settings.mcp?.blocked, allowPrivate: !!settings.mcp?.allowLocal };
  const call = (tabId, method, ...a) => sw('callInTab', { tabId, method, args: a });
  const save = internal
    ? async (title, url, source, sheets) => { opts.captured = { title, url, sheets }; }
    : (title, url, source, sheets) => sw('saveDataset', { title, url, source, sheets });
  const notes = [];
  // Cap a list of URLs to the plan limit and drop the ones the user's safety settings block.
  const urlList = (list, limit, what) => {
    const all = (Array.isArray(list) ? list : []).map(normalizeUrl).filter(Boolean);
    const ok = all.filter((u) => !blockedReason(u, guard));
    if (ok.length < all.length) notes.push(`${all.length - ok.length} URL(s) skipped: blocked by the user's PullRows safety settings.`);
    if (ok.length > limit) notes.push(`Free plan: ${what} limited to ${limit} per call — ran the first ${limit}. ${UPGRADE}`);
    return ok.slice(0, limit);
  };
  const conc = (n) => Math.max(1, Math.min(Number(n) || settings.concurrency || 3, MAX_CONCURRENCY));
  setFetchGuard(internal ? null : (u) => assertAllowed(u, guard));

  const callStarted = Date.now();

  // A link that leaked (a screenshot, a shared project) must not be able to drive this browser:
  // the user approves the first client that uses it, in the side panel.
  if (!internal && !settings.mcp?.pairedAt) {
    await sw('requestPairing');
    return { isError: true, content: [{ type: 'text', text: 'PullRows is waiting for the user to approve this connector link. Ask them to open the PullRows side panel → Settings → Claude connector and choose "Allow", then try again.' }] };
  }

  const usage = internal ? { allowed: true } : await sw('useMcpCall');
  let usageSpent = !internal;
  const refund = () => { if (usageSpent) { usageSpent = false; sw('releaseMcpCall').catch(() => {}); } };
  if (!usage.allowed) {
    return { isError: true, content: [{ type: 'text', text: `The PullRows free plan includes ${usage.limit} Claude tool calls per day and today's are used up. ${UPGRADE} The user can still use every tool directly in the side panel.` }] };
  }

  // What this call did and where it ran, shown to the user in the chat with the results.
  const trace = [];
  const note = (s) => { trace.push(s); return s; };
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const browserMode = args.mode === 'browser';

  // Tab for "current page" tools: open args.url first if given. Tabs PullRows opens for a call are
  // opened in the background (the user is never switched away from what they are doing) and closed
  // again when the call ends, unless keep_tab is set.
  let usedTab = null; // the tab a page tool worked in (for the screenshot shown in the chat)
  const openedTabs = [];
  // "Allow actions" is no longer all-or-nothing: clicking and typing happen only on the sites the
  // user approved, so a connector left on cannot press buttons on every site they are signed in to.
  let actionsHere = false;
  function allowActionsOn(url) {
    const m = settings.mcp || {};
    if (!m.allowActions) return false;
    if (m.actionAnySite) return true;
    const host = hostOf(url);
    return (m.actionOrigins || []).some((r) => {
      const rule = String(r || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*?\.?/, '').replace(/^www\./, '');
      return !!rule && (host === rule || host.endsWith(`.${rule}`));
    });
  }
  async function tabFor(a) {
    if (a.url) {
      const t = await sw('open', { url: normalizeUrl(a.url), tabId: a.tab_id, newTab: a.tab_id == null, waitMs: a.wait_ms ?? 1500, active: browserMode || a.activate === true });
      usedTab = t.tab_id;
      actionsHere = allowActionsOn(t.url || a.url);
      if (a.tab_id == null) {
        openedTabs.push(t.tab_id);
        note(browserMode ? `Opened ${hostOf(a.url)} in a new tab` : `Opened ${hostOf(a.url)} in a background tab (you were not switched to it; it closes when this finishes)`);
      }
      return t.tab_id;
    }
    const info = a.tab_id != null ? await sw('tabInfo', { tabId: a.tab_id }) : await sw('activeTab');
    usedTab = info.tab_id;
    actionsHere = allowActionsOn(info.url || '');
    return usedTab;
  }

  // ---------- no-tab mode: fetch the HTML and run the engine on it in this document ----------
  // Works for server-rendered pages (most shops, directories, job boards, Wikipedia, old Reddit…).
  // JavaScript-built pages, CAPTCHA / login walls, infinite scroll and "Load more" need a tab.
  async function fetchPage(url, { depth = 0 } = {}) {
    const { doc, url: final } = await fetchDoc(url, { signal });
    assertAllowed(final, guard);
    const block = engine().pageBlock(doc);
    if (block) return { needsTab: block.label.toLowerCase() };
    if (looksLikeShell(doc)) {
      // A page "built by JavaScript" usually still carries its data, as the JSON the framework
      // hydrates from. Reading that is a no-tab read.
      const json = engine().jsonLists(doc);
      if (json.length) return { doc, url: final, json, shell: true };
      // Failing that, many JS-heavy sites publish a plain, server-rendered AMP copy.
      const amp = engine().ampUrl(doc);
      if (depth === 0 && amp && amp !== final && !blockedReason(amp, guard)) {
        note(`${hostOf(final)} builds itself with JavaScript — reading its AMP copy instead`);
        const alt = await fetchPage(amp, { depth: 1 }).catch(() => null);
        if (alt?.doc) return alt;
      }
      return { needsTab: 'the page builds itself with JavaScript' };
    }
    return { doc, url: final };
  }

  // Rows straight out of the page's own JSON — no DOM selectors, no tab, no pagination.
  function jsonListResult(page, ref, a) {
    const cands = page.json || engine().jsonLists(ref.doc);
    if (!cands.length) return null;
    const asked = String(a.item_selector || '');
    const chosen = asked.startsWith('json:')
      ? cands.find((c) => c.path === asked.slice(5))
      : cands[Math.min(a.candidate || 0, cands.length - 1)];
    if (!chosen) return null;
    let { rows, cols } = chosen;
    const names = (a.fields || []).map((f) => f.name).filter(Boolean);
    if (names.length) { cols = names; rows = rows.map((r) => Object.fromEntries(names.map((n) => [n, r[n] ?? '']))); }
    note(`Read ${hostOf(ref.url)} from the data the page itself ships as JSON (${chosen.source} → ${chosen.path}) — no tab opened`);
    note(`${rows.length} rows`);
    if (a.pagination?.mode && a.pagination.mode !== 'none') {
      notes.push('No pagination was needed: every row came from the page data in a single read.');
    }
    return { rows, cols, title: ref.doc.title || '', url: ref.url, pages: 1, steps: 0, keyField: null, partial: 0, warning: '', blocked: null, itemSelector: `json:${chosen.path}` };
  }
  const bgCall = (ref) => {
    const c = async (method, ...a) => {
      const E = engine();
      switch (method) {
        case 'autoDetectListsReady': {
          // In a tab the engine keeps looking while the best group is page furniture (a menu, a header);
          // in plain HTML that means the real list is script-built, so report "no list" and let the
          // caller fall back to a tab.
          const cands = E.autoDetectLists(ref.doc).filter((x) => !x.chrome || x.preset);
          if (!cands.length) throw new Error('no data list in the page HTML (the list is probably built by JavaScript)');
          return cands;
        }
        case 'countSelector': return ref.doc.querySelectorAll(a[0]).length;
        case 'scrollStep': return { atBottom: true, moved: false };
        case 'pageState': return { visibility: 'visible' };
        case 'fingerprint': return '';
        case 'waitForChange': return false;
        case 'jiggle': case 'scrollToTop': case 'autoScroll': return null;
        default: return E[method](...a, ref.doc);
      }
    };
    c.static = true;
    return c;
  };
  // The link a Next / Load-more selector points at (null when it is a script button).
  const nextHref = (ref, selector) => {
    const el = ref.doc.querySelector(selector);
    const href = el?.getAttribute('href') || el?.closest('a[href]')?.getAttribute('href') || el?.getAttribute('data-href') || el?.getAttribute('data-url') || '';
    if (!href || /^(javascript:|#)/i.test(href)) return null;
    try { return new URL(href, ref.url).href; } catch { return null; }
  };
  // Returns the list result, or null when the page needs a real tab (the reason is in the trace).
  async function runListBackground(url, a) {
    if (browserMode) return null;
    const wanted = a.pagination?.mode || 'none';
    const scrolling = wanted === 'scroll' || wanted === 'loadmore';
    let page;
    try { page = await fetchPage(url); } catch (e) { if (/^Blocked by PullRows/.test(e?.message)) throw e; note(`Could not read ${hostOf(url)} in the background (${String(e.message || e).slice(0, 80)})`); return null; }
    if (page.needsTab) { note(`${hostOf(url)}: ${page.needsTab}, so a browser tab is needed`); return null; }
    const ref = { doc: page.doc, url: page.url };
    const askedJson = String(a.item_selector || '').startsWith('json:');
    // Scrolling and "Load more" need a real tab — unless the rows are already in the page's own
    // JSON, which is the usual reason a feed looks script-built in the first place.
    if (scrolling || askedJson) {
      const fromJson = jsonListResult(page, ref, a);
      if (fromJson) {
        if (scrolling) {
          fromJson.warning = `These ${fromJson.rows.length} rows came from the data the page ships, in one read — no scrolling. If the site loads still more as you scroll, ask again with mode "browser".`;
        }
        return fromJson;
      }
      note(askedJson ? 'That json: list is not in this page’s data any more'
        : `${wanted === 'scroll' ? 'Infinite scroll' : '"Load more"'} needs a browser tab (the page ships no usable JSON)`);
      return null;
    }
    let cfg;
    try {
      cfg = await listConfigWith(bgCall(ref), a);
    } catch (e) {
      const fromJson = jsonListResult(page, ref, a);
      if (fromJson) return fromJson;
      note(`No list in the HTML of ${hostOf(url)} (${String(e.message || e).slice(0, 80)}); trying a browser tab`);
      return null;
    }
    const pm = cfg.pagination.mode;
    if (pm === 'scroll' || pm === 'loadmore') { note(`${hostOf(url)} loads more items by ${pm === 'scroll' ? 'scrolling' : 'a "Load more" button'}, so a browser tab is needed`); return null; }
    const detectedSel = cfg.pagination.selector || '';
    const visited = new Set([ref.url]);
    // The detected selector may point back ("previous") once the pager re-renders: then use the engine's link finder.
    const linkNext = () => { const c = detectedSel && nextHref(ref, detectedSel); return c && !visited.has(c) ? c : engine().findNextUrl(ref.doc); };
    if (pm === 'next' && !linkNext()) { note(`The Next button on ${hostOf(url)} is a script button, not a link, so a browser tab is needed to page through`); return null; }
    note(`Read ${hostOf(url)} in the background — no tab opened · list: ${cfg.itemSelector}${cfg.preset ? ` (${cfg.preset} preset)` : ''}`);
    if (pm === 'next') { cfg.pagination.selector = detectedSel || 'next-link'; cfg.pagination.redetect = false; } // the link is re-found on every page below
    const r = await runListJob(cfg, {
      call: bgCall(ref),
      clickAndWait: async () => {
        const next = linkNext();
        if (!next || visited.has(next)) return false;
        visited.add(next);
        assertAllowed(next, guard);
        const p = await fetchPage(next);
        if (!p.doc) { note(`Stopped at ${next}: ${p.needsTab}`); return false; }
        ref.doc = p.doc;
        ref.url = p.url;
        note(`Followed Next → ${next}`);
        return true;
      },
      sleep, signal, deadline: callStarted + (internal ? 15 * 60000 : 48000),
    });
    note(`${r.rows.length} rows from ${r.pages} page${r.pages === 1 ? '' : 's'}`);
    return { ...r, url: r.url || ref.url, itemSelector: cfg.itemSelector };
  }
  // Fetch a page for a one-shot engine method (quick scan, image list, list detection) or null.
  async function docFor(url) {
    if (browserMode) return null;
    try {
      const page = await fetchPage(url);
      if (page.needsTab) { note(`${hostOf(url)}: ${page.needsTab}, so a browser tab is needed`); return null; }
      note(`Read ${hostOf(url)} in the background — no tab opened`);
      return page;
    } catch (e) { if (/^Blocked by PullRows/.test(e?.message)) throw e; note(`Could not read ${hostOf(url)} in the background (${String(e.message || e).slice(0, 80)})`); return null; }
  }
  const tabNote = (r) => (r?.warning && /hidden or covered/.test(r.warning) && !browserMode
    ? { ...r, warning: 'It ran in a background tab, and Chrome pauses lazy loading there, so some items may be missing. Ask again with mode "browser" to run it in a visible tab.' }
    : r);

  // ---------- shared runners (also used by recipe_run) ----------
  async function runList(tabId, cfg) {
    return runListJob(cfg, {
      call: (method, ...a) => call(tabId, method, ...a),
      clickAndWait: (buttonSelector, itemSelector) => sw('clickAndWait', { tabId, buttonSelector, itemSelector }),
      focus: () => (internal || !browserMode ? null : sw('focusTab', { tabId })),
      sleep,
      signal,
      // Claude's client gives up after 60 s; scheduled monitors may take longer (a cut-off run would look like 'gone' rows).
      deadline: callStarted + (internal ? 15 * 60000 : 48000),
      // Give the user 90 s to solve a CAPTCHA / log in (Claude's call is waiting), then stop.
      onBlocked: async () => {
        await sw('focusTab', { tabId }).catch(() => {});
        return waitUntilUnblocked((m, ...a) => call(tabId, m, ...a), { timeoutMs: 90000, sleep, signal });
      },
    });
  }

  const renderInTab = (waitMs) => (url, method, args) => sw('runInNewTab', { url, method, args, waitMs });

  async function runPages(urls, fields, { mode = 'auto', concurrency = 3, waitMs = 1500 } = {}) {
    if (mode !== 'browser' && fields.some((f) => f.builtin?.startsWith('maps_'))) mode = 'browser';
    const rows = new Array(urls.length);
    const io = { fetchDoc, signal, renderInTab: renderInTab(waitMs) };
    await runPool(urls, mode === 'browser' ? Math.min(conc(concurrency), 4) : conc(concurrency), async (url, i) => {
      try {
        const { result: res } = await smartRun(url, 'extractPage', [fields], io, { mode });
        rows[i] = { url, ...Object.fromEntries(res.cols.map((c, k) => [c, res.data[0][k]])) };
      } catch (e) { rows[i] = { url, error: String(e.message || e) }; }
    }, { signal });
    return rows.filter(Boolean);
  }

  async function runContacts(urls, opts) {
    return crawlContacts(urls, { deep: opts.deep ?? true, maxSubpages: Math.min(opts.maxSubpages ?? 5, 20), concurrency: conc(opts.concurrency ?? 4), emailDomainFilter: opts.domain || '', signal, renderInTab: renderInTab(2000) });
  }

  async function runShopify(store, collection, format) {
    const origin = storeOrigin(store);
    if (!origin) throw new Error('Invalid store address');
    assertAllowed(origin, guard);
    if (!(await isShopify(origin))) throw new Error(`${origin} does not look like a Shopify store (no public /products.json).`);
    const products = await fetchProducts(origin, { collection, signal, max: L.shopifyProducts });
    if (products.capped) notes.push(`Free plan: limited to the first ${L.shopifyProducts} products. ${UPGRADE}`);
    return { origin, products, rows: productRows(origin, products, format || 'variants') };
  }

  async function runSitemap(site, { filter = '', maxUrls = 5000, sections = [] } = {}) {
    const url = normalizeUrl(site);
    if (!url) throw new Error('Invalid site');
    const origin = new URL(url).origin;
    assertAllowed(origin, guard);
    const found = await discoverSitemaps(origin, { signal });
    if (!found.length) throw new Error('No sitemap found (checked robots.txt and common locations).');
    const cap = Math.min(maxUrls, L.sitemapUrls, 50000);
    const res = await crawlSitemaps(found, { maxUrls: cap, signal });
    if (res.rows.length >= cap && cap === L.sitemapUrls) notes.push(`Free plan: limited to ${cap} sitemap URLs. ${UPGRADE}`);
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

  const listConfig = (tabId, a) => listConfigWith((m, ...x) => call(tabId, m, ...x), a);
  async function listConfigWith(cx, a) {
    let cfg;
    let presetPagination = null;
    if (a.item_selector) {
      // Pages like Google Maps render their list after load: wait up to 10 s for the first item.
      for (let i = 0; i < (cx.static ? 1 : 20) && !(await cx('countSelector', a.item_selector).catch(() => 0)); i++) await sleep(500);
      const d = await cx('describeSelector', a.item_selector);
      cfg = { itemSelector: a.item_selector, fields: a.fields?.length ? fieldsFromArgs(a.fields) : d.fields };
    } else {
      const cands = await cx('autoDetectListsReady');
      if (!cands.length) throw new Error('No repeating list found on this page. Try browser_screenshot / page_read and pass item_selector.');
      const c = cands[Math.min(a.candidate || 0, cands.length - 1)];
      cfg = { itemSelector: c.itemSelector, fields: a.fields?.length ? fieldsFromArgs(a.fields) : c.fields, preset: c.preset };
      presetPagination = c.pagination || null;
    }
    const p = a.pagination || {};
    let mode = p.mode || (presetPagination ? 'auto' : 'none');
    // A selector chosen by Claude could click anything ("Delete", "Buy now"): only on a site the
    // user approved for actions. The auto-detected Next / Load more button is used otherwise.
    let selector = p.button_selector && actionsHere ? p.button_selector : '';
    if (p.button_selector && !selector) notes.push('pagination.button_selector was ignored because this site is not approved for actions in PullRows Settings; the Next / Load more button was detected automatically instead.');
    let redetect = false;
    if (mode === 'auto' && presetPagination) {
      mode = presetPagination.mode;
      selector = selector || presetPagination.selector || '';
    }
    if (mode === 'auto' || ((mode === 'next' || mode === 'loadmore') && !selector)) {
      const next = mode !== 'loadmore' ? await cx('findNextButton') : null;
      const more = !next && mode !== 'next' ? await cx('findLoadMoreButton') : null;
      mode = next ? 'next' : more ? 'loadmore' : mode === 'auto' ? 'scroll' : 'none';
      selector = next || more || '';
      redetect = !!selector;
    }
    // For scrolling, "pages" are screens: allow plenty of steps; the runner stops when nothing new loads.
    let max = mode === 'scroll' ? Math.min((p.max_pages || 10) * 6, 400) : Math.min(p.max_pages || presetPagination?.max || 5, 500);
    const planMax = mode === 'scroll' ? L.scrollSteps : L.listPages;
    if (max > planMax) { max = planMax; notes.push(`Free plan: ${mode === 'scroll' ? 'scrolling' : 'pagination'} limited to ${planMax} ${mode === 'scroll' ? 'steps' : 'pages'} per run. ${UPGRADE}`); }
    cfg.pagination = { mode, selector, max, delayMs: p.delay_ms ?? settings.delayMs, redetect };
    return cfg;
  }

  let result;
  try {
    result = await runTool();
    // A call that produced nothing (blocked URL, CAPTCHA, network error) does not cost one of the
    // free plan's daily calls.
    if (result?.isError) refund();
    // Show the user what was scraped: a picture of the page goes into the chat with the results.
    // Only possible for a tab the user can see; background tabs and no-tab reads give the trace instead.
    if (SHOT_TOOLS.has(tool) && args.screenshot !== false && usedTab != null && !result?.isError && Date.now() - callStarted < 52000) {
      const img = await screenshotFor(usedTab, sw).catch(() => null);
      if (img) result.content.push(img);
    }
  } catch (e) {
    refund();
    throw e;
  } finally {
    if (!args.keep_tab) for (const id of openedTabs) sw('closeTab', { tabId: id }).catch(() => {});
  }
  const first = result?.content?.[0];
  if (trace.length && first?.type === 'text') {
    let obj = null;
    try { obj = JSON.parse(first.text); } catch { /* plain text reply */ }
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && !obj.how_it_ran) first.text = JSON.stringify({ how_it_ran: trace, ...obj }, null, 1);
  }
  if (notes.length && first?.type === 'text') {
    const uniq = [...new Set(notes)];
    let obj = null;
    try { obj = JSON.parse(first.text); } catch { /* plain text reply */ }
    first.text = obj && typeof obj === 'object' && !Array.isArray(obj)
      ? JSON.stringify({ notes: uniq, ...obj }, null, 1)
      : `${first.text}\n\nNotes:\n${uniq.map((n) => `- ${n}`).join('\n')}`;
  }
  return result;

  // ---------- tools ----------
  async function runTool() {
  switch (tool) {
    case 'browser_tabs':
      return text(await sw('listTabs'));

    case 'browser_open': {
      const t = await sw('open', { url: normalizeUrl(args.url), tabId: args.tab_id, newTab: args.new_tab ?? args.tab_id == null, waitMs: args.wait_ms ?? 1500, active: args.activate === true });
      usedTab = t.tab_id;
      note(args.activate === true ? `Opened ${hostOf(args.url)} and switched to it` : `Opened ${hostOf(args.url)} in a background tab (the user was not switched to it)`);
      return text(t);
    }

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
      if (!actionsHere) {
        throw new Error(settings.mcp?.allowActions
          ? `Clicking and typing are not approved for ${hostOf(args.url || (await sw('tabInfo', { tabId })).url || '')}. The user can add that site under PullRows → Settings → Claude connector → "Sites Claude may act on". (Scrolling and all extraction tools work without it.)`
          : 'Clicking and typing by Claude is turned off. The user can allow it in PullRows → Settings → Claude connector → "Allow actions", then approve this site. (Scrolling and all extraction tools work without it.)');
      }
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
      // The page's own pictures go into the chat alongside the text, so Claude actually sees the
      // page without a tab being opened for a screenshot. max_images: 0 turns it off.
      const wantImages = Math.max(0, Math.min(Number(args.max_images ?? 2) || 0, 6));
      let imgRows = [];
      if (args.url && args.tab_id == null) {
        const target = normalizeUrl(args.url);
        assertAllowed(target, guard);
        // fetchPage, not fetchDoc: it also reads pages that build themselves with JavaScript,
        // via the JSON they ship or their AMP copy.
        const page = await fetchPage(target);
        if (page.needsTab) throw new Error(`Could not read ${hostOf(target)} in the background (${page.needsTab}). Call browser_open first and pass its tab_id, or use mode "browser".`);
        const { doc, url } = page;
        r = args.full_text ? engine().pageText(max, doc) : { ...engine().readable(doc), url };
        meta = unpack(engine().extractPage(META, doc))[0];
        if (wantImages) imgRows = unpack(engine().quick(['images'], {}, doc).results.images);
        note(`Read ${hostOf(url)} in the background — no tab opened`);
      } else {
        const tabId = args.tab_id ?? (await sw('activeTab')).tab_id;
        r = args.full_text ? await call(tabId, 'pageText', max) : await call(tabId, 'readable');
        r.url ??= (await sw('listTabs')).find((t) => t.tab_id === tabId)?.url;
        meta = unpack(await call(tabId, 'extractPage', META))[0];
        if (wantImages) imgRows = unpack((await call(tabId, 'quick', ['images'])).results.images);
      }
      const body = (args.full_text ? r.text : r.markdown) || '';
      const reply = text(`# ${r.title}\nURL: ${r.url || args.url}\n${Object.entries(meta || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${body.slice(0, max)}${body.length > max ? '\n…(truncated)' : ''}`);
      for (const u of wantImages ? pickImages(imgRows, wantImages) : []) {
        if (blockedReason(u, guard)) continue;
        const img = await imageBlock(u, signal).catch(() => null);
        if (img) reply.content.push(img);
      }
      if (reply.content.length > 1) note(`Showed ${reply.content.length - 1} of the page's own images (fetched directly — no tab, no screenshot)`);
      return reply;
    }

    case 'quick_scan': {
      const types = args.types?.length ? args.types : ['emails', 'phones', 'social', 'links'];
      const page = args.url && args.tab_id == null ? await docFor(normalizeUrl(args.url)) : null;
      if (page) {
        const res = engine().quick(types, {}, page.doc);
        const sheets = types.map((t) => sheet(t, unpack(res.results[t])));
        await save(res.title, page.url, 'Claude · Quick Scan', sheets);
        const n = Math.min(args.max_rows_returned || 100, 2000);
        return text({ ran: 'background (no tab)', url: page.url, title: res.title, results: Object.fromEntries(sheets.map((s) => [s.name, { total: s.rows.length, rows: s.rows.slice(0, n) }])) });
      }
      const tabId = await tabFor(args);
      const { res, sheets } = await runQuick(tabId, types);
      await save(res.title, res.url, 'Claude · Quick Scan', sheets);
      const n = Math.min(args.max_rows_returned || 100, 2000);
      return text({ url: res.url, title: res.title, results: Object.fromEntries(sheets.map((s) => [s.name, { total: s.rows.length, rows: s.rows.slice(0, n) }])) });
    }

    case 'list_detect': {
      const page = args.url && args.tab_id == null ? await docFor(normalizeUrl(args.url)) : null;
      const bgc = page ? bgCall({ doc: page.doc, url: page.url }) : null;
      let cands = [];
      if (bgc) { try { cands = await bgc('autoDetectListsReady'); } catch (e) { note(`${String(e.message || e)}; checking the page data`); } }
      const jsonCands = page ? (page.json || engine().jsonLists(page.doc)) : [];
      const asJson = (c, i) => ({ candidate: i, item_selector: `json:${c.path}`, items: c.count, from: `page data (${c.source})`, fields: c.cols, sample_rows: c.rows.slice(0, 3) });
      if (!cands.length && jsonCands.length) {
        note(`${hostOf(page.url)} builds itself with JavaScript, but ships its data as JSON — no tab needed`);
        return text({
          candidates: jsonCands.map(asJson),
          hint: 'These rows come from the data the page itself ships, not from the DOM. Call list_extract with item_selector "json:<path>" — it reads in the background, with no tab and no pagination.',
        });
      }
      const tabId = cands.length ? null : await tabFor(args);
      if (tabId == null && !bgc) throw new Error('No tab');
      const c2 = tabId == null ? bgc : (m, ...x) => call(tabId, m, ...x);
      const list = tabId == null ? cands : await c2('autoDetectListsReady');
      const out = [];
      for (const [i, c] of list.entries()) {
        const sample = await c2('extractList', c);
        out.push({ candidate: i, ...(c.preset ? { preset: c.preset } : {}), item_selector: c.itemSelector, items: c.count, fields: c.fields.map((f) => `${f.name} (${f.attr})`), sample_rows: unpack(sample).slice(0, 3) });
      }
      return text({
        preset: cands[0]?.preset || null,
        candidates: out,
        ...(jsonCands.length ? { json_lists: jsonCands.map(asJson) } : {}),
        next_button: await c2('findNextButton'),
        load_more_button: await c2('findLoadMoreButton'),
        hint: 'Call list_extract with candidate=<n> (or item_selector) and pagination {mode:"auto"|"next"|"loadmore"|"scroll", max_pages}.',
      });
    }

    case 'list_extract': {
      const bg = args.url && args.tab_id == null ? await runListBackground(normalizeUrl(args.url), args) : null;
      if (bg) {
        await save(bg.title, bg.url, 'Claude · List Extractor', [sheet('List', bg.rows)]);
        return rowsReply(bg.rows, args.max_rows_returned, { ran: 'background (no tab)', url: bg.url, item_selector: bg.itemSelector, pages_visited: bg.pages, ...(bg.warning ? { warning: bg.warning } : {}) });
      }
      if (args.mode === 'background') throw new Error(`${trace.at(-1) || 'This page needs a browser tab.'} Ask again with mode "auto" (a background tab, the user is not switched to it) or "browser".`);
      const tabId = await tabFor(args);
      const cfg = await listConfig(tabId, args);
      const r = tabNote(await runList(tabId, cfg));
      await save(r.title, r.url, 'Claude · List Extractor', [sheet('List', r.rows)]);
      return rowsReply(r.rows, args.max_rows_returned, { ran: browserMode ? 'visible tab' : 'background tab', url: r.url, ...(cfg.preset ? { preset: cfg.preset } : {}), item_selector: cfg.itemSelector, pagination: cfg.pagination.mode, pages_visited: r.pages, scroll_steps: r.steps, ...(r.partial ? { items_not_loaded: r.partial } : {}), ...(r.warning ? { warning: r.warning } : {}) });
    }

    case 'page_extract': {
      if (!args.urls?.length) throw new Error('urls is required');
      if (!args.fields?.length) throw new Error('fields is required');
      const fields = args.fields.map((f) => (f.builtin ? { name: f.name, builtin: f.builtin } : { name: f.name, selector: f.selector, attr: f.attr || 'text', multiple: !!f.multiple }));
      const rows = await runPages(urlList(args.urls, L.pageUrls, 'Page Extractor'), fields, { mode: args.mode, concurrency: args.concurrency || settings.concurrency });
      await save(`Pages (${rows.length})`, args.urls[0], 'Claude · Page Extractor', [sheet('Pages', rows)]);
      return rowsReply(rows, args.max_rows_returned);
    }

    // ---------- a whole account: every reel, its numbers, its spoken words ----------
    // Too slow for one tool call, so this starts a background job and hands back its id.
    case 'account_scan': {
      if (!args.account) throw new Error('Give account: a handle like "@nasa" (with platform), or a link to the profile.');
      const acc = resolveAccount(args.account, args.platform || '');
      const asked = Math.max(1, Math.min(Number(args.limit) || 300, 2000));
      const cap = Math.min(asked, L.trendPosts);
      if (cap < asked) notes.push(`Free plan: scanning ${L.trendPosts} posts (asked for ${asked}). ${UPGRADE}`);
      const wantScripts = args.transcripts !== false;
      if (wantScripts && !L.transcripts) notes.push(`Transcripts (the spoken words) are part of PullRows Pro, so this scan collects numbers and captions only. ${UPGRADE}`);

      const job = await startJob({ kind: 'account_scan', title: `${acc.platform} · @${acc.handle}`, target: acc.profile, total: cap }, async (ctx) => {
        // The job outlives this tool call, so it must not borrow the call's abort signal (Claude's
        // client cancels a call it gave up waiting for) and it must not rely on the module-level
        // fetch guard, which the next tool call replaces. Every URL is checked here instead.
        const safe = (fn) => (url, o = {}) => { assertAllowed(url, guard); return fn(url, { ...o, signal: ctx.signal }); };
        const io = {
          sleep,
          fetchDoc: safe(fetchDoc),
          fetchText: safe(fetchText),
          fetchJson: safe(fetchJson),
          postJson: (url, body, o = {}) => { assertAllowed(url, guard); return postJson(url, body, { ...o, signal: ctx.signal }); },
          renderInTab: renderInTab(2500),
          collectPosts: (url, o) => { assertAllowed(url, guard); return sw('collectPosts', { url, steps: o.steps, want: o.want, stepMs: o.stepMs, patience: o.patience, until: o.until }); },
          smartRun: (url, method, a, o) => {
            assertAllowed(url, guard);
            return smartRun(url, method, a, { fetchDoc: safe(fetchDoc), signal: ctx.signal, renderInTab: renderInTab(2500) }, o);
          },
          signal: ctx.signal,
        };
        const r = await scanAccount({
          account: args.account, platform: args.platform || '', limit: cap,
          transcripts: wantScripts && !!L.transcripts, detail: args.detail !== false, rankBy: args.rank_by || 'balanced',
        }, { ...io, progress: ctx.progress, partial: ctx.partial, deadline: 0 });
        // The finished scan lands in the user's Data Table like every other result.
        await save(`Account scan — @${r.account.replace(/^@/, '')}`, r.profile, `Claude · Account scan (${r.platform})`, [
          sheet('Posts', r.rows, ACCOUNT_COLUMNS),
          sheet('Patterns', r.insights, ['insight', 'detail']),
        ]);
        return { rows: r.rows, columns: ACCOUNT_COLUMNS, notes: r.notes, summary: r.summary, insights: r.insights };
      });
      return text({
        job_id: job.id,
        status: 'running',
        account: `@${acc.handle}`,
        platform: acc.platform,
        scanning: acc.pages,
        limit: cap,
        transcripts: wantScripts && !!L.transcripts,
        hint: `This runs in the background and can take many minutes — a long back catalogue is scrolled post by post. Call job_status with job_id "${job.id}" to watch it and to read the rows collected so far; they also appear live in the user's PullRows Data Table. Chrome must stay open and the connector on.`,
      });
    }

    case 'job_status': {
      if (args.action === 'list' || !args.job_id) {
        const all = await listJobs();
        return text({ jobs: all.map((j) => ({ job_id: j.id, kind: j.kind, title: j.title, status: j.status, done: j.done, total: j.total, note: j.note, started: j.startedIso })) });
      }
      if (args.action === 'cancel') {
        const okCancel = await cancelJob(args.job_id);
        return text(okCancel ? { job_id: args.job_id, status: 'cancelled' } : { error: `No job ${args.job_id}` });
      }
      const job = await getJob(args.job_id);
      if (!job) throw new Error(`No job "${args.job_id}". Call job_status with action "list" to see them.`);
      const max = Math.max(0, Math.min(Number(args.max_rows_returned ?? 50), 500));
      const rows = (job.rows || []).slice(0, max);
      return text({
        job_id: job.id, kind: job.kind, title: job.title, status: job.status,
        progress: job.total ? `${job.done} / ${job.total}` : String(job.done || 0),
        note: job.note, ...(job.error ? { error: job.error } : {}),
        started: job.startedIso, rows_collected: (job.rows || []).length,
        columns: job.columns, rows, notes: job.notes,
        ...(job.status === 'running' ? { hint: 'Still working. Ask again in a minute or two; the rows above are what it has so far.' } : {}),
        ...((job.rows || []).length > rows.length ? { note_rows: `Showing ${rows.length} of ${job.rows.length}. All of them are in the user's Data Table.` } : {}),
      });
    }

    // ---------- a reel, shown to Claude ----------
    // Claude reads text and pictures, never video, so a clip is handed over as a storyboard:
    // frames across its length, plus its transcript and its numbers.
    case 'video_frames': {
      const url = normalizeUrl(args.url || '');
      if (!url) throw new Error('Give url: the link to one reel, short, TikTok or video.');
      assertAllowed(url, guard);
      const count = Math.max(1, Math.min(Number(args.count) || 6, 12));
      const { result: post } = await smartRun(url, 'socialPost', [], { fetchDoc, signal, renderInTab: renderInTab(2500) },
        { mode: args.mode === 'browser' ? 'browser' : 'auto', isEmpty: (r) => !r || (!r.caption && r.views === '' && !r.video_url) });
      const info = post || {};
      const shots = [];
      let how = '';
      if (info.video_url) {
        const r = await videoFrames(info.video_url, { count, signal });
        how = `${r.frames.length} frames across ${r.duration}s of the clip (${r.width}×${r.height})`;
        for (const f of r.frames) shots.push({ type: 'image', data: f.data, mimeType: f.mimeType });
        note(how);
      } else if (YT_ID(url)) {
        // YouTube publishes no video file, but it does publish stills per video.
        for (const st of youtubeStills(url).slice(0, count)) {
          const img = await imageBlock(st.url, signal).catch(() => null)
            || (st.fallback ? await imageBlock(st.fallback, signal).catch(() => null) : null);
          if (img) shots.push(img);
        }
        how = `${shots.length} stills YouTube publishes for this video (it serves no video file to download)`;
        note(how);
      } else if (info.thumbnail) {
        const img = await imageBlock(info.thumbnail, signal).catch(() => null);
        if (img) shots.push(img);
        how = 'only the cover image — this page does not say where its video file is';
      }
      let transcript = String(info.transcript || '');
      if (!transcript && info.transcript_url) {
        if (!L.transcripts) notes.push(`The spoken words (transcript) are part of PullRows Pro. ${UPGRADE}`);
        else transcript = await transcriptFor(info, { fetchText, signal }).catch(() => '');
      }
      const reply = text({
        url, platform: info.platform || '', type: info.type || '', author: info.author || '',
        posted: info.posted || '', duration_s: info.duration_s || '',
        caption: info.caption || '', hashtags: info.hashtags || '', music: info.music || '', original_audio: info.original_audio || '',
        views: info.views ?? '', likes: info.likes ?? '', comments: info.comments ?? '', shares: info.shares ?? '', saves: info.saves ?? '',
        transcript: transcript.slice(0, 20000),
        transcript_source: transcript ? 'platform captions' : '',
        video_url: info.video_url || '',
        frames: how || 'no frames could be read',
        hint: transcript
          ? 'The frames below are the clip in order; read them with the transcript to judge the hook, the pacing and the on-screen text.'
          : 'This platform publishes no caption file for this clip, so there is no transcript. The frames below are the clip in order; if you have a transcription tool, pass video_url to it for the spoken words.',
      });
      reply.content.push(...shots.slice(0, count));
      return reply;
    }

    case 'trends_find': {
      if (!args.query && !args.page_url && !args.urls?.length) throw new Error('Give query (topic or #hashtag), page_url, or urls.');
      if (args.page_url) assertAllowed(normalizeUrl(args.page_url), guard);
      const scan = Math.max(5, Math.min(Number(args.scan) || 30, 500));
      if (scan > L.trendPosts) notes.push(`Free plan: scanned ${L.trendPosts} posts (asked for ${scan}). ${UPGRADE}`);
      const wantScripts = args.transcripts !== false;
      if (wantScripts && !L.transcripts && args.transcripts) notes.push(`Transcripts (video scripts) are part of PullRows Pro. ${UPGRADE}`);
      const r = await findTrends({
        platform: args.platform || 'youtube', query: args.query || '', pageUrl: args.page_url ? normalizeUrl(args.page_url) : '',
        urls: args.urls?.length ? urlList(args.urls, L.trendPosts, 'Trend Finder') : [],
        scan: Math.min(scan, L.trendPosts), top: Math.max(1, Math.min(Number(args.top) || 10, 50)), rankBy: args.rank_by || 'trending',
        transcripts: wantScripts && !!L.transcripts, maxAgeDays: Number(args.max_age_days) || 0, minViews: Number(args.min_views) || 0,
      }, {
        fetchDoc, fetchText, fetchJson, signal, sleep, deadline: callStarted + 45000,
        renderInTab: renderInTab(2500),
        collectPosts: (url, o) => sw('collectPosts', { url, steps: o.steps, want: o.want, stepMs: o.stepMs, patience: o.patience, until: o.until }),
      });
      notes.push(...r.notes);
      await save(`Trend Finder — ${args.query || r.source}`, r.source, 'Claude · Trend Finder', [
        sheet(`Top ${r.top.length}`, r.top, TOP_COLUMNS), sheet('All posts', r.ranked, ALL_COLUMNS), sheet('Patterns', r.insights, ['insight', 'detail']),
      ]);
      const trim = (p) => ({ ...Object.fromEntries(TOP_COLUMNS.filter((k) => k !== 'thumbnail').map((k) => [k, p[k] ?? ''])), transcript: String(p.transcript || '').slice(0, 3000) });
      return text({
        source: r.source, scanned: r.scanned, read_in_background: r.via.background, needed_a_tab: r.via.tab,
        top: r.top.map(trim), patterns: r.insights,
        hint: 'Rank = percentile score inside this scan (momentum = views/hour since posting, engagement per view, reach vs followers, views). Use the hooks, transcripts and patterns to explain why these win and to suggest new posts. All posts are in the Data Table (sheet "All posts").',
      });
    }

    case 'site_search': {
      if (!args.site) throw new Error('site is required (a domain like amazon.in, or a URL).');
      if (!args.query) throw new Error('query is required.');
      const target = await searchUrlFor(args.site, args.query, { fetchDoc, signal });
      assertAllowed(target.url, guard);
      if (target.note) notes.push(target.note);
      const extra = { search_url: target.url, found_via: target.how, ...(target.name ? { site: target.name } : {}) };
      // Reddit: its JSON feed is cleaner than the page (and works in the background).
      if (/(^|\.)reddit\.com$/.test(new URL(target.url).hostname) && !args.item_selector) {
        const json = redditJsonUrl(target.url);
        const posts = await redditCollect(json, Math.min(Number(args.max_rows) || 50, L.trendPosts === Infinity ? 250 : L.trendPosts), { fetchJson, sleep, signal });
        const rows = posts.map((p) => ({ title: p.caption.split('\n')[0], url: p.url, subreddit: p.community, upvotes: p.likes, comments: p.comments, author: p.author, posted: p.posted, type: p.type }));
        await save(`Reddit: ${args.query}`, target.url, 'Claude · Site search', [sheet('Posts', rows)]);
        return rowsReply(rows, args.max_rows_returned, extra);
      }
      const pages = Math.max(1, Math.min(Number(args.max_pages) || 1, 50));
      const listArgs = { item_selector: args.item_selector, fields: args.fields, candidate: args.candidate, pagination: { ...(args.pagination || {}), mode: args.pagination?.mode || (pages > 1 ? 'auto' : 'none'), max_pages: pages } };
      const bg = await runListBackground(target.url, listArgs);
      if (bg) {
        await save(`${args.query} — ${new URL(target.url).hostname}`, bg.url, 'Claude · Site search', [sheet('Results', bg.rows)]);
        return rowsReply(bg.rows, args.max_rows_returned, { ...extra, ran: 'background (no tab)', url: bg.url, item_selector: bg.itemSelector, pages_visited: bg.pages, ...(bg.warning ? { warning: bg.warning } : {}) });
      }
      const tabId = await tabFor({ url: target.url, wait_ms: args.wait_ms ?? 2000, activate: args.activate });
      const cfg = await listConfig(tabId, listArgs);
      const r = tabNote(await runList(tabId, cfg));
      await save(`${args.query} — ${new URL(target.url).hostname}`, r.url, 'Claude · Site search', [sheet('Results', r.rows)]);
      return rowsReply(r.rows, args.max_rows_returned, { ...extra, ran: browserMode ? 'visible tab' : 'background tab', url: r.url, ...(cfg.preset ? { preset: cfg.preset } : {}), item_selector: cfg.itemSelector, pagination: cfg.pagination.mode, pages_visited: r.pages, ...(r.warning ? { warning: r.warning } : {}) });
    }

    case 'post_details': {
      const list = urlList(args.urls?.length ? args.urls : [args.url].filter(Boolean), L.trendPosts, 'post_details');
      if (!list.length) throw new Error('url or urls is required');
      const io = { fetchDoc, signal, renderInTab: renderInTab(2500) };
      const rows = new Array(list.length);
      await runPool(list, 3, async (url, i) => {
        try {
          const { result, via } = await smartRun(url, 'socialPost', [], io, { isEmpty: (x) => !x || (x.views === '' && x.likes === '') });
          rows[i] = { ...(result || { url }), read: via };
        } catch (e) { rows[i] = { url, error: String(e.message || e) }; }
      }, { signal });
      for (const p of rows) {
        if (p?.platform === 'reddit' && args.comments !== false) p.top_comments = await redditComments(p.url, { fetchJson, signal }, { max: 10 }).then((c) => c.map((x) => `${x.author} (${x.upvotes}): ${x.text}`).join('\n')).catch(() => '');
        if (args.transcript !== false && L.transcripts && p?.transcript_url) {
          const u = /timedtext/.test(p.transcript_url) && !/[?&]fmt=/.test(p.transcript_url) ? `${p.transcript_url}&fmt=json3` : p.transcript_url;
          p.transcript = await fetchText(u, { signal }).then((t) => captionsToText(t).slice(0, 20000)).catch(() => '');
        }
      }
      await save(`Post details — ${rows.length}`, list[0], 'Claude · Post details', [sheet('Posts', rows)]);
      return rowsReply(rows, args.max_rows_returned || 50);
    }

    case 'find_emails': {
      if (!args.urls?.length) throw new Error('urls is required');
      const res = await runContacts(urlList(args.urls, L.contactSites, 'the email finder'), { deep: args.deep, maxSubpages: args.max_subpages });
      const sheets = [sheet('Emails', res.emails, ['site', 'email', 'found_on', 'source'])];
      if (args.include_phones) sheets.push(sheet('Phones', res.phones, ['site', 'phone', 'found_on']));
      await save(`Emails from ${args.urls.length} sites`, args.urls[0], 'Claude · Email Extractor', sheets);
      return rowsReply(res.emails, args.max_rows_returned, { ...(args.include_phones ? { phones: res.phones.slice(0, 200) } : {}), failed: res.failures });
    }

    case 'find_social_links': {
      if (!args.urls?.length) throw new Error('urls is required');
      const res = await runContacts(urlList(args.urls, L.contactSites, 'the social link finder'), { deep: args.deep });
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
      const page = args.url && args.tab_id == null ? await docFor(normalizeUrl(args.url)) : null;
      let res = page ? engine().quick(['images'], {}, page.doc) : null;
      if (res && !unpack(res.results.images).length) { note('No images in the plain HTML; looking again in a background tab'); res = null; }
      if (!res) {
        const tabId = await tabFor(args);
        if (args.scroll ?? true) await call(tabId, 'autoScroll', { maxSteps: 15, pauseMs: 600 });
        res = await call(tabId, 'quick', ['images']);
      }
      const minW = args.min_width ?? 100;
      const minH = args.min_height ?? 100;
      const rows = unpack(res.results.images).filter((r) => (!Number(r.width) || Number(r.width) >= minW) && (!Number(r.height) || Number(r.height) >= minH));
      await save(`Images — ${res.title}`, res.url, 'Claude · Image Downloader', [sheet('Images', rows)]);
      return rowsReply(rows, args.max_rows_returned ?? 200);
    }

    case 'images_download':
      return text(await sw('download', { urls: (args.urls || []).filter((u) => /^https?:/i.test(u)).slice(0, Math.min(L.images, 200)), folder: args.folder || 'claude' }));

    case 'data_table_read': {
      const d = await sw('getDataset');
      if (!d?.sheets?.length) return text({ empty: true, note: 'The Data Table is empty.' });
      const s = (args.sheet && d.sheets.find((x) => x.name === args.sheet)) || d.sheets[d.active || 0] || d.sheets[0];
      const off = args.offset || 0;
      const lim = Math.min(args.limit || 100, 2000);
      return text({ title: d.title, source: d.source, url: d.url, sheets: d.sheets.map((x) => `${x.name} (${x.rows.length})`), sheet: s.name, columns: s.cols, total_rows: s.rows.length, offset: off, rows: s.rows.slice(off, off + lim).map((r) => Object.fromEntries(s.cols.map((c) => [c, r[c] ?? '']))) });
    }

    case 'recipes_list': {
      const list = (await sw('getRecipes')) || [];
      return text(list.map((r) => ({ recipe_id: r.id, name: r.name, tool: r.tool, start_page: r.url || '', updated: new Date(r.updated || r.created).toISOString() })));
    }

    case 'monitors_list': {
      const list = (await sw('monitors')) || [];
      return text(list.length ? list.map((m) => ({ monitor_id: m.id, name: m.name, recipe_id: m.recipeId, every_minutes: m.everyMinutes, alert_on: m.alertOn, paused: !!m.paused,
        last_run: m.lastRunAt ? new Date(m.lastRunAt).toISOString() : null, last_result: m.lastSummary || '', recent_runs: (m.runs || []).map((r) => ({ at: new Date(r.at).toISOString(), summary: r.summary })) }))
        : { monitors: [], note: 'No monitors yet. Use monitor_create to watch a page (new items, price drops).' });
    }

    case 'monitor_create': {
      let recipeId = args.recipe_id;
      if (!recipeId) {
        // Watch a list page directly: resolve the list now (in a background tab), save it as a recipe.
        if (!args.url) throw new Error('Give recipe_id (from recipes_list) or the url of a list page to watch.');
        const url = normalizeUrl(args.url);
        assertAllowed(url, guard);
        const recipes = (await sw('getRecipes')) || [];
        if (recipes.length >= L.recipes) throw new Error(`The free plan keeps ${L.recipes} saved recipes and a monitor needs one. ${UPGRADE}`);
        const tabId = (await sw('open', { url, newTab: true, waitMs: 1500, active: false })).tab_id;
        let cfg;
        try { cfg = await listConfig(tabId, args); } finally { sw('closeTab', { tabId }).catch(() => {}); }
        const name = String(args.name || `Watch ${new URL(url).host}`).slice(0, 80);
        recipeId = (await sw('saveRecipe', { name, tool: 'list', url, config: { itemSelector: cfg.itemSelector, fields: cfg.fields, pagination: cfg.pagination } })).id;
      }
      const every = Number(args.every_minutes) || 1440;
      const mon = await sw('monitorCreate', { recipeId, everyMinutes: every, alertOn: args.alert_on || 'any' });
      if (mon.everyMinutes > every) notes.push(`Free plan monitors run at most daily. ${UPGRADE}`);
      return text({ monitor_id: mon.id, name: mon.name, recipe_id: mon.recipeId, every_minutes: mon.everyMinutes, alert_on: mon.alertOn,
        note: 'The first run (baseline) is running now in the background. After each later run the user gets a Chrome notification when something changes; rows and changes are saved in PullRows History. Chrome must be open for scheduled runs.' });
    }

    case 'recipe_run': {
      const list = (await sw('getRecipes')) || [];
      const r = list.find((x) => x.id === args.recipe_id || x.name === args.recipe_id);
      if (!r) throw new Error(`No recipe "${args.recipe_id}". Use recipes_list.`);
      const c = r.config || {};
      const max = args.max_rows_returned;
      let opened = null;
      const pageTab = async () => {
        if (!r.url) { if (internal) throw new Error('This recipe has no start page, so it can\'t run on a schedule. Edit it and add one.'); return (await sw('activeTab')).tab_id; }
        opened = (await sw('open', { url: r.url, newTab: true, waitMs: 1500, active: !internal })).tab_id;
        return opened;
      };
      try {
      const done = async (rows, name, extra) => { await save(r.name, r.url || '', `Claude · Recipe: ${r.name}`, [sheet(name, rows)]); return rowsReply(rows, max, extra); };
      switch (r.tool) {
        case 'list': {
          const tabId = await pageTab();
          const pg = { ...(c.pagination || { mode: 'none' }) };
          const planMax = pg.mode === 'scroll' ? L.scrollSteps : L.listPages;
          if (pg.mode && pg.mode !== 'none' && (pg.max || 0) > planMax) { pg.max = planMax; notes.push(`Free plan: limited to ${planMax} ${pg.mode === 'scroll' ? 'scroll steps' : 'pages'}. ${UPGRADE}`); }
          const res = await runList(tabId, { itemSelector: c.itemSelector, fields: (c.fields || []).filter((f) => f.enabled !== false), pagination: pg });
          return done(res.rows, 'List');
        }
        case 'page': return done(await runPages(urlList(c.urls, L.pageUrls, 'Page Extractor'), c.fields || [], { mode: c.mode, concurrency: c.concurrency, waitMs: c.waitMs }), 'Pages');
        case 'email': return done((await runContacts(urlList(c.urls, L.contactSites, 'the email finder'), c)).emails, 'Emails');
        case 'social': return done((await runContacts(urlList(c.urls, L.contactSites, 'the social link finder'), c)).socials.filter((s) => !c.platforms || c.platforms.includes(s.platform)), 'Social links');
        case 'shopify': return done((await runShopify(c.store, c.collection, c.format)).rows, 'Products');
        case 'sitemap': return done((await runSitemap(c.site, c)).rows, 'URLs');
        case 'quick': {
          const tabId = await pageTab();
          const { res, sheets } = await runQuick(tabId, c.types || [], c);
          await save(r.name, res.url, `Claude · Recipe: ${r.name}`, sheets);
          return text(Object.fromEntries(sheets.map((s) => [s.name, { total: s.rows.length, rows: s.rows.slice(0, max || 100) }])));
        }
        case 'text': {
          const urls = urlList(c.urls, L.textUrls, 'Page Text');
          const rows = await runPool(urls, 3, async (u) => { const { doc, url } = await fetchDoc(u, { signal }); const x = engine().readable(doc); return { url, title: x.title, words: x.words, markdown: x.markdown }; }, { signal });
          return done(rows.map((x, i) => (x.ok ? x.value : { url: urls[i], error: x.error })), 'Text');
        }
        default:
          throw new Error(`Recipes of type "${r.tool}" can't be run by Claude yet — run it from the side panel.`);
      }
      } finally {
        if (internal && opened != null) sw('closeTab', { tabId: opened }).catch(() => {});
      }
    }

    default:
      throw new Error(`Unknown tool ${tool}`);
  }
  }
}
