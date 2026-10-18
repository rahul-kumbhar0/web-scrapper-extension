// Trend Finder, post details and background-first reading, on Instagram / TikTok / YouTube look-alike
// pages, through the side panel and through the Claude connector.
//
//   NODE_PATH=$(npm root -g) node test/social.mjs [filter]
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
const { server, base: BASE } = await startServer();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'wse-social-')), {
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
const sorted = (a) => a.every((x, i) => i === 0 || a[i - 1] >= x);

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  await prepareExtension(ctx, sw, { mcp: { allowLocal: true } });
  const sp = await ctx.newPage();
  await sp.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
  MCP = await enableConnector(sp, RELAY_PORT && `http://127.0.0.1:${RELAY_PORT}`);
  console.log(`Extension ${extId} · fixtures ${BASE}`);

  await step('Claude: TikTok hashtag page → ranked top 10 read fully in the background, with scripts', async () => {
    const r = await tool('trends_find', { page_url: `${BASE}/social/tag/aitools/`, top: 10, transcripts: true });
    console.log(`    scanned ${r.scanned} · background ${r.read_in_background} · tabs ${r.needed_a_tab} · #1: ${r.top[0].hook} — ${r.top[0].why}`);
    assert.equal(r.scanned, 16);
    assert.equal(r.needed_a_tab, 0, 'no tab needed: the page carries all data');
    assert.equal(r.top.length, 10);
    assert.ok(sorted(r.top.map((p) => p.score)), 'sorted by score');
    for (const p of r.top) {
      assert.ok(p.views > 0 && p.likes > 0 && p.music && p.hashtags.includes('#aitools') && p.duration_s > 0 && p.posted, `complete post ${p.url}`);
    }
    const withScript = r.top.filter((p) => p.transcript);
    assert.ok(withScript.length >= 3, 'transcripts for winners with captions');
    assert.match(withScript[0].transcript, /writes the whole script for you/);
    const names = r.patterns.map((x) => x.insight);
    for (const n of ['Hashtags the top posts use', 'Sounds trending among the winners', 'Best length', 'Opening hooks of the top 5']) assert.ok(names.includes(n), `pattern: ${n}`);
  });

  await step('Claude: Instagram hashtag tiles → each Reel read from its own page (views, sound, followers)', async () => {
    const r = await tool('trends_find', { page_url: `${BASE}/social/explore/tags/aitools/`, top: 5, rank_by: 'views' });
    console.log(`    scanned ${r.scanned} · background ${r.read_in_background} · tabs ${r.needed_a_tab} · #1 ${r.top[0].views} views, ${r.top[0].music}`);
    assert.equal(r.scanned, 12);
    assert.ok(sorted(r.top.map((p) => p.views)), 'most viewed first');
    for (const p of r.top) {
      assert.ok(p.views > 100 && p.music && p.author_followers > 0 && p.caption.includes('#ai'), `reel enriched ${p.url}`);
      assert.match(p.url, /\/social\/reel\/C\d\daiREEL\/$/, 'keeps the real post link');
    }
  });

  await step('Claude: post_details on a YouTube Short → likes, sound, transcript', async () => {
    const r = await tool('post_details', { urls: [`${BASE}/social/shorts/sht00000001/`, `${BASE}/social/reel/C05aiREEL/`] });
    const [yt, ig] = r.rows;
    assert.equal(yt.views, 3100000);
    assert.equal(yt.likes, 145000);
    assert.equal(yt.comments, 1204);
    assert.match(yt.music, /Espresso/);
    assert.match(yt.transcript, /^Nobody talks about this AI trick\. Open the app/);
    assert.equal(yt.read, 'background');
    assert.equal(ig.id, 'C05aiREEL', 'the Reel in the URL, not a related one');
    assert.ok(ig.views > 5);
  });

  await step('Side panel: Trend Finder from pasted Reel links → Top / All posts / Patterns sheets', async () => {
    await sp.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
    await sp.locator('.tool-card', { hasText: 'Trend Finder' }).click();
    await sp.waitForSelector('#title:text("Trend Finder")');
    await sp.locator('label.field', { hasText: 'Find posts from' }).locator('select').selectOption('urls');
    const links = Array.from({ length: 8 }, (_, i) => `${BASE}/social/reel/C${String(i).padStart(2, '0')}aiREEL/`).join('\n');
    await sp.fill('textarea', links);
    await sp.getByRole('button', { name: 'Find the best posts' }).click();
    await sp.waitForSelector('text=/Ranked 8 posts/', { timeout: 60000 });
    const tabs = await sp.locator('.sheet-tab').allTextContents();
    console.log(`    sheets: ${tabs.join(' · ')}`);
    assert.ok(tabs.some((t) => /Top 8/.test(t)) && tabs.some((t) => /All posts/.test(t)) && tabs.some((t) => /Patterns/.test(t)));
    const head = await sp.locator('thead th').allTextContents();
    for (const c of ['rank', 'score', 'why', 'views', 'music', 'hashtags', 'hook']) assert.ok(head.some((x) => x.trim().startsWith(c)), `column ${c}`);
  });
} finally {
  await ctx.close();
  server.close();
  relay.kill();
}
console.log(failures ? `\n${failures} step(s) failed` : '\nAll steps passed');
process.exit(failures ? 1 : 0);
