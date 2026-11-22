// Offline-queue tests: calls made while the browser is offline (laptop asleep, Chrome closed)
// are held on the relay, run on reconnect, and their results wait for a queued_results call.
//   node test/offline.mjs
// The relay is started with a short CONNECT_GRACE_MS / HOLD_TTL_MS so "offline" happens fast.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { idForToken } from '../server/mcp-relay.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRACE = 300;
const TTL = 1200;

const children = [];
async function startRelay(env = {}) {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-relay.mjs')], {
    env: { ...process.env, PUBLIC_URL: '', TRUST_PROXY: '', OAUTH_SECRET: '', NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', CONNECT_GRACE_MS: String(GRACE), HOLD_TTL_MS: String(TTL), ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('listening') && resolve());
    child.on('exit', (c) => reject(new Error(`relay exited with ${c}`)));
  });
  return `http://127.0.0.1:${port}`;
}

let failures = 0;
let passed = 0;
const step = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ✓ ${name} (${Date.now() - t0} ms)`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newToken = () => crypto.randomBytes(24).toString('base64url');

const BASE = await startRelay();

async function rpc(id, body) {
  const r = await fetch(`${BASE}/mcp/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
let rpcId = 1;
const call = (id, name, args = {}) => rpc(id, { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } });
const callText = (r) => r.body?.result?.content?.[0]?.text || '';
const status = (token) => fetch(`${BASE}/bridge/${token}/status?v=test`).then((r) => r.json());
const disconnect = (token) => fetch(`${BASE}/bridge/${token}`, { method: 'DELETE' });
const postResult = (token, id, payload) => fetch(`${BASE}/bridge/${token}/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...payload }) });

// A fake extension: polls until stopped and answers every command with `answer(cmd)`.
function fakeExtension(token, answer = (cmd) => ({ content: [{ type: 'text', text: `ok:${cmd.tool}` }] })) {
  let stopped = false;
  const ac = new AbortController();
  const seen = [];
  const loop = (async () => {
    await status(token);
    while (!stopped) {
      let r;
      try { r = await fetch(`${BASE}/bridge/${token}/next?v=test`, { signal: ac.signal }); } catch { break; }
      if (r.status !== 200) { await r.arrayBuffer(); continue; }
      const cmd = await r.json();
      seen.push(cmd);
      if (cmd.tool === '__cancel') continue;
      Promise.resolve(answer(cmd)).then((p) => p && postResult(token, cmd.id, p));
    }
  })();
  return { seen, stop: async () => { stopped = true; ac.abort(); await loop; } };
}

try {
  console.log('offline queue:');

  await step('tools/list includes queued_results', async () => {
    const list = await rpc(idForToken(newToken()), { jsonrpc: '2.0', id: rpcId++, method: 'tools/list' });
    assert.ok(list.body.result.tools.some((t) => t.name === 'queued_results'));
  });

  await step('unknown browser: queued_results and other tools still say not connected', async () => {
    const id = idForToken(newToken());
    const r = await call(id, 'queued_results');
    assert.equal(r.body.result.isError, true);
    assert.match(callText(r), /not connected/);
  });

  await step('call while offline is queued, listed by queued_results, run on reconnect, result returned once', async () => {
    const token = newToken();
    const id = idForToken(token);
    const ext1 = fakeExtension(token);
    await sleep(150);
    await ext1.stop(); // browser goes away (polls closed → lastSeen set)
    await sleep(GRACE + 200);

    const held = await call(id, 'browser_tabs', { x: 1 });
    assert.ok(!held.body.result.isError, callText(held));
    assert.match(callText(held), /offline/i);
    assert.match(callText(held), /queued as #/);

    const waiting = await call(id, 'queued_results');
    assert.match(callText(waiting), /Waiting for the user's browser/);
    assert.match(callText(waiting), /browser_tabs/);

    // The browser comes back: the held command is delivered with queued: true and answered.
    const ext2 = fakeExtension(token, (cmd) => ({ content: [{ type: 'text', text: `ran:${cmd.tool}` }] }));
    await sleep(400);
    assert.equal(ext2.seen[0]?.tool, 'browser_tabs');
    assert.equal(ext2.seen[0]?.queued, true);

    const got = await call(id, 'queued_results');
    assert.match(callText(got), /Finished \(1/);
    assert.match(callText(got), /ran:browser_tabs/);
    const again = await call(id, 'queued_results');
    assert.match(callText(again), /empty/i); // returned once, then dropped
    await ext2.stop();
  });

  await step('a dispatched-but-undelivered call converts to the queue instead of failing', async () => {
    const token = newToken();
    const id = idForToken(token);
    await status(token); // browser says hello but never polls (e.g. fell asleep right after)
    const r = await call(id, 'list_detect', { url: 'https://example.com' });
    assert.ok(!r.body.result.isError, callText(r));
    assert.match(callText(r), /queued as #/);
    const waiting = await call(id, 'queued_results');
    assert.match(callText(waiting), /list_detect/);
  });

  await step('turning the connector off means stop: held calls error, new calls are not queued', async () => {
    const token = newToken();
    const id = idForToken(token);
    const ext = fakeExtension(token);
    await sleep(150);
    await ext.stop();
    await sleep(GRACE + 200);
    await call(id, 'browser_tabs'); // held
    await disconnect(token); // user turned the connector off
    const after = await call(id, 'browser_tabs');
    assert.equal(after.body.result.isError, true);
    assert.match(callText(after), /not connected/);
    const res = await call(id, 'queued_results');
    assert.match(callText(res), /turned off/);
  });

  await step('held calls expire after HOLD_TTL_MS with an explanatory result', async () => {
    const token = newToken();
    const id = idForToken(token);
    const ext = fakeExtension(token);
    await sleep(150);
    await ext.stop();
    await sleep(GRACE + 200);
    await call(id, 'browser_tabs');
    await sleep(TTL + 1200); // sweep runs every second
    const res = await call(id, 'queued_results');
    assert.match(callText(res), /Expired/);
  });

  await step('the offline queue is bounded', async () => {
    const token = newToken();
    const id = idForToken(token);
    const ext = fakeExtension(token);
    await sleep(150);
    await ext.stop();
    await sleep(GRACE + 200);
    for (let i = 0; i < 10; i++) assert.match(callText(await call(id, 'browser_tabs', { i })), /queued as #/);
    const full = await call(id, 'browser_tabs', { i: 10 });
    assert.equal(full.body.result.isError, true);
    assert.match(callText(full), /queue is full/);
  });
} finally {
  for (const c of children) c.kill();
}
console.log(failures ? `\n${failures} step(s) failed, ${passed} passed` : `\nAll ${passed} steps passed`);
process.exit(failures ? 1 : 0);
