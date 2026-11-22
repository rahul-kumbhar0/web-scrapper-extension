// Long-polls the MCP relay for Claude's tool calls and executes them.
// Runs in an offscreen document (only chrome.runtime is available here), so browser
// operations go through the service worker via sw().
//
// Relay contract: the bridge authenticates with the secret token in the path; the MCP link the
// user gives Claude only contains a hash of it (see server/mcp-relay.mjs). A command
// { tool: '__cancel', args: { id } } aborts a running call the relay gave up on.
import { execute } from '../lib/mcp-exec.js';

const params = new URLSearchParams(location.search);
const SERVER = params.get('server');
const TOKEN = params.get('token');
const VERSION = params.get('v') || '';
const base = `${SERVER}/bridge/${encodeURIComponent(TOKEN)}`;
const MAX_PARALLEL = 2;

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

// ---------- execution: at most MAX_PARALLEL commands at once, the rest wait their turn ----------
const running = new Map(); // id -> AbortController
const waiting = [];

function setBusy() { sw('busy', running.size + waiting.length).catch(() => {}); }

async function deliver(body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${base}/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok || res.status === 404) return; // 404: the relay already gave up on this call
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  console.warn('could not deliver result', body.id);
}

async function handle(cmd) {
  const ctrl = new AbortController();
  running.set(cmd.id, ctrl);
  setBusy();
  const t0 = Date.now();
  let payload;
  try {
    payload = await execute(cmd.tool, cmd.args || {}, sw, ctrl.signal);
  } catch (e) {
    payload = { isError: true, content: [{ type: 'text', text: ctrl.signal.aborted ? 'Cancelled.' : `Error: ${e?.message || e}` }] };
  }
  running.delete(cmd.id);
  sw('log', { tool: cmd.tool, args: JSON.stringify(cmd.args || {}).slice(0, 300), ok: !payload.isError, ms: Date.now() - t0 }).catch(() => {});
  if (!ctrl.signal.aborted) await deliver({ id: cmd.id, ...payload });
  // This command waited in the relay's offline queue while the computer was away: notify the user.
  if (cmd.queued && !ctrl.signal.aborted) sw('queuedDone', { tool: cmd.tool }).catch(() => {});
  pump();
}

function pump() {
  while (running.size < MAX_PARALLEL && waiting.length) handle(waiting.shift());
  setBusy();
}

function accept(cmd) {
  if (cmd.tool === '__cancel') {
    const id = cmd.args?.id;
    // Free the slot at once: browser work started for the call may take a while to wind down, and
    // two zombie calls would otherwise block every new one.
    const ctrl = running.get(id);
    if (ctrl) { ctrl.abort(); running.delete(id); pump(); }
    const i = waiting.findIndex((c) => c.id === id);
    if (i >= 0) waiting.splice(i, 1);
    setBusy();
    return;
  }
  waiting.push(cmd);
  pump();
}

// A long-poll that is never answered (sleep/wake, captive portal, a proxy that holds the socket
// open) would otherwise hang this loop for ever while the UI still says "Connected".
const POLL_TIMEOUT_MS = 90000;
const HANDSHAKE_TIMEOUT_MS = 20000;
const withTimeout = (url, ms) => fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(ms) });
const isTimeout = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';

async function loop() {
  let backoff = 1000;
  for (;;) {
    try {
      if (state !== 'connected') {
        // Quick handshake so the UI shows "Connected" without waiting for a long-poll to return.
        const hs = await withTimeout(`${base}/status?v=${encodeURIComponent(VERSION)}`, HANDSHAKE_TIMEOUT_MS);
        if (hs.status === 404) throw new Error('Relay rejected this connector token');
        if (!hs.ok) throw new Error(`Relay error ${hs.status}`);
        status('connected');
      }
      const res = await withTimeout(`${base}/next?v=${encodeURIComponent(VERSION)}`, POLL_TIMEOUT_MS);
      if (res.status === 404) throw new Error('Relay rejected this connector token');
      if (res.status === 429) throw new Error('Relay is rate limiting this browser');
      if (!res.ok && res.status !== 204) throw new Error(`Relay error ${res.status}`);
      status('connected');
      backoff = 1000;
      if (res.status === 200) accept(await res.json());
    } catch (e) {
      // A poll that simply ran out of time is normal: re-poll instead of backing off and telling
      // the user the connector is broken. A handshake that times out means the relay is not
      // answering at all, so wait a moment first rather than spinning.
      if (isTimeout(e)) {
        if (state !== 'connected') await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      status('error', { error: String(e.message || e), force: true });
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

// Scheduled monitors: the service worker asks this document to run a saved recipe in the
// background (fetch + DOMParser are available here). The run can take many minutes and a pending
// sendMessage response does not keep an MV3 service worker alive, so the start is ACKed at once
// and the result goes back later as its own 'monitor-result' message (which wakes the worker).
const monitorRuns = new Set(); // monitorIds running in this document
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'monitor-run' || sender.id !== chrome.runtime.id || sender.tab) return false;
  if (monitorRuns.has(msg.monitorId)) { sendResponse({ started: true, already: true }); return false; }
  monitorRuns.add(msg.monitorId);
  sendResponse({ started: true });
  const opts = { internal: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20 * 60000);
  execute('recipe_run', { recipe_id: msg.recipeId, max_rows_returned: 1 }, sw, ctrl.signal, opts)
    .then((res) => {
      if (res?.isError) throw new Error(res.content?.[0]?.text?.replace(/^Error:\s*/, '') || 'Run failed');
      const sheets = opts.captured?.sheets || [];
      return { monitorId: msg.monitorId, rows: sheets[0]?.rows || [] };
    })
    .catch((e) => ({ monitorId: msg.monitorId, rows: [], error: String(e?.message || e) }))
    .then((result) => chrome.runtime.sendMessage({ type: 'monitor-result', ...result }).catch(() => {}))
    .finally(() => { clearTimeout(timer); monitorRuns.delete(msg.monitorId); });
  return false;
});

// Without a relay address this document only runs monitors (the Claude connector is off).
if (SERVER && TOKEN) {
  status('connecting');
  loop();
}
