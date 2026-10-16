// Real-world behaviours that broke on LinkedIn / Google Maps / Instagram, reproduced with
// look-alike pages, driven through the Claude connector exactly like Claude does.
//
//   NODE_PATH=$(npm root -g) node test/realistic.mjs
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
const ONLY = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;

const RELAY_PORT = 20000 + Math.floor(Math.random() * 20000);
const relay = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-relay.mjs')], { env: { ...process.env, PORT: String(RELAY_PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => relay.stdout.on('data', (d) => String(d).includes('listening') && r()));
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const { server, base: BASE } = await startServer();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'wse-real-')), {
  channel: 'chromium', headless: true, viewport: { width: 1100, height: 800 },
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});

let failures = 0;
async function step(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${String(e.message).split('\n').slice(0, 8).join('\n    ')}`); }
}

let MCP;
let rpcId = 0;
async function tool(name, args = {}) {
  const res = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const r = (await res.json()).result;
  const t = r.content.find((c) => c.type === 'text')?.text;
  if (r.isError) throw new Error(`${name} → ${t}`);
  try { return JSON.parse(t); } catch { return t; }
}
const GIBBERISH = /[bcdfghjklmnpqrstvwxz]{4}|\d[a-z]|[a-z]\d/i;

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  await prepareExtension(ctx, sw, { mcp: { allowLocal: true } });
  const sp = await ctx.newPage();
  await sp.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
  MCP = await enableConnector(sp, RELAY);
  console.log(`Extension ${extId} connected · fixtures ${BASE}`);

  await step('LinkedIn-like: readable column names from auto-detect', async () => {
    const t = await tool('browser_open', { url: `${BASE}/li-jobs.html`, new_tab: true, wait_ms: 300 });
    const d = await tool('list_detect', { tab_id: t.tab_id });
    const c = d.candidates[0];
    console.log(`    ${c.item_selector} · ${c.items} items · ${c.fields.join(', ')}${d.preset ? ` · preset: ${d.preset}` : ''}`);
    for (const f of c.fields) assert.ok(!GIBBERISH.test(f.replace(/ \(.*\)$/, '')), `gibberish column name: ${f}`);
  });

  await step('Unknown site with obfuscated classes: columns named from content', async () => {
    const t = await tool('browser_open', { url: `${BASE}/hashed-shop.html`, new_tab: true, wait_ms: 300 });
    const d = await tool('list_detect', { tab_id: t.tab_id });
    const c = d.candidates[0];
    const names = c.fields.map((f) => f.replace(/ \(.*\)$/, ''));
    console.log(`    ${c.item_selector} · ${c.items} items · ${names.join(', ')}`);
    assert.equal(c.items, 12);
    for (const n of ['link', 'image', 'title', 'rating', 'reviews', 'price', 'date']) assert.ok(names.includes(n), `missing column "${n}"`);
    for (const n of names) assert.ok(!GIBBERISH.test(n), `gibberish column name: ${n}`);
    assert.ok(!/x1lliihq|xkrqix3/.test(c.item_selector), `hashed item selector: ${c.item_selector}`);
  });

  await step('LinkedIn-like: virtualised list + JS pagination → all 60 jobs, no blanks', async () => {
    const t = await tool('browser_open', { url: `${BASE}/li-jobs.html`, new_tab: true, wait_ms: 300 });
    const r = await tool('list_extract', { tab_id: t.tab_id, pagination: { mode: 'auto', max_pages: 5, delay_ms: 200 }, max_rows_returned: 100 });
    console.log(`    ${r.total_rows} rows · columns: ${r.columns.join(', ')}`);
    assert.equal(r.total_rows, 60);
    const titleCol = r.columns.find((c) => /title/i.test(c));
    assert.ok(titleCol, 'title column');
    assert.equal(r.rows.filter((x) => !x[titleCol]).length, 0, 'rows with empty title');
    assert.ok(r.rows.some((x) => x[titleCol] === 'AI Engineer 3-10'), 'last page reached');
  });

  await step('Maps-like: scrolls the results panel → all 40 places', async () => {
    const t = await tool('browser_open', { url: `${BASE}/maps.html`, new_tab: true, wait_ms: 300 });
    const r = await tool('list_extract', { tab_id: t.tab_id, pagination: { mode: 'scroll', max_pages: 40, delay_ms: 200 }, max_rows_returned: 100 });
    console.log(`    ${r.total_rows} rows · columns: ${r.columns.join(', ')}`);
    assert.equal(r.total_rows, 40);
    const name = r.columns.find((c) => /name|title/i.test(c));
    assert.ok(name && r.rows.every((x) => x[name]), 'every place has a name');
    assert.ok(r.columns.some((c) => /rating/i.test(c)), 'rating column');
  });

  await step('Instagram-like: lazy captions + infinite scroll → 60 posts with captions', async () => {
    const t = await tool('browser_open', { url: `${BASE}/ig.html`, new_tab: true, wait_ms: 300 });
    const r = await tool('list_extract', { tab_id: t.tab_id, pagination: { mode: 'scroll', max_pages: 40, delay_ms: 200 }, max_rows_returned: 100 });
    const types = r.rows.reduce((o, x) => ({ ...o, [x.type]: (o[x.type] || 0) + 1 }), {});
    console.log(`    ${r.total_rows} rows, ${r.rows.filter((x) => x.caption).length} with captions · ${JSON.stringify(types)}`);
    assert.deepEqual(types, { post: 30, carousel: 10, reel: 20 }, 'reels / carousels / posts labelled');
    assert.ok(r.rows.some((x) => x.type === 'reel' && /\/reel\//.test(x.link)) && r.rows.some((x) => x.type === 'reel' && /\/p\//.test(x.link)), 'reels via /reel/ links and via the Clip icon');
    assert.equal(r.total_rows, 60);
    assert.equal(r.rows.filter((x) => !x.caption).length, 0, 'posts without caption');
  });
  await step('Instagram-like with nested scroll containers → keeps scrolling the page', async () => {
    const t = await tool('browser_open', { url: `${BASE}/ig-nested.html`, new_tab: true, wait_ms: 300 });
    const r = await tool('list_extract', { tab_id: t.tab_id, pagination: { mode: 'scroll', max_pages: 10, delay_ms: 200 }, max_rows_returned: 100 });
    console.log(`    preset ${r.preset} · ${r.total_rows} rows, ${r.rows.filter((x) => x.caption).length} with captions · ${r.scroll_steps} steps`);
    assert.equal(r.total_rows, 60);
  });

  await step('Instagram Reel page → likes, comments, author, date as numbers', async () => {
    const r = await tool('page_extract', { urls: [`${BASE}/ig-reel.html`], fields: ['ig_type', 'ig_likes', 'ig_comments', 'ig_author', 'ig_date', 'ig_caption'].map((b) => ({ name: b, builtin: b })) });
    const row = r.rows[0];
    console.log(`    ${JSON.stringify(row)}`);
    assert.equal(row.ig_type, 'reel');
    assert.equal(row.ig_likes, '248000');
    assert.equal(row.ig_comments, '2219');
    assert.equal(row.ig_author, 'base.learn');
    assert.equal(row.ig_date, 'October 11, 2026');
    assert.match(row.ig_caption, /learn how we make these videos/);
  });

  await step('Meta-style class names never become column names', async () => {
    const d = await tool('list_detect', { url: `${BASE}/meta-classes.html` });
    const names = d.candidates[0].fields.map((f) => f.replace(/ \(.*\)$/, ''));
    console.log(`    ${names.join(', ')}`);
    for (const n of names) assert.ok(!/xqjyukv|xlyipyv|xeuugli|x1i10hfl/.test(n), `meta class leaked: ${n}`);
  });
} finally {
  await ctx.close();
  server.close();
  relay.kill();
}
console.log(failures ? `\n${failures} step(s) failed` : '\nAll steps passed');
process.exit(failures ? 1 : 0);
