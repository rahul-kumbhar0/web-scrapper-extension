// Layouts the engine meets across the web (Wikipedia tables, Bootstrap grids, Hacker News, search
// results, ARIA grids, web components, SPAs, non-English pagination…), checked straight against
// content/engine.js in a plain page.
//
//   NODE_PATH=$(npm root -g) node test/patterns.mjs [filter]
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ONLY = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;

const { server, base: BASE } = await startServer();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

async function open(name) {
  await page.goto(`${BASE}/patterns/${name}.html`);
  await page.addScriptTag({ path: path.join(ROOT, 'content/engine.js') });
}
// Top candidate + its first rows as objects + pagination finds.
async function detect(name, { ready = false } = {}) {
  await open(name);
  return page.evaluate(async (ready) => {
    const W = globalThis.__webScraper;
    const cands = ready ? await W.autoDetectListsReady() : W.autoDetectLists();
    const top = cands[0];
    const ex = top ? W.extractList(top) : { cols: [], data: [] };
    return {
      top, cands,
      names: top ? top.fields.map((f) => f.name) : [],
      rows: ex.data.map((r) => Object.fromEntries(ex.cols.map((c, i) => [c, r[i]]))),
      next: W.findNextUrl(), nextBtn: W.findNextButton(), more: W.findLoadMoreButton(),
    };
  }, ready);
}

let failures = 0;
async function check(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${String(e.message).split('\n').slice(0, 6).join('\n    ')}`); }
}
const has = (names, ...want) => { for (const w of want) assert.ok(names.includes(w), `missing column "${w}" in [${names.join(', ')}]`); };

try {
  await check('Wikipedia table: header row skipped, columns named from headers', async () => {
    const r = await detect('wiki-table');
    assert.equal(r.rows.length, 18);
    has(r.names, 'Rank', 'City', 'Population', 'Area', 'Country', 'City link');
    assert.equal(r.rows[0].City, 'Aurora City');
  });
  await check('Old table with bold header cells', async () => {
    const r = await detect('old-table');
    assert.equal(r.rows.length, 14);
    has(r.names, 'Name', 'Email', 'Phone', 'Office');
    assert.notEqual(r.rows[0].Name, 'Name');
  });
  await check('ARIA grid of divs uses column headers', async () => {
    const r = await detect('aria-grid');
    assert.equal(r.rows.length, 15);
    has(r.names, 'Name', 'Email', 'Status', 'Joined');
  });
  await check('Bootstrap cards: price/description, numbered pagination', async () => {
    const r = await detect('bootstrap-cards');
    assert.equal(r.rows.length, 16);
    has(r.names, 'image', 'title', 'description', 'price');
    assert.match(r.next, /page=2/);
    assert.ok(r.nextBtn, 'next button (aria-label="Next" with »)');
  });
  await check('Hacker News: two table rows per item merged', async () => {
    const r = await detect('hn');
    assert.equal(r.top.itemSelector, 'tr.athing');
    assert.equal(r.rows.length, 20);
    has(r.names, 'title', 'points', 'author', 'comments');
    assert.match(r.rows[0].points, /points/);
    assert.match(r.rows[0].comments, /comments/);
    assert.match(r.rows[3].title, /#3$/);
    assert.ok(r.rows.every((x, i) => x.title.endsWith(`#${i}`)), 'detail row belongs to its own title row');
    assert.match(r.next, /p=2/);
  });
  await check('Search results with obfuscated classes: right element per column', async () => {
    const r = await detect('search');
    assert.equal(r.rows.length, 10);
    has(r.names, 'title', 'link', 'url', 'description');
    assert.match(r.rows[0].description, /is a thing that does stuff/);
    assert.match(r.next, /start=10/);
  });
  await check('Menus and footers rank below the content, even when bigger', async () => {
    const r = await detect('megamenu');
    assert.match(r.top.itemSelector, /product/);
    has(r.names, 'title', 'price', 'image');
    const menu = r.cands.find((c) => /menu-item/.test(c.itemSelector));
    assert.ok(!menu || menu.chrome, 'menu marked as page furniture');
  });
  await check('Hindi / Japanese / Spanish next links and "x ago" dates', async () => {
    for (const p of ['hindi', 'japanese', 'spanish']) {
      const r = await detect(p);
      assert.match(r.next || '', /page=2/, `${p}: next link`);
      assert.ok(r.nextBtn, `${p}: next button`);
      assert.ok(r.names.includes('title'), `${p}: title column`);
      if (p !== 'spanish') assert.ok(r.names.includes('date'), `${p}: date column`);
    }
  });
  await check('Load-more buttons in other wordings ("Show 20 more", "Mostrar más")', async () => {
    assert.ok((await detect('loadmore-variants')).more);
    assert.ok((await detect('spanish')).more);
  });
  await check('Web components: data in attributes and custom tags', async () => {
    const r = await detect('custom-elements');
    assert.equal(r.rows.length, 12);
    has(r.names, 'title', 'price', 'sku', 'image', 'link');
    assert.equal(r.rows[0].sku, 'SKU0');
  });
  await check('Reddit (shreddit-post attributes)', async () => {
    const r = await detect('reddit');
    assert.equal(r.top.preset, 'Reddit posts');
    assert.equal(r.rows.length, 10);
    assert.match(r.rows[0].link, /^http.*\/r\/test\/comments\/0\//);
    assert.equal(r.rows[1].score, '10');
  });
  await check('Background-image tiles get an image column', async () => {
    const r = await detect('bg-tiles');
    has(r.names, 'image', 'link');
    assert.match(r.rows[0].image, /bg0\.jpg$/);
  });
  await check('Star ratings from image alt text, long review text', async () => {
    const r = await detect('reviews');
    has(r.names, 'rating', 'review', 'date');
    assert.match(r.rows[0].rating, /out of 5/);
    assert.match(r.next, /page=2/);
  });
  await check('Uneven job cards: optional fields kept, constant location kept', async () => {
    const r = await detect('jobs');
    assert.equal(r.rows.length, 15);
    has(r.names, 'title', 'company', 'location', 'salary', 'date');
    assert.equal(r.rows[1].location, 'Austin, USA');
    assert.ok(r.rows.some((x) => !x.salary) && r.rows.some((x) => x.salary), 'salary blank where missing');
    assert.ok(!r.names.some((n) => /aside|rec/.test(n)));
  });
  await check('Definition list: term + description pairs', async () => {
    const r = await detect('glossary');
    assert.equal(r.rows.length, 10);
    has(r.names, 'term', 'description');
    assert.equal(r.rows[2].term, 'Cedar');
    assert.match(r.rows[2].description, /Cedar/);
  });
  await check('Late-rendering single-page app: waits for the list', async () => {
    const r = await detect('spa', { ready: true });
    assert.equal(r.rows.length, 14);
    has(r.names, 'title', 'link', 'location');
  });
  await check('CAPTCHA, login wall and normal pages are told apart', async () => {
    const blockOf = async (name) => { await open(name); return page.evaluate(() => globalThis.__webScraper.pageBlock()); };
    assert.equal((await blockOf('captcha'))?.kind, 'captcha');
    assert.equal((await blockOf('login-wall'))?.kind, 'login');
    for (const p of ['bootstrap-cards', 'hn', 'feed-cookie', 'jobs']) assert.equal(await blockOf(p), null, `${p} is not blocked`);
  });
  await check('Cookie banner over the page does not hide the list', async () => {
    const r = await detect('feed-cookie');
    assert.equal(r.rows.length, 10);
    has(r.names, 'author', 'likes');
  });
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} failed` : '\nAll pattern checks passed');
process.exit(failures ? 1 : 0);
