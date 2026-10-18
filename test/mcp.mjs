// End-to-end test of the Claude connector: relay server + extension + an MCP client acting as Claude.
//
//   NODE_PATH=$(npm root -g) node test/mcp.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';
import { prepareExtension, enableConnector } from './setup.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// ---------- relay ----------
const RELAY_PORT = 20000 + Math.floor(Math.random() * 20000);
const relay = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-relay.mjs')], { env: { ...process.env, PORT: String(RELAY_PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => relay.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); }));
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;

const { server, base: BASE } = await startServer();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wse-mcp-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium', headless: true, viewport: { width: 1000, height: 800 },
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});

let failures = 0;
async function step(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${String(e.message).split('\n').slice(0, 6).join('\n    ')}`); }
}

// ---------- MCP client (what Claude does) ----------
let MCP;
let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}
async function tool(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.isError) throw new Error(`${name} → ${r.content.map((c) => c.text).join(' ')}`);
  const t = r.content.find((c) => c.type === 'text')?.text;
  try { return { ...r, json: JSON.parse(t) }; } catch { return { ...r, text: t }; }
}

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  console.log(`Extension ${extId} · relay ${RELAY} · fixtures ${BASE}`);
  await prepareExtension(ctx, sw, { mcp: { allowLocal: true, allowActions: true, allowDownloads: true } });
  const sp = await ctx.newPage();
  await sp.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);

  await step('connector: enable in Settings → status Connected, link shown', async () => {
    MCP = await enableConnector(sp, RELAY);
    await sp.setViewportSize({ width: 420, height: 760 });
    await sp.screenshot({ path: path.join(ROOT, 'test', 'connector.png') });
    console.log(`    MCP link: ${MCP.replace(/\/mcp\/.{6}.*/, '/mcp/******')}`);
    assert.match(MCP, new RegExp(`^${RELAY}/mcp/[A-Za-z0-9_-]{32}$`));
  });

  await step('Test connection: browser connected, Claude not yet using this link', async () => {
    await sp.click('#mcp-test-btn');
    await sp.waitForFunction(() => /^[✓✗]/.test(document.getElementById('mcp-test').textContent), null, { timeout: 15000 });
    const t = await sp.textContent('#mcp-test');
    console.log(`    ${t.slice(0, 90)}…`);
    assert.match(t, /^✓ This browser is connected\. Claude hasn’t used this link/);
  });

  await step('MCP handshake: initialize + tools/list', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-claude', version: '1' } });
    assert.equal(init.serverInfo.name, 'pullrows');
    const { tools } = await rpc('tools/list');
    assert.ok(tools.length >= 18);
  });

  await step('Test connection after Claude used the link: "Connected end to end"', async () => {
    await sp.click('#mcp-test-btn');
    await sp.waitForFunction(() => /Connected end to end/.test(document.getElementById('mcp-test').textContent), null, { timeout: 15000 });
  });

  await step('An old / unknown link tells Claude the link may have changed', async () => {
    const res = await fetch(MCP.replace(/[^/]{32}$/, 'A'.repeat(32)), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_tabs', arguments: {} } }) });
    const text = (await res.json()).result.content[0].text;
    assert.match(text, /link changed/);
  });

  let tabId;
  await step('browser_open (new tab) + browser_tabs', async () => {
    const r = await tool('browser_open', { url: `${BASE}/catalog.html`, new_tab: true, wait_ms: 500 });
    tabId = r.json.tab_id;
    assert.equal(r.json.title, 'Catalog');
    const tabs = await tool('browser_tabs');
    assert.ok(tabs.json.some((t) => t.tab_id === tabId));
  });

  await step('list_detect finds the product grid + Next button', async () => {
    const r = await tool('list_detect', { tab_id: tabId });
    const c = r.json.candidates[0];
    console.log(`    ${c.item_selector} · ${c.items} items · ${c.fields.join(', ')}`);
    assert.equal(c.items, 10);
    assert.equal(r.json.next_button, '#next');
  });

  await step('list_extract with auto pagination → 25 rows', async () => {
    const r = await tool('list_extract', { tab_id: tabId, pagination: { mode: 'auto', max_pages: 5, delay_ms: 0 }, max_rows_returned: 3 });
    assert.equal(r.json.total_rows, 25);
    assert.equal(r.json.rows.length, 3);
    assert.ok(r.json.columns.includes('price'));
  });

  await step('side panel Data Table shows Claude’s results live', async () => {
    await sp.locator('#back').click();
    await sp.waitForFunction(() => /25 rows/.test(document.querySelector('.table-banner')?.textContent || ''), null, { timeout: 5000 });
  });

  await step('list_extract with custom item_selector + fields', async () => {
    await tool('browser_open', { url: `${BASE}/shop-1.html`, tab_id: tabId, wait_ms: 200 });
    const r = await tool('list_extract', { tab_id: tabId, item_selector: '.product-card', fields: [{ name: 'title', selector: 'h2' }, { name: 'price', selector: '.price' }, { name: 'link', selector: 'a', attr: 'href' }] });
    assert.deepEqual(r.json.columns, ['title', 'price', 'link']);
    assert.equal(r.json.rows[1].price, '€1,299.00');
  });

  await step('page_extract: selectors + built-ins over 3 URLs', async () => {
    const r = await tool('page_extract', { urls: [1, 2, 3].map((i) => `${BASE}/p/item-${i}.html`), fields: [{ name: 'sku', selector: '.sku' }, { name: 'title', builtin: 'title' }, { name: 'price', builtin: 'price' }] });
    assert.equal(r.json.total_rows, 3);
    assert.equal(r.json.rows[2].sku, 'SKU-003');
    assert.equal(r.json.rows[0].price, '11.00');
  });

  await step('find_emails + find_social_links (deep crawl)', async () => {
    const e = await tool('find_emails', { urls: [`${BASE}/catalog.html`] });
    assert.deepEqual(e.json.rows.map((x) => x.email).sort(), ['jobs@demoshop.example', 'press@demoshop.example', 'support@demoshop.example']);
    const s = await tool('find_social_links', { urls: [`${BASE}/catalog.html`] });
    assert.deepEqual(s.json.rows.map((x) => x.platform).sort(), ['Instagram', 'YouTube']);
  });

  await step('shopify_products + sitemap_urls', async () => {
    const shop = await tool('shopify_products', { store: BASE });
    assert.equal(shop.json.total_rows, 6);
    const sm = await tool('sitemap_urls', { site: BASE, filter: '/p/' });
    assert.equal(sm.json.total_rows, 3);
  });

  await step('page_read (fetched URL and open tab) + quick_scan', async () => {
    const a = await tool('page_read', { url: `${BASE}/about.html` });
    assert.match(a.text, /^# About\n/);
    assert.ok(a.text.includes('We are a demo shop'));
    const b = await tool('page_read', { tab_id: tabId });
    assert.ok(b.text.includes('Demo Shop'));
    const q = await tool('quick_scan', { tab_id: tabId, types: ['emails', 'phones'] });
    assert.equal(q.json.results.emails.total, 3);
  });

  await step('page_action click + browser_screenshot', async () => {
    await tool('browser_open', { url: `${BASE}/catalog.html`, tab_id: tabId, wait_ms: 200 });
    const c = await tool('page_action', { tab_id: tabId, action: 'click', selector: '#next' });
    assert.equal(c.json.ok, true);
    const shot = await rpc('tools/call', { name: 'browser_screenshot', arguments: { tab_id: tabId } });
    const img = shot.content.find((x) => x.type === 'image');
    assert.ok(img && img.data.length > 1000 && img.mimeType === 'image/jpeg', JSON.stringify(shot).slice(0, 200));
  });

  await step('data_table_read + recipes_list + recipe_run', async () => {
    const d = await tool('data_table_read', { limit: 2 });
    assert.equal(d.json.rows.length, 2);
    await sp.evaluate(async (base) => {
      await chrome.storage.local.set({ recipes: [{ id: 'r1', name: 'Jobs board', tool: 'list', url: `${base}/loadmore.html`, created: Date.now(),
        config: { itemSelector: 'li.job', fields: [{ name: 'title', path: ':scope > h4.job-title', idx: 0, attr: 'text' }, { name: 'company', path: ':scope > span.company', idx: 0, attr: 'text' }], pagination: { mode: 'loadmore', selector: '#more', max: 10, delayMs: 0 } } }] });
    }, BASE);
    const list = await tool('recipes_list');
    assert.equal(list.json[0].recipe_id, 'r1');
    const run = await tool('recipe_run', { recipe_id: 'r1', max_rows_returned: 2 });
    assert.equal(run.json.total_rows, 24);
  });

  await step('errors are reported to Claude, not thrown', async () => {
    const r = await rpc('tools/call', { name: 'shopify_products', arguments: { store: 'http://127.0.0.1:1' } });
    assert.ok(r.isError && /Shopify|Error/.test(r.content[0].text));
  });

  await step('safety: blocked sites, read-only mode and free-plan limit', async () => {
    const setMcp = (patch) => sp.evaluate(async (p) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, mcp: { ...settings.mcp, ...p } } });
    }, patch);
    const raw = async (name, args) => (await rpc('tools/call', { name, arguments: args }));
    const textOf = (r) => r.content.map((c) => c.text).join(' ');

    await setMcp({ allowActions: false });
    let r = await raw('page_action', { tab_id: tabId, action: 'click', selector: '#next' });
    assert.ok(r.isError && /Allow actions/.test(textOf(r)), `click allowed in read-only mode: ${textOf(r)}`);

    await setMcp({ allowLocal: false });
    r = await raw('browser_open', { url: `${BASE}/catalog.html` });
    assert.ok(r.isError && /local-network/.test(textOf(r)), `local page not blocked: ${textOf(r)}`);
    r = await raw('page_read', { url: 'https://mail.google.com/mail/u/0/' });
    assert.ok(r.isError && /blocked/.test(textOf(r)), `sensitive site not blocked: ${textOf(r)}`);
    const tabs = (await tool('browser_tabs')).json;
    assert.ok(!tabs.some((t) => t.url.startsWith(BASE)), 'blocked tabs are hidden from browser_tabs');
    await setMcp({ allowLocal: true, allowActions: true });

    await sp.evaluate(() => chrome.storage.local.set({ license: { plan: 'free' }, usage: { day: new Date().toISOString().slice(0, 10), mcp: 25 } }));
    r = await raw('browser_tabs', {});
    assert.ok(r.isError && /free plan/i.test(textOf(r)), `daily limit not enforced: ${textOf(r)}`);
    await sp.evaluate(() => chrome.storage.local.set({ usage: { day: new Date().toISOString().slice(0, 10), mcp: 0 } }));
    const lim = (await tool('list_extract', { url: `${BASE}/catalog.html`, pagination: { mode: 'next', max_pages: 50, delay_ms: 50 } })).json;
    assert.ok(lim.pages_visited <= 10, `free plan visited ${lim.pages_visited} pages`);
    await sp.evaluate(() => chrome.storage.local.set({ license: { plan: 'pro', key: 'TEST-LICENSE-KEY', instanceId: 'lki_test', validatedAt: Date.now(), status: 'active' } }));
  });

  await step('activity log is visible in Settings', async () => {
    await sp.getByRole('button', { name: /Settings/ }).click();
    await sp.waitForFunction(() => document.querySelectorAll('.mini-log li').length >= 5);
  });

  await step('turning the connector off disconnects the browser', async () => {
    await sp.uncheck('#mcp-enabled');
    await new Promise((r) => setTimeout(r, 1500));
    const r = await rpc('tools/call', { name: 'browser_tabs', arguments: {} });
    // the bridge may still be mid-poll once; the next call must fail fast
    const r2 = r.isError ? r : await rpc('tools/call', { name: 'browser_tabs', arguments: {} });
    assert.ok(r2.isError, 'expected "not connected" error');
  });
} finally {
  await ctx.close();
  server.close();
  relay.kill();
}
console.log(failures ? `\n${failures} step(s) failed` : '\nAll steps passed');
process.exit(failures ? 1 : 0);
