// End-to-end test: loads the unpacked extension in Chromium, serves local fixture sites and
// drives the real side panel through every tool.
//
//   NODE_PATH=$(npm root -g) node test/e2e.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ONLY = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;

const { server, base: BASE } = await startServer();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wse-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  acceptDownloads: true,
  viewport: { width: 420, height: 900 },
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});

let failures = 0;
async function step(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name}\n    ${String(e.message).split('\n').slice(0, 8).join('\n    ')}`);
    await sp.screenshot({ path: path.join(ROOT, 'test', `fail-${name.replace(/\W+/g, '-').slice(0, 40)}.png`), fullPage: true }).catch(() => {});
  }
}

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
console.log(`Extension loaded: ${extId} · fixtures at ${BASE}`);

const site = await ctx.newPage();
await site.goto(`${BASE}/catalog.html`);
const sp = await ctx.newPage();
const errors = [];
sp.on('pageerror', (e) => errors.push(e.message));
sp.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(m.text()); });
await sp.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
// The panel targets "the active tab"; here the panel itself is a tab, so point it at the site tab.
const pinSite = () => sp.evaluate(async (base) => {
  const [t] = await chrome.tabs.query({ url: `${base}/*` });
  window.__siteTab = t.id;
  chrome.tabs.query = async () => [await chrome.tabs.get(window.__siteTab)];
}, BASE);
await pinSite();

// ---------- helpers ----------
const clearToast = () => sp.evaluate(() => { const t = document.getElementById('toast'); t.textContent = ''; t.hidden = true; });
const goSite = async (p) => { await site.goto(BASE + p); await site.waitForLoadState('load'); };
const home = async () => { if (await sp.locator('#back').isVisible()) await sp.click('#back'); };
const openTool = async (title) => { await home(); await clearToast(); await sp.locator('.tool-card', { hasText: title }).click(); await sp.waitForSelector(`#title:text("${title}")`); };
const fieldRow = async (name) => sp.locator('.field-row').nth(await sp.evaluate((n) => [...document.querySelectorAll('.field-row input.name-input')].findIndex((i) => i.value === n), name));
const waitMode = (mode) => sp.waitForFunction((m) => document.querySelector('select')?.value === m, mode, { timeout: 10000 });
const waitIdle = (timeout = 60000) => sp.waitForFunction(() => !document.body.classList.contains('is-busy'), null, { timeout });
const toastText = () => sp.locator('#toast').textContent();
const waitToast = (re, timeout = 60000) => sp.waitForFunction((src) => new RegExp(src).test(document.getElementById('toast').textContent), re.source, { timeout });
const btn = (name) => sp.getByRole('button', { name, exact: true });
const tableCols = () => sp.locator('table.data thead th:not(.rownum)').allTextContents();
const tableRowCount = async () => Number((await sp.locator('.pager span').first().textContent()).match(/([\d,]+) rows?/)[1].replace(/,/g, ''));
const tableText = () => sp.locator('table.data').textContent();
const sheetTabs = () => sp.locator('.sheet-tab').allTextContents();
const fillUrls = (urls) => sp.locator('textarea').first().fill(urls.join('\n'));
const dialog = () => sp.locator('dialog[open]');

try {
  await step('home shows all tools', async () => {
    const cards = await sp.locator('.tool-card strong').allTextContents();
    console.log(`    ${cards.join(' · ')}`);
    assert.equal(cards.length, 10);
  });

  await step('settings: save delay 0', async () => {
    await home();
    await sp.getByRole('button', { name: /Settings/ }).click();
    await sp.fill('#delay', '0');
    await sp.click('#save-settings');
    await waitToast(/saved/);
  });

  // ---------------- List Extractor ----------------
  await step('list: auto-detect + JS "Next" pagination → 25 rows', async () => {
    await goSite('/catalog.html');
    await openTool('List Extractor');
    await btn('Auto-detect').click();
    await sp.waitForSelector('.list-summary strong:text("10 items found")');
    await waitMode('next');
    await sp.locator('label:has-text("Max pages") input').fill('5');
    await sp.locator('label:has-text("Delay") input').fill('0');
    await sp.locator('label:has-text("Delay") input').dispatchEvent('change');
    await sp.locator('label:has-text("Max pages") input').dispatchEvent('change');
    await sp.waitForSelector('.preview table');
    await sp.screenshot({ path: path.join(ROOT, 'test', 'list.png'), fullPage: true });
    await btn('Extract list').click();
    await waitToast(/Extracted/);
    const cols = await tableCols();
    console.log(`    columns: ${cols.join(', ')}`);
    assert.equal(await tableRowCount(), 25);
    for (const c of ['name', 'price', 'rating', 'image']) assert.ok(cols.includes(c), `missing column ${c}`);
    assert.ok((await tableText()).includes('Product 25'));
  });

  await step('list: pick one item by clicking it on the page', async () => {
    await goSite('/catalog.html');
    await openTool('List Extractor');
    await sp.getByRole('button', { name: /Pick an item/ }).click();
    await site.waitForTimeout(300);
    await site.hover('.card:nth-child(2) .price');
    await site.click('.card:nth-child(2) .price');
    await sp.waitForSelector('.list-summary strong:text("10 items found")');
    // untick a column, rename another
    await (await fieldRow('rating')).locator('input[type=checkbox]').uncheck();
    const name = (await fieldRow('name')).locator('input.name-input');
    await name.fill('product');
    await name.dispatchEvent('change');
    await btn('Extract list').click();
    await waitToast(/Extracted 10 rows/);
    const cols = await tableCols();
    assert.ok(cols.includes('product') && !cols.includes('rating'), cols.join());
  });

  await step('list: "Load more" button → 24 rows', async () => {
    await goSite('/loadmore.html');
    await openTool('List Extractor');
    await btn('Auto-detect').click();
    await sp.waitForSelector('.list-summary strong:text("8 items found")');
    await waitMode('loadmore');
    await btn('Extract list').click();
    await waitToast(/Extracted 24 rows/);
  });

  await step('list: infinite scroll inside a panel (Maps-style feed) → 30 rows', async () => {
    await goSite('/feed.html');
    await openTool('List Extractor');
    await btn('Auto-detect').click();
    await sp.waitForSelector('.list-summary strong:text("6 items found")');
    await sp.locator('select').first().selectOption('scroll');
    await sp.locator('label:has-text("Max scrolls") input').fill('20');
    await sp.locator('label:has-text("Max scrolls") input').dispatchEvent('change');
    await btn('Extract list').click();
    await waitToast(/Extracted 30 rows/, 90000);
    assert.ok((await tableCols()).includes('rating'));
  });

  await step('list: save recipe, re-run it from Recipes', async () => {
    await goSite('/loadmore.html');
    await openTool('List Extractor');
    await btn('Auto-detect').click();
    await sp.waitForSelector('.list-summary strong:text("8 items found")');
    await btn('Save recipe').click();
    await dialog().locator('input').first().fill('Jobs board');
    await dialog().getByRole('button', { name: 'Save recipe' }).click();
    await waitToast(/Recipe saved/);
    await goSite('/catalog.html'); // recipe must navigate back to its start page
    await home();
    await sp.getByRole('button', { name: /Recipes/ }).click();
    await sp.locator('.item-list li', { hasText: 'Jobs board' }).getByRole('button', { name: /Run/ }).click();
    await waitToast(/Extracted 24 rows/, 60000);
    assert.match(site.url(), /loadmore/);
  });

  // ---------------- Data Table ----------------
  await step('table: rename, sort, edit cell, merge, dedupe, delete row', async () => {
    await home();
    await sp.locator('.table-banner').click();
    await sp.locator('table.data th', { hasText: 'company' }).click();
    await sp.locator('.menu button', { hasText: 'Rename' }).click();
    await dialog().locator('input').fill('employer');
    await dialog().getByRole('button', { name: 'OK' }).click();
    assert.ok((await tableCols()).includes('employer'));

    await sp.locator('table.data th', { hasText: 'job title' }).click();
    await sp.locator('.menu button', { hasText: 'Sort Z → A' }).click();
    assert.equal(await sp.locator('table.data tbody tr').first().locator('td').nth(1).textContent(), 'Engineer 24');

    const cell = sp.locator('table.data tbody tr').first().locator('td').nth(1);
    await cell.dblclick();
    await sp.keyboard.press('Control+A');
    await sp.keyboard.type('Chief Engineer');
    await sp.keyboard.press('Enter');
    assert.equal(await sp.locator('table.data tbody tr').first().locator('td').nth(1).textContent(), 'Chief Engineer');

    await btn('Merge cols').click();
    await dialog().locator('label.check', { hasText: 'employer' }).locator('input').check();
    await dialog().locator('label.check', { hasText: 'location' }).locator('input').check();
    await dialog().locator('label', { hasText: 'New column name' }).locator('input').fill('where');
    await dialog().getByRole('button', { name: 'Merge' }).click();
    assert.ok((await tableText()).includes('Company 4, City 0'));

    await sp.locator('table.data th', { hasText: 'employer' }).click();
    await sp.locator('.menu button', { hasText: 'Remove duplicates by this column' }).click();
    assert.equal(await tableRowCount(), 5);
    await sp.locator('table.data tbody tr').first().hover();
    await sp.locator('table.data tbody tr').first().locator('.row-del').click();
    assert.equal(await tableRowCount(), 4);
  });

  await step('table: exports (CSV, Excel, JSON)', async () => {
    assert.ok(!/\bnull\b/.test(await sp.locator('main').innerText()), 'stray "null" text rendered');
    await sp.screenshot({ path: path.join(ROOT, 'test', 'table.png'), fullPage: true });
    const [csv] = await Promise.all([sp.waitForEvent('download'), btn('CSV').click()]);
    const csvText = fs.readFileSync(await csv.path(), 'utf8');
    assert.match(csvText, /^﻿/);
    assert.ok(csvText.includes('where'));
    const [xlsx] = await Promise.all([sp.waitForEvent('download'), btn('Excel').click()]);
    await xlsx.saveAs(path.join(ROOT, 'test', 'last-export.xlsx'));
    const [json] = await Promise.all([sp.waitForEvent('download'), btn('JSON').click()]);
    const data = JSON.parse(fs.readFileSync(await json.path(), 'utf8'));
    assert.equal(Object.values(data.sheets)[0].length, 4);
  });

  // ---------------- Page Extractor ----------------
  await step('page: picked field + presets over 3 URLs (fast mode)', async () => {
    await goSite('/p/item-1.html');
    await openTool('Page Extractor');
    await fillUrls([1, 2, 3].map((i) => `${BASE}/p/item-${i}.html`));
    await sp.getByRole('button', { name: /Pick field/ }).click();
    await site.waitForTimeout(300);
    await site.hover('.sku');
    await site.click('.sku');
    await waitToast(/Added “sku” = SKU-001/);
    await btn('Page metadata').click();
    await btn('Contacts').click();
    await btn('Test here').click();
    await sp.waitForSelector('.kv dd:text("SKU-001")');
    await btn('Extract pages').click();
    await waitToast(/Done: 3 pages/);
    const t = await tableText();
    for (const v of ['SKU-002', 'SKU-003', 'Great product 3', 'shop2@demoshop.example']) assert.ok(t.includes(v), `missing ${v}`);
    assert.equal((await tableCols())[0], 'url');
  });

  await step('page: browser mode opens each page in a tab', async () => {
    await openTool('Page Extractor');
    await fillUrls([`${BASE}/catalog.html`]);
    await sp.getByRole('button', { name: '+ Built-in' }).click();
    await dialog().locator('label.check', { hasText: /^title$/ }).locator('input').check();
    await dialog().getByRole('button', { name: 'Add' }).click();
    await sp.locator('select').filter({ hasText: 'Browser' }).selectOption('browser');
    await btn('Extract pages').click();
    await waitToast(/Done: 1 page/);
    assert.ok((await tableText()).includes('Catalog'));
  });

  // ---------------- Email / Social ----------------
  await step('email: deep crawl finds protected + obfuscated + plain emails', async () => {
    await openTool('Email Extractor');
    await fillUrls([`${BASE}/catalog.html`]);
    await btn('Find emails').click();
    await waitToast(/Found 3 emails/);
    const t = await tableText();
    const found = (await sp.locator('table.data tbody tr td:nth-child(3)').allTextContents()).sort();
    assert.deepEqual(found, ['jobs@demoshop.example', 'press@demoshop.example', 'support@demoshop.example']);
  });

  await step('social: one row per site with platform columns', async () => {
    await openTool('Social Link Extractor');
    await fillUrls([`${BASE}/catalog.html`]);
    await btn('Find social links').click();
    await waitToast(/Found 2 profiles/);
    const cols = await tableCols();
    assert.ok(cols.includes('Instagram') && cols.includes('YouTube'), cols.join());
    assert.ok(!(await tableText()).includes('sharer'), 'share buttons are not profiles');
  });

  // ---------------- Shopify ----------------
  await step('shopify: check store, export variants + import CSV', async () => {
    await openTool('Shopify Extractor');
    await sp.locator('input[placeholder="store.com"]').fill(BASE);
    await btn('Check').click();
    await sp.waitForSelector('.hint.ok:has-text("Shopify store")');
    await btn('Export products').click();
    await waitToast(/Exported 3 products \(6 rows\)/);
    const cols = await tableCols();
    for (const c of ['title', 'variant', 'sku', 'price', 'available']) assert.ok(cols.includes(c), c);
    await openTool('Shopify Extractor');
    await sp.locator('input[placeholder="store.com"]').fill(BASE);
    await sp.locator('label:has-text("Output") select').selectOption('shopify-csv');
    await clearToast();
    await btn('Export products').click();
    await waitToast(/Exported 3 products/);
    assert.ok((await tableCols()).includes('Variant SKU'));
  });

  // ---------------- Sitemap ----------------
  await step('sitemap: robots.txt → index → .gz, filter, send to Page Extractor', async () => {
    await openTool('Sitemap Explorer');
    await sp.locator('input[placeholder="example.com"]').fill(BASE);
    await btn('Find URLs').click();
    await waitToast(/Found 6 URLs/);
    await sp.locator('label.chip', { hasText: '/p (3)' }).locator('input').check();
    await btn('Page Extractor').click();
    await sp.waitForSelector('#title:text("Page Extractor")');
    const urls = await sp.locator('textarea').first().inputValue();
    assert.equal(urls.split('\n').length, 3);
    assert.ok(urls.includes('/p/item-2.html'));
  });

  // ---------------- Page text ----------------
  await step('text: readable Markdown for current page + many pages', async () => {
    await goSite('/about.html');
    await openTool('Page Text Extractor');
    await btn('Extract text from the current page').click();
    await sp.waitForSelector('.text-preview');
    assert.match(await sp.locator('.text-preview').textContent(), /^# About us/);
    await fillUrls([`${BASE}/about.html`, `${BASE}/p/item-1.html`]);
    await btn('Extract text').click();
    await sp.waitForSelector('#title:text("Data Table")');
    assert.ok((await tableCols()).includes('markdown'));
    assert.equal(await tableRowCount(), 2);
  });

  // ---------------- Images ----------------
  await step('images: find, filter, download selected', async () => {
    await goSite('/shop-1.html');
    await openTool('Image Downloader');
    await sp.locator('label:has-text("Min width") input').fill('0');
    await sp.locator('label:has-text("Min height") input').fill('0');
    await btn('Find images on this page').click();
    await waitToast(/Found \d+ images/);
    const tiles = await sp.locator('.img-tile').count();
    assert.ok(tiles >= 4, `tiles ${tiles}`);
    await btn('Download selected').click();
    await waitToast(/Saved \d+ images/);
    const items = await sp.evaluate(() => new Promise((r) => chrome.downloads.search({}, (d) => r(d.map((x) => ({ url: x.url, filename: x.filename, state: x.state, error: x.error }))))));
    console.log(`    downloads: ${JSON.stringify(items.slice(0, 3))} (${items.length})`);
    assert.ok(items.length >= 4, `downloads started: ${items.length}`);
    assert.equal(items.filter((x) => x.url.includes('/img/') && x.state === 'complete').length, 3);
  });

  // ---------------- Quick scan ----------------
  await step('quick scan: all extractors → one sheet per type', async () => {
    await goSite('/shop-1.html');
    await openTool('Quick Scan');
    for (const label of ['Images', 'Tables', 'Text', 'Prices', 'Pagination']) await sp.locator('label.chip', { hasText: label }).locator('input').check();
    await btn('Scan page').click();
    await waitToast(/Found \d+ items on 1 page/);
    const tabs = await sheetTabs();
    console.log(`    sheets: ${tabs.join(' · ')}`);
    assert.ok(tabs.some((t) => /^Emails3$/.test(t)) && tabs.some((t) => /^Phones2$/.test(t)) && tabs.some((t) => /^Prices3$/.test(t)), tabs.join());
  });

  // ---------------- Claude (mocked API) ----------------
  await step('claude: AI extract, AI column and Ask Claude (mocked API)', async () => {
    await home();
    await sp.getByRole('button', { name: /Settings/ }).click();
    await sp.fill('#api-key', 'sk-ant-test');
    await sp.click('#save-settings');
    await sp.evaluate(() => {
      window.__requests = [];
      const realFetch = window.fetch;
      window.fetch = async (url, init) => {
        if (!String(url).includes('api.anthropic.com')) return realFetch(url, init);
        const body = JSON.parse(init.body);
        window.__requests.push({ headers: init.headers, body });
        const sys = body.system;
        let text;
        if (/new spreadsheet column/.test(sys)) {
          const rows = JSON.parse(body.messages[0].content.split('Rows (JSON):\n')[1]);
          text = JSON.stringify({ results: rows.map((r) => ({ row: r.row, value: `cat-${r.row}` })) });
        } else if (/analyse scraped data/.test(sys)) {
          text = '**Top item:** Product 2\n- cheap\n- popular';
        } else {
          text = JSON.stringify({ columns: ['name', 'price'], rows: [['Alpha Widget', '$49.99'], ['Beta Widget', '€1,299.00']] });
        }
        return new Response(JSON.stringify({ model: body.model, stop_reason: 'end_turn', usage: { input_tokens: 500, output_tokens: 50 }, content: [{ type: 'text', text }] }), { status: 200 });
      };
    });
    await goSite('/shop-1.html');
    await openTool('AI Extract (Claude)');
    await sp.locator('textarea').first().fill('Every product with name and price');
    await btn('Extract with Claude').click();
    await waitToast(/Claude found 2 rows/);
    const req = await sp.evaluate(() => window.__requests[0]);
    assert.equal(req.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(req.body.output_config.format.type, 'json_schema');
    assert.ok(req.body.messages[0].content.includes('Alpha Widget'));

    await btn('✦ AI column').click();
    await dialog().locator('textarea').fill('Category of the product');
    await dialog().locator('label', { hasText: 'Column name' }).locator('input').fill('category');
    await dialog().getByRole('button', { name: 'Run on rows' }).click();
    await waitToast(/Filled 2 rows/);
    assert.ok((await tableCols()).includes('category'));
    assert.ok((await tableText()).includes('cat-1'));

    await btn('✦ Ask Claude').click();
    await dialog().locator('textarea').fill('Which is best?');
    await dialog().getByRole('button', { name: 'Ask' }).click();
    await sp.waitForSelector('.answer strong:text("Top item:")');
  });

  await step('history keeps results and reopens them', async () => {
    await home();
    await sp.getByRole('button', { name: /History/ }).click();
    const n = await sp.locator('.item-list li').count();
    assert.ok(n >= 10, `history ${n}`);
    await sp.locator('.item-list li').nth(1).getByRole('button', { name: 'Open' }).click();
    await sp.waitForSelector('table.data');
  });

  await step('no uncaught errors in the side panel', async () => {
    assert.deepEqual(errors, []);
  });

  await home();
  await sp.screenshot({ path: path.join(ROOT, 'test', 'home.png'), fullPage: true });
} finally {
  await ctx.close();
  server.close();
}

console.log(failures ? `\n${failures} step(s) failed` : '\nAll steps passed');
process.exit(failures ? 1 : 0);
