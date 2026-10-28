#!/usr/bin/env node
// Renders the Chrome Web Store images into store/: five 1280×800 screenshots (real side-panel
// captures next to a demo website), the 440×280 small promo tile and the 1400×560 marquee.
//
//   NODE_PATH=$(npm root -g) node scripts/store-assets.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareExtension, enableConnector } from '../test/setup.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'store');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pullrows-store-'));
const LOGO = fs.readFileSync(path.join(ROOT, 'brand/logo.svg'), 'utf8');

// ---------- demo site (served under a fictional domain) + local relay ----------
const BASE = 'https://cityguide.example';
const RELAY_PORT = 20000 + Math.floor(Math.random() * 20000);
const relay = spawn(process.execPath, [path.join(ROOT, 'server/mcp-relay.mjs')], { env: { ...process.env, PORT: String(RELAY_PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => relay.stdout.on('data', (d) => String(d).includes('listening') && r()));

const ctx = await chromium.launchPersistentContext(path.join(TMP, 'profile'), {
  channel: 'chromium', headless: true, viewport: { width: 380, height: 640 }, deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
await ctx.route(`${BASE}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(ROOT, 'store/demo/index.html')) }));
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
await prepareExtension(ctx, sw, { pro: false, mcp: { allowLocal: true } });

const page = await ctx.newPage();
await page.setViewportSize({ width: 880, height: 640 });
await page.goto(`${BASE}/pune/cafes`);
const panel = await ctx.newPage();
// The panel works on "the active tab"; here the panel itself is a tab, so point it at the demo site.
await panel.addInitScript((base) => {
  const orig = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = async (q) => (q?.active ? orig({ url: `${base}/*` }) : orig(q));
}, BASE);
await panel.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
await panel.waitForTimeout(800);

const shots = {};
const grab = async (name, { scrollTop = 0 } = {}) => {
  await panel.evaluate((y) => window.scrollTo(0, y), scrollTop);
  await panel.evaluate(() => { const t = document.getElementById('toast'); t.hidden = true; });
  await panel.waitForTimeout(400);
  shots[name] = (await panel.screenshot()).toString('base64');
};
const grabSite = async (name) => { shots[name] = (await page.screenshot()).toString('base64'); };

await grab('home');
await grabSite('site');
await panel.locator('.hero .btn.on-dark').click(); // Auto-detect list
await panel.waitForSelector('.list-summary code', { timeout: 15000 });
await panel.waitForTimeout(1200);
await grab('list');
await grabSite('site-hl');
await panel.getByRole('button', { name: 'Extract list', exact: true }).click();
await panel.waitForFunction(() => document.body.dataset.view === 'table', null, { timeout: 60000 });
await page.evaluate(() => globalThis.__webScraper?.clearHighlight?.());
await grab('table');
await panel.click('#back');
await enableConnector(panel, `http://127.0.0.1:${RELAY_PORT}`);
// Show the production relay address rather than the local test relay.
await panel.evaluate(() => { const l = document.getElementById('mcp-link'); l.value = l.value.replace(/^http:\/\/127\.0\.0\.1:\d+/, 'https://web-scrapper-extension.onrender.com'); });
await grab('connector', { scrollTop: 60 });
await panel.click('#plan-badge');
await grab('upgrade');

// ---------- compose ----------
const css = `
*{box-sizing:border-box}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.stage{position:relative;overflow:hidden;color:#0b0b14;background:radial-gradient(1200px 700px at 0% 0%,#efeaff 0%,transparent 60%),radial-gradient(900px 600px at 100% 100%,#dcfaf1 0%,transparent 55%),#fafaf7}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;letter-spacing:-.02em}
.brand svg{width:34px;height:34px;filter:drop-shadow(0 6px 14px rgba(106,92,255,.35))}
h1{margin:0;font-weight:800;letter-spacing:-.035em;line-height:1.04}
.grad{background:linear-gradient(135deg,#6a5cff,#3f8cff 55%,#14c9a4);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:#4a4a5e}
.window{position:absolute;border-radius:16px;overflow:hidden;background:#fff;box-shadow:0 30px 80px rgba(30,24,90,.22),0 0 0 1px rgba(16,16,40,.08)}
.bar{height:38px;display:flex;align-items:center;gap:7px;padding:0 14px;background:#f1f1f5;border-bottom:1px solid #e3e3ea}
.bar i{width:11px;height:11px;border-radius:50%;background:#e0e0e8}.bar i:nth-child(1){background:#ff6058}.bar i:nth-child(2){background:#ffbd2e}.bar i:nth-child(3){background:#28c941}
.url{margin-left:14px;flex:1;max-width:420px;height:24px;border-radius:12px;background:#fff;border:1px solid #e3e3ea;font-size:12px;color:#6b6b80;display:flex;align-items:center;padding:0 12px}
.cols{display:flex}.cols img{display:block}
.panel{border-left:1px solid #e3e3ea}
.pill{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;background:#fff;box-shadow:0 2px 10px rgba(16,16,40,.08);font-weight:650;font-size:15px;color:#3a3a4c}
.pill b{color:#6a5cff}`;

const browserWindow = (siteShot, panelShot, { left, top, scale = 1 }) => `
  <div class="window" style="left:${left}px;top:${top}px;transform:scale(${scale});transform-origin:top left">
    <div class="bar"><i></i><i></i><i></i><span class="url">cityguide.example/pune/cafes</span></div>
    <div class="cols"><img src="data:image/png;base64,${siteShot}" width="880" height="640"><img class="panel" src="data:image/png;base64,${panelShot}" width="380" height="640"></div>
  </div>`;

const SCREENS = [
  { file: 'screenshot-1-home.png', site: 'site', panel: 'home', kicker: 'No-code scraper in your side panel', title: 'Pull any website<br><span class="grad">into rows.</span>' },
  { file: 'screenshot-2-detect.png', site: 'site-hl', panel: 'list', kicker: 'Auto-detect · presets · pagination', title: 'One click finds<br><span class="grad">every item.</span>' },
  { file: 'screenshot-3-table.png', site: 'site', panel: 'table', kicker: 'Edit, clean, dedupe', title: 'Export clean data<br><span class="grad">to CSV or Excel.</span>' },
  { file: 'screenshot-4-claude.png', site: 'site', panel: 'connector', kicker: 'Works with Claude', title: 'Let Claude scrape<br><span class="grad">in your browser.</span>' },
  { file: 'screenshot-5-pro.png', site: 'site', panel: 'upgrade', kicker: 'Free forever · Pro $10/mo · $20 lifetime', title: 'Start free.<br><span class="grad">Go unlimited.</span>' },
];

const render = await chromium.launch();
const out = await render.newPage();
async function compose(file, w, h, body) {
  await out.setViewportSize({ width: w, height: h });
  await out.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div class="stage" style="width:${w}px;height:${h}px">${body}</div></body></html>`);
  await out.waitForTimeout(150);
  await out.screenshot({ path: path.join(OUT, file) });
  console.log(`store/${file}`);
}

for (const s of SCREENS) {
  await compose(s.file, 1280, 800, `
    <div style="position:absolute;left:60px;top:44px;right:60px;display:flex;align-items:flex-end;justify-content:space-between">
      <div><div class="brand">${LOGO}PullRows</div><h1 style="font-size:46px;margin-top:16px">${s.title}</h1></div>
      <span class="pill">${s.kicker}</span>
    </div>
    ${browserWindow(shots[s.site], shots[s.panel], { left: 60, top: 228, scale: 0.92 })}`);
}

await compose('promo-small-440x280.png', 440, 280, `
  <div style="position:absolute;inset:0;background:radial-gradient(120% 140% at 0% 0%,#7c6fff,#4b3ee0 50%,#16134a);color:#fff;padding:30px">
    <div class="brand" style="color:#fff;font-size:26px">${LOGO.replace('width="64" height="64"', 'width="44" height="44"')}PullRows</div>
    <h1 style="font-size:36px;margin-top:26px;color:#fff">Pull any website<br>into rows.</h1>
    <div style="position:absolute;right:-60px;bottom:-80px;width:240px;height:240px;border-radius:50%;background:radial-gradient(circle,rgba(20,201,164,.6),transparent 65%)"></div>
  </div>`);

await compose('promo-marquee-1400x560.png', 1400, 560, `
  <div style="position:absolute;left:80px;top:96px;width:520px">
    <div class="brand">${LOGO}PullRows</div>
    <h1 style="font-size:60px;margin-top:22px">Pull any website<br><span class="grad">into rows.</span></h1>
    <p class="sub" style="font-size:20px;margin-top:18px">Lists, contacts, images and whole catalogues → CSV &amp; Excel. And Claude can drive it.</p>
  </div>
  ${browserWindow(shots['site-hl'], shots.list, { left: 610, top: 92, scale: 0.6 })}`);

// The raw side-panel captures are handy for the website too.
for (const [name, b64] of Object.entries(shots)) fs.writeFileSync(path.join(OUT, 'raw', `${name}.png`), Buffer.from(b64, 'base64'));

await render.close();
await ctx.close();
relay.kill();
fs.rmSync(TMP, { recursive: true, force: true });
