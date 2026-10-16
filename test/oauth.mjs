// Relay sign-in flow as claude.ai performs it when you press "Connect" on a custom connector.
//   node test/oauth.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const relay = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-relay.mjs')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', TRUST_PROXY: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => relay.stdout.on('data', (d) => String(d).includes('listening') && r()));
const BASE = `http://127.0.0.1:${PORT}`;
const MCP = `${BASE}/mcp/${'x'.repeat(32)}`;
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

let failures = 0;
const step = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); } };
const json = async (r) => ({ status: r.status, body: await r.json() });

try {
  let meta;
  let clientId;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  let code;

  await step('discovery: protected-resource + authorization-server metadata', async () => {
    const pr = await json(await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp/${'x'.repeat(32)}`));
    assert.equal(pr.status, 200);
    assert.equal(pr.body.authorization_servers[0], BASE);
    meta = (await json(await fetch(`${BASE}/.well-known/oauth-authorization-server`))).body;
    assert.equal(meta.registration_endpoint, `${BASE}/register`);
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  });

  await step('dynamic client registration (and rejection of foreign redirect URIs)', async () => {
    const ok = await json(await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }) }));
    assert.equal(ok.status, 201);
    clientId = ok.body.client_id;
    const bad = await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
    assert.equal(bad.status, 400);
  });

  await step('authorize: auto-approves and redirects back with code + state', async () => {
    const u = new URL(meta.authorization_endpoint);
    Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'st123', scope: 'mcp', resource: MCP }).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, CALLBACK);
    assert.equal(loc.searchParams.get('state'), 'st123');
    code = loc.searchParams.get('code');
    assert.ok(code);
    const evil = await fetch(`${meta.authorization_endpoint}?response_type=code&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=x&code_challenge_method=S256`, { redirect: 'manual' });
    assert.equal(evil.status, 400);
  });

  let tokens;
  await step('token: wrong PKCE verifier rejected, right one accepted, refresh works', async () => {
    const post = (body) => fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    assert.equal((await post({ grant_type: 'authorization_code', code, code_verifier: 'wrong', redirect_uri: CALLBACK, client_id: clientId })).status, 400);
    const ok = await json(await post({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK, client_id: clientId }));
    assert.equal(ok.status, 200);
    tokens = ok.body;
    assert.equal(tokens.token_type, 'Bearer');
    const ref = await json(await post({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
    assert.equal(ref.status, 200);
  });

  await step('MCP initialize with the Bearer token (and without one)', async () => {
    const init = (headers) => fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } } }) }).then(json);
    const a = await init({ authorization: `Bearer ${tokens.access_token}` });
    assert.equal(a.body.result.serverInfo.name, 'pullrows');
    const b = await init({});
    assert.equal(b.body.result.serverInfo.name, 'pullrows');
  });

  await step('behind a proxy (Render): metadata uses the public https URL', async () => {
    const m = (await json(await fetch(`${BASE}/.well-known/oauth-authorization-server`, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'web-scrapper-extension.onrender.com' } }))).body;
    assert.equal(m.issuer, 'https://web-scrapper-extension.onrender.com');
    assert.equal(m.token_endpoint, 'https://web-scrapper-extension.onrender.com/token');
  });
} finally {
  relay.kill();
}
console.log(failures ? `\n${failures} step(s) failed` : '\nAll steps passed');
process.exit(failures ? 1 : 0);
