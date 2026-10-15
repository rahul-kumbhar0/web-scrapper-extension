// Long-polls the MCP relay for Claude's tool calls and executes them.
// Runs in an offscreen document (only chrome.runtime is available here), so browser
// operations go through the service worker via sw().
import { execute } from '../lib/mcp-exec.js';

const params = new URLSearchParams(location.search);
const SERVER = params.get('server');
const TOKEN = params.get('token');
const VERSION = params.get('v') || '';
const base = `${SERVER}/bridge/${encodeURIComponent(TOKEN)}`;

export function sw(op, arg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'bridge-op', op, arg }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.err) return reject(new Error(res.err));
      resolve(res?.ok);
    });
  });
}

let state = '';
function status(next, extra = {}) {
  if (next === state && !extra.force) return;
  state = next;
  sw('status', { state: next, server: SERVER, ...extra }).catch(() => {});
}

async function handle(cmd) {
  const t0 = Date.now();
  let payload;
  try {
    payload = await execute(cmd.tool, cmd.args || {}, sw);
  } catch (e) {
    payload = { isError: true, content: [{ type: 'text', text: `Error: ${e?.message || e}` }] };
  }
  sw('log', { tool: cmd.tool, args: JSON.stringify(cmd.args || {}).slice(0, 200), ok: !payload.isError, ms: Date.now() - t0 }).catch(() => {});
  await fetch(`${base}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: cmd.id, ...payload }),
  }).catch((e) => console.warn('could not deliver result', e));
}

async function loop() {
  let backoff = 1000;
  for (;;) {
    try {
      if (state !== 'connected') {
        // Quick handshake so the UI shows "Connected" without waiting for a long-poll to return.
        const hs = await fetch(`${base}/status?v=${encodeURIComponent(VERSION)}`, { cache: 'no-store' });
        if (hs.status === 404) throw new Error('Relay rejected this connector token');
        if (!hs.ok) throw new Error(`Relay error ${hs.status}`);
        status('connected');
      }
      const res = await fetch(`${base}/next?v=${encodeURIComponent(VERSION)}`, { cache: 'no-store' });
      if (res.status === 404) throw new Error('Relay rejected this connector token');
      if (!res.ok && res.status !== 204) throw new Error(`Relay error ${res.status}`);
      status('connected');
      backoff = 1000;
      if (res.status === 200) {
        const cmd = await res.json();
        handle(cmd); // run concurrently; keep polling for the next command
      }
    } catch (e) {
      status('error', { error: String(e.message || e), force: true });
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

status('connecting');
loop();
