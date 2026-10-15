// End-to-end test: loads the unpacked extension in Chromium, scrapes local fixture pages
// through the real side panel UI, follows pagination, exercises the picker, exports and
// AI extraction (with a mocked API response).
//
//   NODE_PATH=$(npm root -g) node test/e2e.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

const server = http.createServer((req, res) => {
  const file = path.join(FIXTURES, path.normalize(decodeURIComponent(req.url.split('?')[0])));
  if (file.startsWith(FIXTURES) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wse-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  acceptDownloads: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name}\n    ${e.message.split('\n').join('\n    ')}`);
  }
}

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  console.log(`Extension loaded: ${extId}`);

  const site = await ctx.newPage();
  await site.goto(`${BASE}/shop-1.html`);

  const sp = await ctx.newPage();
  const errors = [];
  sp.on('pageerror', (e) => errors.push(e.message));
  await sp.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
  // The panel targets "the active tab"; in this test the panel itself is a tab, so point it at the site tab.
  await sp.evaluate(async (base) => {
    const [t] = await chrome.tabs.query({ url: `${base}/*` });
    chrome.tabs.query = async () => [await chrome.tabs.get(t.id)];
  }, BASE);

  const statusText = () => sp.locator('#status').textContent();
  const waitStatus = (re, timeout = 20000) =>
    sp.waitForFunction((src) => new RegExp(src).test(document.getElementById('status').textContent), re.source, { timeout });
  const tabCounts = async () => Object.fromEntries((await sp.locator('#type-tabs button').allTextContents())
    .map((t) => { const m = t.match(/^(.*?)(\d+)$/); return [m[1].trim(), Number(m[2])]; }));
  const tableText = () => sp.locator('#table').textContent();
  const clickType = (label) => sp.locator('#type-tabs button', { hasText: label }).click();

  await step('settings: save page delay 0', async () => {
    await sp.click('[data-tab=settings]');
    await sp.fill('#page-delay', '0');
    await sp.click('#settings-form button[type=submit]');
    await sp.waitForSelector('#settings-saved:not([hidden])');
    await sp.click('[data-tab=scrape]');
  });

  await step('picker: clicking an element fills a generalised selector', async () => {
    await sp.click('#pick');
    await site.waitForTimeout(300);
    await site.hover('text=Beta Widget');
    await site.click('text=Beta Widget');
    await sp.waitForFunction(() => document.getElementById('selector').value);
    const sel = await sp.inputValue('#selector');
    const count = await sp.locator('#selector-count').textContent();
    console.log(`    picked "${sel}" → ${count}`);
    assert.match(count, /^3 matches/);
  });

  await step('single-page scrape with all extractors + custom selector', async () => {
    await sp.click('#toggle-all'); // select all
    await sp.click('#run-scrape');
    await waitStatus(/^Found/);
    const c = await tabCounts();
    console.log('    counts', JSON.stringify(c));
    assert.equal(c.Emails, 3);
    assert.equal(c.Phones, 2, 'two real phone numbers, no dates/versions/years');
    assert.equal(c.Tables, 2);
    assert.equal(c.Prices, 3);
    assert.equal(c['Social profiles'], 3);
    assert.equal(c.Custom, 3);
    assert.ok(c.Images >= 4, 'img tags + css background + og:image');

    await clickType('Phones');
    const phones = await tableText();
    assert.ok(phones.includes('+1 (415) 555-0192') && phones.includes('+442079460958'), phones);
    assert.ok(!/2024|1\.2\.3/.test(phones), `false positive in ${phones}`);
    await clickType('Tables');
    assert.ok((await tableText()).includes('Ann Lee'));
    await clickType('Pagination');
    assert.ok((await tableText()).includes('/shop-2.html'));
    await clickType('Links');
    assert.deepEqual(await sp.locator('#table th').allTextContents(), ['url', 'text', 'kind'], 'column order kept');
    await clickType('Custom');
    assert.ok((await tableText()).includes('/p/alpha'), 'custom rows pick up the link from their card');
  });

  await step('exports: CSV, Excel and JSON download valid files', async () => {
    await clickType('Emails');
    const [csv] = await Promise.all([sp.waitForEvent('download'), sp.click('[data-export=csv]')]);
    const csvText = fs.readFileSync(await csv.path(), 'utf8');
    assert.match(csvText, /^﻿email,source\r\n/);
    assert.ok(csvText.includes('sales@demoshop.example'));

    const [xlsx] = await Promise.all([sp.waitForEvent('download'), sp.click('[data-export=xlsx]')]);
    const xlsxPath = path.join(userDataDir, 'out.xlsx');
    await xlsx.saveAs(xlsxPath);
    console.log(`    xlsx saved: ${xlsx.suggestedFilename()}`);
    fs.copyFileSync(xlsxPath, path.join(ROOT, 'test', 'last-export.xlsx'));

    const [json] = await Promise.all([sp.waitForEvent('download'), sp.click('[data-export=json]')]);
    const data = JSON.parse(fs.readFileSync(await json.path(), 'utf8'));
    assert.equal(data.results.emails.length, 3);
  });

  await step('multi-page: follows Next links and merges results', async () => {
    await sp.check('#opt-pages');
    await sp.fill('#opt-max-pages', '5');
    await sp.click('#run-scrape');
    await waitStatus(/^Found .* on 2 pages/);
    const c = await tabCounts();
    console.log('    counts', JSON.stringify(c));
    assert.equal(c.Emails, 4, 'sales@ deduped, careers@ added');
    assert.equal(c.Custom, 4);
    await clickType('Custom');
    const t = await tableText();
    assert.ok(t.includes('Delta Widget') && t.includes('page_url'));
    assert.equal(new URL(site.url()).pathname, '/shop-2.html');
  });

  await step('history: scrapes are saved and can be reopened', async () => {
    await sp.click('[data-tab=history]');
    const items = await sp.locator('#history-list li').count();
    assert.equal(items, 2);
    await sp.locator('#history-list li').nth(1).getByText('Open').click();
    assert.equal((await tabCounts()).Emails, 3);
  });

  await step('AI: without a key it asks for one', async () => {
    await sp.click('[data-tab=ai]');
    await sp.fill('#ai-goal', 'products');
    await sp.click('#run-ai');
    assert.match(await statusText(), /API key/);
  });

  await step('AI: request shape + parsing (mocked API)', async () => {
    await sp.click('[data-tab=settings]');
    await sp.fill('#api-key', 'sk-ant-test');
    await sp.click('#settings-form button[type=submit]');
    await sp.evaluate(() => {
      window.__requests = [];
      const realFetch = window.fetch;
      window.fetch = async (url, init) => {
        if (!String(url).includes('api.anthropic.com')) return realFetch(url, init);
        window.__requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({
          model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 60 },
          content: [{ type: 'text', text: JSON.stringify({ columns: ['name', 'price'], rows: [['Delta Widget', '£19']] }) }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
    });
    await sp.click('[data-tab=ai]');
    await sp.fill('#ai-goal', 'Every product with name and price');
    await sp.click('#run-ai');
    await waitStatus(/^Claude found 1 row/);
    const req = await sp.evaluate(() => window.__requests[0]);
    assert.equal(req.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(req.body.model, 'claude-opus-5-5');
    assert.equal(req.body.output_config.format.type, 'json_schema');
    assert.ok(req.body.messages[0].content.includes('Delta Widget'), 'page text sent');
    const t = await tableText();
    assert.ok(t.includes('name') && t.includes('£19'));
  });

  await step('no uncaught errors in the side panel', async () => {
    assert.deepEqual(errors, []);
  });

  await sp.screenshot({ path: path.join(ROOT, 'test', 'sidepanel.png'), fullPage: true });
} finally {
  await ctx.close();
  server.close();
}

console.log(failures ? `\n${failures} step(s) failed` : '\nAll steps passed');
process.exit(failures ? 1 : 0);
