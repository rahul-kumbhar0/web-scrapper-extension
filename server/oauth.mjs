// Minimal OAuth 2.1 authorization server so MCP clients that insist on a sign-in step
// (claude.ai's "Connect" button: discovery → dynamic client registration → authorize → token)
// can complete it.
//
// It auto-approves: the real credential is the secret in the MCP URL path (/mcp/<token>), and
// the access tokens issued here grant nothing on their own. Codes are stateless (HMAC-signed)
// so a server restart between steps doesn't break sign-in, and PKCE (S256) is enforced.

import crypto from 'node:crypto';

const SECRET = process.env.OAUTH_SECRET || crypto.randomBytes(32).toString('hex');
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_S = 30 * 24 * 3600;

// Where the browser may be sent back to after "sign-in" (no open redirects).
const ALLOWED_REDIRECT_HOSTS = /^(claude\.ai|claude\.com|([\w-]+\.)*anthropic\.com|localhost|127\.0\.0\.1|\[::1\])$/i;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(crypto.createHmac('sha256', SECRET).update(body).digest())}`;
};
const verify = (tok) => {
  const [body, sig] = String(tok || '').split('.');
  if (!body || !sig) return null;
  const want = b64u(crypto.createHmac('sha256', SECRET).update(body).digest());
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
};

export function publicBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

function redirectAllowed(uri) {
  try {
    const u = new URL(uri);
    return (u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) && ALLOWED_REDIRECT_HOSTS.test(u.hostname);
  } catch { return false; }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] || '').includes('application/json')) { try { return JSON.parse(raw || '{}'); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw));
}

// Returns true if the request was an OAuth request (and has been answered).
export async function handleOAuth(req, res, url, send) {
  const base = publicBase(req);
  const p = url.pathname;

  // RFC 9728 — protected resource metadata (also the path-suffixed form for /mcp/<token>).
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

  // RFC 7591 — dynamic client registration (stateless: any client may register).
  if (p === '/register' && req.method === 'POST') {
    const body = await readBody(req);
    const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!redirects.length || !redirects.every(redirectAllowed)) {
      send(res, 400, { error: 'invalid_redirect_uri', error_description: 'Redirect URIs must be Claude (claude.ai / claude.com) or localhost.' });
      return true;
    }
    send(res, 201, {
      client_id: `wsc_${crypto.randomBytes(12).toString('hex')}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: body.client_name || 'MCP client',
      redirect_uris: redirects,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    return true;
  }

  // Authorization endpoint — auto-approve and bounce back with a signed code.
  if (p === '/authorize' && req.method === 'GET') {
    const q = url.searchParams;
    const redirectUri = q.get('redirect_uri');
    if (!redirectUri || !redirectAllowed(redirectUri)) {
      send(res, 400, '<h1>Invalid redirect_uri</h1>');
      return true;
    }
    const back = new URL(redirectUri);
    if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
      back.searchParams.set('error', 'invalid_request');
      back.searchParams.set('error_description', 'response_type=code with PKCE S256 is required');
    } else {
      back.searchParams.set('code', sign({ t: 'code', cid: q.get('client_id'), ru: redirectUri, cc: q.get('code_challenge'), exp: Date.now() + CODE_TTL_MS }));
    }
    if (q.get('state')) back.searchParams.set('state', q.get('state'));
    res.writeHead(302, { location: back.href, 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  // Token endpoint — exchange code (PKCE-checked) or refresh token.
  if (p === '/token' && req.method === 'POST') {
    const body = await readBody(req);
    const issue = (cid) => send(res, 200, {
      access_token: sign({ t: 'access', cid, exp: Date.now() + ACCESS_TTL_S * 1000 }),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: sign({ t: 'refresh', cid }),
      scope: 'mcp',
    }, { 'cache-control': 'no-store' });
    if (body.grant_type === 'authorization_code') {
      const code = verify(body.code);
      const challenge = b64u(crypto.createHash('sha256').update(String(body.code_verifier || '')).digest());
      if (!code || code.t !== 'code' || code.exp < Date.now() || code.cc !== challenge || (body.redirect_uri && body.redirect_uri !== code.ru)) {
        send(res, 400, { error: 'invalid_grant' });
        return true;
      }
      issue(code.cid);
      return true;
    }
    if (body.grant_type === 'refresh_token') {
      // Refresh tokens are only a formality here (see header); accept ours even across restarts.
      const r = verify(body.refresh_token);
      if (!r && !/^[\w-]+\.[\w-]+$/.test(String(body.refresh_token || ''))) { send(res, 400, { error: 'invalid_grant' }); return true; }
      issue(r?.cid || body.client_id || 'client');
      return true;
    }
    send(res, 400, { error: 'unsupported_grant_type' });
    return true;
  }

  return false;
}
