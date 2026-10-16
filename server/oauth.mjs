// Minimal OAuth 2.1 authorization server so MCP clients that insist on a sign-in step
// (claude.ai's "Connect" button: discovery → dynamic client registration → authorize → token)
// can complete it.
//
// Be clear about what this is: it AUTO-APPROVES every request. There is no user login here. The
// real credential is the secret id in the MCP URL path (/mcp/<id>), and the access tokens issued
// here are not checked by the relay — they grant nothing on their own. What this layer does
// guarantee:
//   - codes and tokens are HMAC-signed (OAUTH_SECRET), so forged codes/refresh tokens are refused;
//   - PKCE S256 is required and authorization codes are single-use;
//   - the browser is only ever redirected to Claude's exact callback URLs or to a localhost
//     callback (Claude Code / Claude Desktop), so this can't be used as an open redirect;
//   - the issuer/endpoints come from PUBLIC_URL when set, never from spoofable forwarded headers
//     (X-Forwarded-* are honoured only with TRUST_PROXY=1).
// Codes are stateless apart from the in-memory "already used" set, so a restart between authorize
// and token doesn't break sign-in. Set OAUTH_SECRET in production so tokens survive restarts.

import crypto from 'node:crypto';

const ENV_SECRET = process.env.OAUTH_SECRET || '';
const SECRET = ENV_SECRET || crypto.randomBytes(32).toString('hex');
if (!ENV_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('\n!!! WARNING: OAUTH_SECRET is not set. A random secret is used, so every restart signs users out of the\n!!! PullRows connector in Claude (their refresh tokens stop working). Set OAUTH_SECRET to a long random value.\n');
}
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_S = 30 * 24 * 3600;
const REFRESH_TTL_MS = 180 * 24 * 3600 * 1000;
const BODY_LIMIT = 16 * 1024;

// Exact redirect URIs for Claude on the web; localhost callbacks (any port/path) for local clients.
const CLAUDE_CALLBACKS = new Set(['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']);

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const mac = (body) => b64u(crypto.createHmac('sha256', SECRET).update(body).digest());
const sign = (payload) => {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${mac(body)}`;
};
const verify = (tok) => {
  const parts = String(tok || '').split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const want = mac(body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
};

// Single-use authorization codes: nonce -> expiry.
const usedCodes = new Map();
setInterval(() => { const now = Date.now(); for (const [n, exp] of usedCodes) if (exp < now) usedCodes.delete(n); }, 60000).unref();

const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;
export function publicBase(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const first = (v) => String(v || '').split(',')[0].trim();
  let proto = req.socket.encrypted ? 'https' : 'http';
  let host = first(req.headers.host);
  if (TRUST_PROXY) {
    const fp = first(req.headers['x-forwarded-proto']).toLowerCase();
    if (fp === 'https' || fp === 'http') proto = fp;
    host = first(req.headers['x-forwarded-host']) || host;
  }
  if (!HOST_RE.test(host)) host = 'localhost';
  return `${proto}://${host}`;
}

export function redirectAllowed(uri) {
  if (typeof uri !== 'string') return false;
  if (CLAUDE_CALLBACKS.has(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && !u.username && !u.password && !u.hash;
  } catch { return false; }
}

class TooLarge extends Error {}
async function readBody(req) {
  if (Number(req.headers['content-length'] || 0) > BODY_LIMIT) throw new TooLarge();
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > BODY_LIMIT) throw new TooLarge();
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

// Client credentials may also arrive as HTTP Basic (client_secret_basic); we only need the id.
function clientIdOf(req, body) {
  if (body.client_id) return String(body.client_id);
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m) { try { return decodeURIComponent(Buffer.from(m[1], 'base64').toString().split(':')[0]); } catch {} }
  return '';
}

// Returns true if the request was an OAuth request (and has been answered).
export async function handleOAuth(req, res, url, send) {
  const p = url.pathname;
  const isOAuth = p.startsWith('/.well-known/oauth-') || p.startsWith('/.well-known/openid-configuration') || p === '/register' || p === '/authorize' || p === '/token';
  if (!isOAuth) return false;
  const base = publicBase(req);
  try {
    // RFC 9728 — protected resource metadata (also the path-suffixed form for /mcp/<id>).
    if (p === '/.well-known/oauth-protected-resource' || p.startsWith('/.well-known/oauth-protected-resource/')) {
      const resourcePath = p.slice('/.well-known/oauth-protected-resource'.length);
      send(res, 200, { resource: `${base}${resourcePath}`, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: ['mcp'] });
      return true;
    }

    // RFC 8414 / OIDC discovery — authorization server metadata.
    if (p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/.well-known/openid-configuration')) {
      send(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        scopes_supported: ['mcp'],
      });
      return true;
    }

    // RFC 7591 — dynamic client registration (stateless: any client with allowed redirect URIs).
    if (p === '/register' && req.method === 'POST') {
      const body = await readBody(req);
      const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
      if (!redirects.length || redirects.length > 10 || !redirects.every(redirectAllowed)) {
        send(res, 400, { error: 'invalid_redirect_uri', error_description: 'Redirect URIs must be https://claude.ai/api/mcp/auth_callback, https://claude.com/api/mcp/auth_callback, or an http://localhost / http://127.0.0.1 callback.' });
        return true;
      }
      send(res, 201, {
        client_id: `prc_${crypto.randomBytes(12).toString('hex')}`,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: String(body.client_name || 'MCP client').slice(0, 100),
        redirect_uris: redirects,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }, { 'cache-control': 'no-store' });
      return true;
    }

    // Authorization endpoint — auto-approve and bounce back with a signed, single-use code.
    if (p === '/authorize' && req.method === 'GET') {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri');
      if (!redirectUri || !redirectAllowed(redirectUri)) {
        send(res, 400, '<!doctype html><meta charset="utf-8"><title>PullRows</title><h1>Invalid redirect_uri</h1>');
        return true;
      }
      const back = new URL(redirectUri);
      const challenge = q.get('code_challenge') || '';
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
        back.searchParams.set('error', 'invalid_request');
        back.searchParams.set('error_description', 'response_type=code with PKCE S256 is required');
      } else {
        back.searchParams.set('code', sign({
          t: 'code',
          n: b64u(crypto.randomBytes(16)),
          cid: String(q.get('client_id') || '').slice(0, 200),
          ru: redirectUri,
          cc: challenge,
          exp: Date.now() + CODE_TTL_MS,
        }));
      }
      if (q.get('state')) back.searchParams.set('state', q.get('state').slice(0, 1024));
      res.writeHead(302, { location: back.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end();
      return true;
    }

    // Token endpoint — exchange a code (PKCE-checked, once) or a refresh token (signature-checked).
    if (p === '/token' && req.method === 'POST') {
      const body = await readBody(req);
      const clientId = clientIdOf(req, body);
      const now = Date.now();
      const issue = (cid) => send(res, 200, {
        access_token: sign({ t: 'access', cid, n: b64u(crypto.randomBytes(9)), exp: now + ACCESS_TTL_S * 1000 }),
        token_type: 'Bearer',
        expires_in: ACCESS_TTL_S,
        refresh_token: sign({ t: 'refresh', cid, n: b64u(crypto.randomBytes(9)), exp: now + REFRESH_TTL_MS }),
        scope: 'mcp',
      }, { 'cache-control': 'no-store', pragma: 'no-cache' });
      const invalid = (desc) => send(res, 400, { error: 'invalid_grant', error_description: desc }, { 'cache-control': 'no-store' });

      if (body.grant_type === 'authorization_code') {
        const code = verify(body.code);
        const challenge = b64u(crypto.createHash('sha256').update(String(body.code_verifier || '')).digest());
        if (!code || code.t !== 'code' || typeof code.n !== 'string' || !(code.exp > now)) { invalid('Invalid or expired code'); return true; }
        if (usedCodes.has(code.n)) { invalid('Code already used'); return true; }
        if (code.cc !== challenge) { invalid('PKCE verification failed'); return true; }
        if (body.redirect_uri && body.redirect_uri !== code.ru) { invalid('redirect_uri mismatch'); return true; }
        if (clientId && code.cid && clientId !== code.cid) { invalid('client_id mismatch'); return true; }
        usedCodes.set(code.n, code.exp);
        issue(code.cid || clientId);
        return true;
      }
      if (body.grant_type === 'refresh_token') {
        const r = verify(body.refresh_token);
        if (!r || r.t !== 'refresh' || (r.exp && !(r.exp > now))) { invalid('Invalid refresh token'); return true; }
        if (clientId && r.cid && clientId !== r.cid) { invalid('client_id mismatch'); return true; }
        issue(r.cid || clientId);
        return true;
      }
      send(res, 400, { error: 'unsupported_grant_type' });
      return true;
    }

    send(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (e) {
    if (e instanceof TooLarge) {
      send(res, 413, { error: 'invalid_request', error_description: 'Request body too large' }, { connection: 'close' });
      return true;
    }
    throw e;
  }
}
