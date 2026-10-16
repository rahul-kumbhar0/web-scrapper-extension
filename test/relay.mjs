// Standalone relay tests: pure Node HTTP, no browser. Simulates Claude (POST /mcp/<id>) and the
// PullRows extension (long-poll /bridge/<token>/next, POST /bridge/<token>/result).
//   node test/relay.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { idForToken } from '../server/mcp-relay.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PUBLIC_URL = 'https://relay.example.test';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

const children = [];
async function startRelay(env = {}) {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-relay.mjs')], {
    env: { ...process.env, PUBLIC_URL: '', TRUST_PROXY: '', OAUTH_SECRET: '', NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', ...env },
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

const BASE = await startRelay({ PUBLIC_URL });

async function rpc(id, body, headers = {}, base = BASE) {
  const r = await fetch(`${base}/mcp/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
}
let rpcId = 1;
const call = (id, name, args = {}) => rpc(id, { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } });
const callText = (r) => r.body?.result?.content?.[0]?.text || '';

// One long-poll: resolves to the command, or null on 204 / when `ms` elapses first.
async function poll(token, ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(`${BASE}/bridge/${token}/next?v=test`, { signal: ac.signal });
    if (r.status === 200) return await r.json();
    await r.arrayBuffer();
    return null;
  } catch (e) {
    if (e.name === 'AbortError') return null;
    throw e;
  } finally { clearTimeout(t); }
}
const postResult = (token, id, payload) => fetch(`${BASE}/bridge/${token}/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...payload }) });
const status = (token) => fetch(`${BASE}/bridge/${token}/status?v=test`).then((r) => r.json());
const disconnect = (token) => fetch(`${BASE}/bridge/${token}`, { method: 'DELETE' });

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
  console.log('relay (PUBLIC_URL set):');

  await step('idForToken = first 32 chars of unpadded base64url(SHA-256(token))', async () => {
    const t = 'test-token-aaaaaaaaaaaaaaaaaaaaaa';
    const want = crypto.createHash('sha256').update(t, 'utf8').digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
    assert.equal(idForToken(t), want);
    assert.match(idForToken(t), /^[A-Za-z0-9_-]{32}$/);
  });

  await step('initialize + tools/list via /mcp/<id> (PullRows branding, browser_open new_tab default true)', async () => {
    const id = idForToken(newToken());
    const init = await rpc(id, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.serverInfo.name, 'pullrows');
    assert.equal(init.body.result.serverInfo.title, 'PullRows (Chrome)');
    assert.equal(init.body.result.serverInfo.version, '1.0.0');
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.match(init.body.result.instructions, /PullRows/);
    assert.match(init.body.result.instructions, /Allow actions/);
    assert.ok(init.headers.get('mcp-session-id'));
    const notif = await rpc(id, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notif.status, 202);
    const list = await rpc(id, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.body.result.tools.map((t) => t.name);
    assert.ok(names.includes('browser_open') && names.includes('list_extract'));
    const open = list.body.result.tools.find((t) => t.name === 'browser_open');
    assert.equal(open.inputSchema.properties.new_tab.default, true);
    assert.ok(!JSON.stringify(list.body).includes('Web Scraper'));
    assert.equal((await fetch(`${BASE}/mcp/too-short`, { method: 'POST', body: '{}' })).status, 404);
  });

  await step('bridge round trip: poll /bridge/<token>/next, receive command, post result', async () => {
    const token = newToken();
    const ext = fakeExtension(token, (cmd) => ({ content: [{ type: 'text', text: `tabs for ${cmd.args.x}` }] }));
    await sleep(100);
    const r = await call(idForToken(token), 'browser_tabs', { x: 42 });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.isError, false);
    assert.equal(callText(r), 'tabs for 42');
    assert.equal(ext.seen[0].tool, 'browser_tabs');
    assert.match(ext.seen[0].id, /^[0-9a-f-]{36}$/);
    await ext.stop();
  });

  await step('MCP link alone cannot poll the bridge or forge results', async () => {
    const token = newToken();
    const id = idForToken(token);
    await status(token); // the real extension exists but is not polling right now
    const attacker = poll(id, 2500); // the id is a syntactically valid token, but maps to a different browser
    await sleep(200);
    const pending = call(id, 'browser_tabs');
    const stolen = await attacker;
    assert.equal(stolen, null, 'attacker polling /bridge/<id>/next must not receive commands');
    const real = await poll(token, 5000);
    assert.equal(real?.tool, 'browser_tabs');
    const forged = await postResult(id, real.id, { content: [{ type: 'text', text: 'forged' }] });
    assert.equal(forged.status, 404);
    assert.equal((await postResult(token, real.id, { content: [{ type: 'text', text: 'genuine' }] })).status, 200);
    assert.equal(callText(await pending), 'genuine');
  });

  await step('offline: unknown link fails immediately; known-but-offline browser fails in < 10 s', async () => {
    let t0 = Date.now();
    const r1 = await call(idForToken(newToken()), 'browser_tabs');
    assert.equal(r1.body.result.isError, true);
    assert.match(callText(r1), /PullRows extension is not connected.*side panel → Settings → Claude connector/);
    assert.ok(Date.now() - t0 < 1000);
    const token = newToken();
    await status(token); // seen once, never polls
    t0 = Date.now();
    const r2 = await call(idForToken(token), 'browser_tabs');
    const took = Date.now() - t0;
    assert.equal(r2.body.result.isError, true);
    assert.match(callText(r2), /not connected/);
    assert.ok(took < 10000, `took ${took} ms`);
  });

  await step('an aborted long-poll does not swallow a command', async () => {
    const token = newToken();
    await status(token);
    await poll(token, 300); // aborted by the client after 300 ms
    await sleep(100);
    const pending = call(idForToken(token), 'browser_tabs');
    const cmd = await poll(token, 5000);
    assert.equal(cmd?.tool, 'browser_tabs');
    await postResult(token, cmd.id, { content: [{ type: 'text', text: 'ok' }] });
    assert.equal(callText(await pending), 'ok');
  });

  await step('DELETE /bridge/<token> during an in-flight call fails it within ~2 s and queues __cancel', async () => {
    const token = newToken();
    await status(token);
    const pending = call(idForToken(token), 'list_extract', { url: 'https://example.com' });
    const cmd = await poll(token, 5000);
    assert.equal(cmd?.tool, 'list_extract');
    const t0 = Date.now();
    const del = await disconnect(token);
    assert.equal(del.status, 200);
    const r = await pending;
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
    assert.equal(r.body.result.isError, true);
    assert.match(callText(r), /The PullRows connector was turned off while running list_extract\./);
    const cancel = await poll(token, 3000);
    assert.equal(cancel?.tool, '__cancel');
    assert.deepEqual(cancel.args, { id: cmd.id });
    assert.notEqual(cancel.id, cmd.id);
    // A late result for the cancelled command is refused.
    assert.equal((await postResult(token, cmd.id, { content: [] })).status, 404);
    // After DELETE the browser is offline: a new call fails as not connected, immediately.
    await disconnect(token);
    const t1 = Date.now();
    const after = await call(idForToken(token), 'browser_tabs');
    assert.match(callText(after), /not connected/);
    assert.ok(Date.now() - t1 < 1000);
  });

  await step('DELETE also fails queued (undelivered) calls with the not-connected message', async () => {
    const token = newToken();
    await status(token);
    const pending = call(idForToken(token), 'browser_tabs');
    await sleep(200);
    await disconnect(token);
    const r = await pending;
    assert.match(callText(r), /not connected/);
    assert.equal(await poll(token, 800), null, 'no __cancel for a command that was never delivered');
  });

  await step('JSON-RPC batches: > 10 rejected with -32600; entries run sequentially', async () => {
    const token = newToken();
    const id = idForToken(token);
    const big = Array.from({ length: 11 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping' }));
    const r = await rpc(id, big);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, -32600);
    const ok = await rpc(id, big.slice(0, 10));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.length, 10);

    await status(token);
    const batch = rpc(id, [
      { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'browser_tabs', arguments: {} } },
      { jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'recipes_list', arguments: {} } },
    ]);
    const first = await poll(token, 5000);
    assert.equal(first?.tool, 'browser_tabs');
    assert.equal(await poll(token, 800), null, 'second batch entry must wait for the first');
    await postResult(token, first.id, { content: [{ type: 'text', text: '1' }] });
    const second = await poll(token, 5000);
    assert.equal(second?.tool, 'recipes_list');
    await postResult(token, second.id, { content: [{ type: 'text', text: '2' }] });
    const out = (await batch).body;
    assert.deepEqual(out.map((m) => m.result.content[0].text), ['1', '2']);
  });

  await step('pending cap: the 7th concurrent call gets "PullRows is busy with 6 tasks"', async () => {
    const token = newToken();
    const id = idForToken(token);
    const ext = fakeExtension(token, () => null); // receives commands, never answers
    await sleep(100);
    const six = Array.from({ length: 6 }, () => call(id, 'browser_tabs'));
    for (let i = 0; i < 50 && ext.seen.length < 6; i++) await sleep(50);
    assert.equal(ext.seen.length, 6);
    const seventh = await call(id, 'browser_tabs');
    assert.equal(seventh.body.result.isError, true);
    assert.equal(callText(seventh), 'PullRows is busy with 6 tasks — wait for them to finish.');
    await ext.stop();
    await disconnect(token);
    const done = await Promise.all(six);
    assert.ok(done.every((r) => /turned off while running browser_tabs/.test(callText(r))));
  });

  await step('Origin guard + CORS only on /mcp and /.well-known', async () => {
    const id = idForToken(newToken());
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const evil = await rpc(id, ping, { origin: 'https://evil.com' });
    assert.equal(evil.status, 403);
    for (const o of ['https://docs.anthropic.com.evil.com', 'http://claude.ai', 'null']) assert.equal((await rpc(id, ping, { origin: o })).status, 403, o);
    const good = await rpc(id, ping, { origin: 'https://claude.ai' });
    assert.equal(good.status, 200);
    assert.equal(good.headers.get('access-control-allow-origin'), 'https://claude.ai');
    assert.equal((await rpc(id, ping, { origin: 'http://localhost:6274' })).status, 200);
    assert.equal((await rpc(id, ping, { origin: 'https://console.anthropic.com' })).status, 200);
    const noOrigin = await rpc(id, ping);
    assert.equal(noOrigin.status, 200);
    const pre = await fetch(`${BASE}/mcp/${id}`, { method: 'OPTIONS', headers: { origin: 'https://claude.com', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://claude.com');
    assert.match(pre.headers.get('access-control-allow-headers'), /mcp-protocol-version/);
    const wk = await fetch(`${BASE}/.well-known/oauth-authorization-server`, { headers: { origin: 'https://claude.ai' } });
    assert.equal(wk.headers.get('access-control-allow-origin'), '*');
    const br = await fetch(`${BASE}/bridge/${newToken()}/status`, { headers: { origin: 'https://claude.ai' } });
    assert.equal(br.status, 200);
    assert.equal(br.headers.get('access-control-allow-origin'), null);
    const brPre = await fetch(`${BASE}/bridge/${newToken()}/next`, { method: 'OPTIONS', headers: { origin: 'https://claude.ai' } });
    assert.equal(brPre.headers.get('access-control-allow-origin'), null);
    const tok = await fetch(`${BASE}/token`, { method: 'POST', headers: { origin: 'https://claude.ai' }, body: 'grant_type=x' });
    assert.equal(tok.headers.get('access-control-allow-origin'), null);
  });

  await step('/mcp body limit 1 MB; /health has no browser count', async () => {
    const id = idForToken(newToken());
    const big = await fetch(`${BASE}/mcp/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1100 * 1024) } }) }).catch((e) => ({ status: 'err:' + e.message }));
    assert.equal(big.status, 413);
    const h = await (await fetch(`${BASE}/health`)).json();
    assert.deepEqual(h, { ok: true, version: '1.0.0' });
    const s = await (await fetch(`${BASE}/`)).text();
    assert.match(s, /PullRows MCP relay/);
  });

  // ---------- OAuth ----------
  // Each OAuth step gets a fresh relay: the per-IP limit (30 req/min) would otherwise kick in.
  let OB = await startRelay({ PUBLIC_URL });
  const post = (p, body, headers = {}) => fetch(`${OB}${p}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) });
  const register = (uris) => fetch(`${OB}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: uris }) });
  const authorizeUrl = (params) => { const u = new URL(`${OB}/authorize`); Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v)); return u; };

  await step('OAuth discovery uses PUBLIC_URL (X-Forwarded-Host ignored)', async () => {
    const m = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`, { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' } })).json();
    assert.equal(m.issuer, PUBLIC_URL);
    assert.equal(m.authorization_endpoint, `${PUBLIC_URL}/authorize`);
    assert.equal(m.token_endpoint, `${PUBLIC_URL}/token`);
    assert.equal(m.registration_endpoint, `${PUBLIC_URL}/register`);
    const id = idForToken(newToken());
    const pr = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp/${id}`)).json();
    assert.equal(pr.resource, `${PUBLIC_URL}/mcp/${id}`);
    assert.deepEqual(pr.authorization_servers, [PUBLIC_URL]);
  });

  await step('OAuth exact redirect URI allow/deny (register + authorize)', async () => {
    for (const ok of [CALLBACK, 'https://claude.com/api/mcp/auth_callback', 'http://localhost:33418/callback', 'http://127.0.0.1:5173/oauth/cb']) {
      assert.equal((await register([ok])).status, 201, ok);
    }
    for (const bad of ['https://docs.anthropic.com/evil', 'https://claude.ai/api/mcp/auth_callback/x', 'https://claude.ai/other', 'http://claude.ai/api/mcp/auth_callback',
      'https://claude.ai/api/mcp/auth_callback?x=1', 'https://evil.example/cb', 'https://localhost:3000/cb', 'http://[::1]:3000/cb', 'http://user@localhost:3000/cb', 'javascript:alert(1)']) {
      assert.equal((await register([bad])).status, 400, bad);
    }
    assert.equal((await register([CALLBACK, 'https://evil.example/cb'])).status, 400);
    const evil = await fetch(authorizeUrl({ response_type: 'code', redirect_uri: 'https://docs.anthropic.com/evil', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' }), { redirect: 'manual' });
    assert.equal(evil.status, 400);
  });

  await step('OAuth PKCE flow works; code replay, forged refresh and token confusion rejected', async () => {
    OB = await startRelay({ PUBLIC_URL });
    const reg = await (await register([CALLBACK])).json();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const r = await fetch(authorizeUrl({ response_type: 'code', client_id: reg.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'st1', scope: 'mcp' }), { redirect: 'manual' });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, CALLBACK);
    assert.equal(loc.searchParams.get('state'), 'st1');
    const code = loc.searchParams.get('code');
    assert.ok(code);
    const noPkce = await fetch(authorizeUrl({ response_type: 'code', redirect_uri: CALLBACK, code_challenge_method: 'plain', code_challenge: challenge }), { redirect: 'manual' });
    assert.equal(new URL(noPkce.headers.get('location')).searchParams.get('error'), 'invalid_request');

    const exchange = (extra) => post('/token', { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: reg.client_id, ...extra });
    assert.equal((await exchange({ code_verifier: 'wrong-verifier' })).status, 400);
    assert.equal((await exchange({ code_verifier: verifier, redirect_uri: 'https://claude.com/api/mcp/auth_callback' })).status, 400);
    assert.equal((await exchange({ code_verifier: verifier, client_id: 'someone-else' })).status, 400);
    const ok = await exchange({ code_verifier: verifier });
    assert.equal(ok.status, 200);
    const tokens = await ok.json();
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(tokens.access_token && tokens.refresh_token);
    const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[0], 'base64url').toString());
    assert.equal(payload.cid, reg.client_id);
    const replay = await exchange({ code_verifier: verifier });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, 'invalid_grant');

    const refreshed = await post('/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id });
    assert.equal(refreshed.status, 200);
    const rp = JSON.parse(Buffer.from((await refreshed.json()).refresh_token.split('.')[0], 'base64url').toString());
    assert.equal(rp.cid, reg.client_id);
    assert.equal((await post('/token', { grant_type: 'refresh_token', refresh_token: 'aaaa.bbbb' })).status, 400);
    const forgedBody = Buffer.from(JSON.stringify({ t: 'refresh', cid: reg.client_id })).toString('base64url');
    assert.equal((await post('/token', { grant_type: 'refresh_token', refresh_token: `${forgedBody}.${tokens.refresh_token.split('.')[1]}` })).status, 400);
    assert.equal((await post('/token', { grant_type: 'refresh_token', refresh_token: tokens.access_token })).status, 400, 'access token is not a refresh token');
    assert.equal((await post('/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: 'other' })).status, 400);
    assert.equal((await post('/token', { grant_type: 'authorization_code', code: tokens.refresh_token, code_verifier: verifier })).status, 400, 'refresh token is not a code');
    assert.equal((await post('/token', { grant_type: 'password' })).status, 400);
  });

  await step('oversized OAuth body (> 16 KB) rejected with 413', async () => {
    OB = await startRelay({ PUBLIC_URL });
    const r = await fetch(`${OB}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK], pad: 'x'.repeat(20 * 1024) }) }).catch((e) => ({ status: 'err:' + e.message }));
    assert.equal(r.status, 413);
    const t = await fetch(`${OB}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&pad=' + 'x'.repeat(17 * 1024) }).catch((e) => ({ status: 'err:' + e.message }));
    assert.equal(t.status, 413);
  });

  console.log('relay (no PUBLIC_URL, no TRUST_PROXY):');
  const BASE2 = await startRelay();
  await step('X-Forwarded-Host / -Proto ignored by default', async () => {
    const m = await (await fetch(`${BASE2}/.well-known/oauth-authorization-server`, { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } })).json();
    assert.equal(m.issuer, BASE2);
    assert.equal(m.token_endpoint, `${BASE2}/token`);
  });
  await step('per-IP rate limit on OAuth endpoints (30/min) → 429', async () => {
    const codes = [];
    for (let i = 0; i < 32; i++) {
      const r = await fetch(`${BASE2}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=x.y' });
      codes.push(r.status);
      await r.arrayBuffer();
    }
    assert.ok(codes.slice(0, 30).every((c) => c === 400), codes.join(','));
    assert.equal(codes[31], 429);
  });

  console.log('relay (TRUST_PROXY=1, no PUBLIC_URL):');
  const BASE3 = await startRelay({ TRUST_PROXY: '1' });
  await step('behind a trusted proxy: X-Forwarded-Host / -Proto honoured', async () => {
    const m = await (await fetch(`${BASE3}/.well-known/oauth-authorization-server`, { headers: { 'x-forwarded-host': 'web-scrapper-extension.onrender.com', 'x-forwarded-proto': 'https' } })).json();
    assert.equal(m.issuer, 'https://web-scrapper-extension.onrender.com');
  });
} finally {
  for (const c of children) c.kill();
}
console.log(failures ? `\n${failures} step(s) failed, ${passed} passed` : `\nAll ${passed} steps passed`);
process.exit(failures ? 1 : 0);
