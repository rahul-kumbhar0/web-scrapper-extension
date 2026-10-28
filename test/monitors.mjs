// Monitors: a saved recipe re-run in the background, compared with the previous run (new rows,
// gone rows, price drops), with History entries, badge and plan limits. Also the Google Sheets
// push (against a fake Apps Script endpoint is not possible — script.google.com only — so the URL
// check and formula neutralising are unit-tested) and the MCP monitor tools' schemas.
//
//   NODE_PATH=$(npm root -g) node test/monitors.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { prepareExtension } from './setup.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
async function step(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${String(e.stack || e.message).split('\n').slice(0, 6).join('\n    ')}`); }
}

// ---------- unit: diff ----------
globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
const { diffRows, shouldAlert, recordRun } = await import('../lib/monitor.js');
const { isSheetUrl, sheetRows } = await import('../lib/sheets.js');
const { TOOLS } = await import('../server/tools.mjs');

await step('diff: price drop, rise, new, gone, changed text', () => {
  const a = [
    { name: 'Mug', link: 'https://s.test/p/1', price: '$20.00', stock: 'In stock' },
    { name: 'Lamp', link: 'https://s.test/p/2', price: '$50.00', stock: 'In stock' },
    { name: 'Desk', link: 'https://s.test/p/3', price: '₹1,999', stock: 'In stock' },
  ];
  const b = [
    { name: 'Mug', link: 'https://s.test/p/1', price: '$15.00', stock: 'In stock' },
    { name: 'Lamp', link: 'https://s.test/p/2', price: '$55.00', stock: 'Only 2 left' },
    { name: 'Chair', link: 'https://s.test/p/4', price: '$80.00', stock: 'In stock' },
  ];
  const first = diffRows(null, a);
  assert.equal(first.first, true);
  assert.equal(shouldAlert(first, 'any'), false);
  const d = diffRows(a, b);
  assert.equal(d.key, 'link');
  assert.deepEqual([d.added.length, d.removed.length, d.changed.length, d.drops.length, d.rises.length], [1, 1, 2, 1, 1]);
  assert.equal(d.drops[0].pct, -25);
  assert.match(d.summary, /1 new, 1 gone, 2 changed, 1 price drop, 1 price rise · biggest drop: Mug \$20\.00 → \$15\.00 \(-25%\)/);
  assert.ok(d.rows.some((r) => r.change === 'changed' && r.column === 'stock' && r.after === 'Only 2 left'));
  assert.equal(shouldAlert(d, 'drops'), true);
  assert.equal(shouldAlert(diffRows(b, b), 'any'), false);
  assert.equal(diffRows(b, b).summary, 'No changes.');
  const mon = recordRun({ id: 'x', alertOn: 'drops', runs: [] }, { rows: b, diff: d });
  assert.equal(mon.unseen, 1);
  assert.equal(mon.lastRows.length, 3);
  const failed = recordRun(mon, { rows: [], diff: null, error: 'boom' });
  assert.equal(failed.lastRows.length, 3, 'a failed run keeps the last good rows');
  assert.equal(failed.lastOk, false);
});

await step('diff: rows without a link column are keyed by a unique column, then whole row', () => {
  const d = diffRows([{ sku: 'A1', price: '10' }, { sku: 'B2', price: '20' }], [{ sku: 'A1', price: '9' }, { sku: 'B2', price: '20' }]);
  assert.equal(d.key, 'sku');
  assert.equal(d.drops.length, 1, 'price column name makes plain numbers count as money');
  const w = diffRows([{ t: 'x' }, { t: 'x' }], [{ t: 'x' }, { t: 'y' }]);
  assert.equal(w.key, 't', 'the new run is unique on t');
  assert.equal(w.added.length, 1);
});

await step('Google Sheets: URL check and formula neutralising', () => {
  assert.ok(isSheetUrl('https://script.google.com/macros/s/AKfycbx1234567890abcdefghijklmnop/exec'));
  assert.ok(!isSheetUrl('https://evil.test/macros/s/AKfycbx1234567890abcdefghijklmnop/exec'));
  assert.ok(!isSheetUrl('https://script.google.com/macros/s/AKfycbx1234567890abcdefghijklmnop/dev'));
  const [r] = sheetRows([{ a: '=IMPORTXML("https://x.test","//a")', b: -5, c: '-12.5', d: { x: 1 } }]);
  assert.equal(r.a, '\'=IMPORTXML("https://x.test","//a")');
  assert.equal(r.b, -5);
  assert.equal(r.c, '-12.5');
  assert.equal(r.d, '{"x":1}');
  assert.ok('synced_at' in r);
});

await step('MCP: monitors_list / monitor_create tools are published', () => {
  const c = TOOLS.find((t) => t.name === 'monitor_create');
  assert.ok(c && TOOLS.find((t) => t.name === 'monitors_list'));
  assert.deepEqual(c.inputSchema.properties.alert_on.enum, ['any', 'new', 'drops']);
});
delete globalThis.chrome;

// ---------- live: a shop whose prices change between runs ----------
let products = [
  { id: 1, name: 'Blue Mug', price: 20 },
  { id: 2, name: 'Desk Lamp', price: 50 },
  { id: 3, name: 'Notebook', price: 8 },
  { id: 4, name: 'Pen Set', price: 12 },
];
const shop = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Shop</title><h1>Products</h1><ul class="grid">${products.map((p) => `<li class="product"><a class="title" href="/p/${p.id}">${p.name}</a><span class="price">$${p.price.toFixed(2)}</span><span class="rating">4.${p.id} stars</span></li>`).join('')}</ul>`);
});
await new Promise((r) => shop.listen(0, '127.0.0.1', r));
const SHOP = `http://127.0.0.1:${shop.address().port}/`;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wse-mon-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium', headless: true, viewport: { width: 1000, height: 800 },
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  await prepareExtension(ctx, sw, { pro: false, mcp: { allowLocal: true } });
  const sp = await ctx.newPage();
  await sp.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
  const ask = (type, extra = {}) => sp.evaluate(({ type, extra }) => new Promise((resolve) => chrome.runtime.sendMessage({ type, ...extra }, resolve)), { type, extra });
  const monitors = () => sp.evaluate(async () => (await chrome.storage.local.get('monitors')).monitors || []);

  await sp.evaluate(async (url) => {
    await chrome.storage.local.set({ recipes: [
      { id: 'r-shop', name: 'Shop prices', tool: 'list', url, created: Date.now(), config: { itemSelector: 'li.product', fields: [
        { name: 'title', path: 'a.title', idx: 0, attr: 'text' }, { name: 'link', path: 'a.title', idx: 0, attr: 'href' }, { name: 'price', path: '.price', idx: 0, attr: 'text' }] } },
      { id: 'r-two', name: 'Second', tool: 'list', url, created: Date.now(), config: { itemSelector: 'li.product', fields: [] } },
    ] });
  }, SHOP);

  await step('create: baseline run in the background, alarm scheduled, no tab left open', async () => {
    const tabsBefore = ctx.pages().length;
    const res = await ask('monitor:create', { recipeId: 'r-shop', everyMinutes: 60, alertOn: 'any' });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.ok.everyMinutes, 1440, 'free plan: hourly is raised to daily');
    let m;
    for (let i = 0; i < 60 && !(m = (await monitors())[0])?.lastRunAt; i++) await sp.waitForTimeout(500);
    assert.equal(m.lastOk, true, m.lastSummary);
    assert.match(m.lastSummary, /First run: 4 rows/);
    assert.equal(m.key, 'link');
    const alarms = await sp.evaluate(() => chrome.alarms.getAll());
    assert.ok(alarms.some((a) => a.name === `monitor:${m.id}` && a.periodInMinutes === 1440));
    await sp.waitForTimeout(500);
    assert.equal(ctx.pages().length, tabsBefore, 'the background tab was closed');
    const offscreen = await sp.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
    assert.equal(offscreen.length, 1);
    assert.ok(!offscreen[0].documentUrl.includes('token='), 'connector is off: runner only');
  });

  await step('free plan: a second monitor is refused with an upgrade message', async () => {
    const res = await ask('monitor:create', { recipeId: 'r-two', everyMinutes: 1440 });
    assert.match(res.err || '', /free plan includes 1 monitor/);
  });

  await step('run now after a price drop + a new product → changes, History, badge', async () => {
    products = [{ ...products[0], price: 15 }, products[1], products[2], { id: 5, name: 'Desk Chair', price: 80 }];
    const [m] = await monitors();
    const res = await ask('monitor:run', { id: m.id });
    assert.ok(res.ok);
    const [after] = await monitors();
    console.log(`    ${after.lastSummary}`);
    assert.match(after.lastSummary, /1 new, 1 gone, 1 changed, 1 price drop · biggest drop: Blue Mug \$20\.00 → \$15\.00 \(-25%\)/);
    assert.equal(after.unseen, 1);
    assert.equal(after.runs.length, 2);
    const hist = await sp.evaluate(async () => (await chrome.storage.local.get('history')).history || []);
    const h = hist.find((x) => x.source === 'Monitor' && /price drop/.test(x.title));
    assert.ok(h, 'history entry');
    assert.equal(h.results.Rows.length, 4);
    assert.ok(h.results.Changes.some((r) => r.change === 'price down' && r.percent === -25));
    const badge = await sp.evaluate(() => chrome.action.getBadgeText({}));
    assert.equal(badge, '1');
  });

  await step('Monitors view lists it; opening it clears the badge; pause removes the alarm', async () => {
    await sp.reload();
    await sp.getByRole('button', { name: 'Monitors' }).click();
    await sp.waitForSelector('.item-list li .title');
    const text = await sp.textContent('.item-list');
    assert.match(text, /Shop prices/);
    assert.match(text, /price drop/);
    await sp.setViewportSize({ width: 420, height: 760 });
    await sp.screenshot({ path: path.join(ROOT, 'test', 'monitors.png') });
    await sp.waitForFunction(() => chrome.action.getBadgeText({}).then((t) => t === ''), null, { timeout: 5000 });
    await sp.getByRole('button', { name: 'Pause' }).click();
    await sp.waitForFunction(async () => !(await chrome.alarms.getAll()).some((a) => a.name.startsWith('monitor:')), null, { timeout: 5000 });
    await sp.getByRole('button', { name: 'Resume' }).click();
    await sp.waitForFunction(async () => (await chrome.alarms.getAll()).some((a) => a.name.startsWith('monitor:')), null, { timeout: 5000 });
  });

  await step('a failing run is recorded and keeps the previous rows', async () => {
    const [m] = await monitors();
    await sp.evaluate(async () => { const { recipes } = await chrome.storage.local.get('recipes'); recipes[0].url = 'http://127.0.0.1:1/'; await chrome.storage.local.set({ recipes }); });
    await ask('monitor:run', { id: m.id });
    const [after] = await monitors();
    assert.equal(after.lastOk, false);
    assert.match(after.lastSummary, /^Failed:/);
    assert.equal(after.lastRows.length, 4);
  });

  await step('delete: monitor, alarm and runner document are gone', async () => {
    const [m] = await monitors();
    await ask('monitor:delete', { id: m.id });
    assert.equal((await monitors()).length, 0);
    const alarms = await sp.evaluate(() => chrome.alarms.getAll());
    assert.ok(!alarms.some((a) => a.name.startsWith('monitor:')));
    await sp.waitForTimeout(300);
    const offscreen = await sp.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
    assert.equal(offscreen.length, 0);
  });

  await step('home: Popular one-tap jobs open the right tool or ask for a search', async () => {
    await sp.reload();
    const pops = await sp.locator('.pop').allTextContents();
    assert.deepEqual(pops, ['Google Maps leads', 'Amazon products & prices', 'LinkedIn jobs', 'Trending Reels & TikToks', 'Emails from websites', 'Price-drop alerts']);
    await sp.locator('.pop', { hasText: 'Price-drop alerts' }).click();
    await sp.waitForFunction(() => document.body.dataset.view === 'monitors');
    await sp.locator('#back').click();
    await sp.locator('.pop', { hasText: 'Trending Reels' }).click();
    await sp.waitForFunction(() => document.body.dataset.view === 'trends');
    await sp.locator('#back').click();
    await sp.locator('.pop', { hasText: 'Google Maps leads' }).click();
    await sp.waitForSelector('dialog[open]');
    assert.match(await sp.textContent('dialog[open]'), /What and where\?/);
    await sp.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
  });

  await step('Data Table: Enrich and Google Sheet buttons are there (Pro-gated enrich)', async () => {
    await sp.evaluate(async () => chrome.storage.local.set({ dataset: { title: 'T', url: '', source: 'x', sheets: [{ name: 'S', cols: ['company'], rows: [{ company: 'Stripe' }] }], active: 0 } }));
    await sp.reload();
    await sp.locator('.table-banner').click();
    await sp.getByRole('button', { name: /Enrich/ }).click();
    await sp.getByRole('menuitem', { name: /Lead score/ }).click();
    await sp.waitForSelector('dialog[open]');
    assert.match(await sp.textContent('dialog[open]'), /AI lead enrichment is part of PullRows Pro/);
    await sp.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
    await sp.getByRole('button', { name: 'Google Sheet' }).click();
    await sp.waitForFunction(() => document.body.dataset.view === 'settings');
    assert.ok(await sp.isVisible('#sheet-url'));
    await sp.fill('#sheet-url', 'https://example.com/exec');
    await sp.click('#sheet-test');
    assert.match(await sp.textContent('#sheet-msg'), /not an Apps Script web app URL/);
  });
} finally {
  await ctx.close();
  shop.close();
}

console.log(failures ? `\n${failures} failed` : '\nAll monitor tests passed');
process.exit(failures ? 1 : 0);
