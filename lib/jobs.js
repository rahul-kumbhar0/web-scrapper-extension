// LONG JOBS — work that cannot finish inside one Claude tool call.
//
// Claude's client gives up on a tool call after about a minute. Scanning a whole account (every
// reel, its transcript, its numbers) takes far longer than that, so the call only *starts* the
// job and returns its id; the job keeps running in the offscreen document and Claude asks
// job_status for progress and for the rows collected so far.
//
// State lives in chrome.storage.local so the side panel can show it too, and so a job that dies
// with the document (the connector being switched off, Chrome quitting) is still visible
// afterwards instead of just vanishing.
const KEY = (id) => `job:${id}`;
const INDEX = 'jobs';
const KEEP = 20;
const STALE_MS = 3 * 60000; // no heartbeat for this long = the document that ran it is gone

const running = new Map(); // id -> AbortController

// Jobs run in the offscreen document's copy of this module, but "Stop" is clicked in the side
// panel's copy, where `running` is empty. The cancel is therefore broadcast, and whichever
// context actually holds the controller aborts it.
chrome.runtime.onMessage?.addListener((msg, sender) => {
  if (msg?.type !== 'job-cancel' || sender.id !== chrome.runtime.id) return false;
  running.get(msg.id)?.abort(new Error('Cancelled'));
  return false;
});

const nowIso = () => new Date().toISOString();

export async function listJobs() {
  const { [INDEX]: ids = [] } = await chrome.storage.local.get(INDEX);
  const rows = await chrome.storage.local.get(ids.map(KEY));
  return ids.map((id) => rows[KEY(id)]).filter(Boolean).map(withStall);
}

export async function getJob(id) {
  const job = (await chrome.storage.local.get(KEY(id)))[KEY(id)];
  return job ? withStall(job) : null;
}

// A job whose runner disappeared is reported as stalled, not as "running for ever".
function withStall(job) {
  if (job.status !== 'running' || running.has(job.id)) return job;
  if (Date.now() - (job.beatAt || job.startedAt || 0) < STALE_MS) return job;
  return { ...job, status: 'stalled', error: 'The job stopped: PullRows was closed, the connector was switched off, or Chrome restarted. Start it again.' };
}

async function write(job) {
  await chrome.storage.local.set({ [KEY(job.id)]: job });
  const { [INDEX]: ids = [] } = await chrome.storage.local.get(INDEX);
  if (!ids.includes(job.id)) {
    const next = [job.id, ...ids];
    const drop = next.slice(KEEP);
    await chrome.storage.local.set({ [INDEX]: next.slice(0, KEEP) });
    if (drop.length) await chrome.storage.local.remove(drop.map(KEY));
  }
}

/**
 * Start a job. `run(ctx)` gets { signal, progress(note, done, total), partial(rows) } and
 * resolves with the finished result { rows, columns, summary, notes }.
 * Returns the stored job record immediately — it does NOT wait for the work.
 */
export async function startJob({ kind, title, target, total = 0 }, run) {
  const id = crypto.randomUUID().slice(0, 8);
  const ctrl = new AbortController();
  running.set(id, ctrl);
  const job = {
    id, kind, title, target, status: 'running', note: 'Starting…',
    done: 0, total, rows: [], columns: [], notes: [],
    startedAt: Date.now(), beatAt: Date.now(), startedIso: nowIso(),
  };
  await write(job);

  const save = async (patch) => {
    const cur = (await getJob(id)) || job;
    // A job the user cancelled stays cancelled: the runner winding down after the abort must not
    // flip it back to "done" (its work may even complete normally once the abort races the end).
    if (cur.status === 'cancelled' && patch.status && patch.status !== 'cancelled') return;
    await write({ ...cur, ...patch, beatAt: Date.now() });
  };
  // Progress is throttled: a 300-video scan should not write to storage 300 times a second.
  let lastBeat = 0;
  const ctx = {
    signal: ctrl.signal,
    async progress(note, done, total2) {
      const t = Date.now();
      if (t - lastBeat < 1200 && note !== undefined) return;
      lastBeat = t;
      await save({ note: String(note || ''), ...(done != null ? { done } : {}), ...(total2 != null ? { total: total2 } : {}) });
    },
    // Rows as they are collected, so Claude can start reading before the job ends.
    async partial(rows, columns) {
      lastBeat = Date.now();
      await save({ rows, ...(columns ? { columns } : {}) });
    },
  };

  // A long silent phase (a 15-minute profile scroll makes no progress() calls) must not look like
  // a dead runner to the other contexts reading this job: beat while it is alive here.
  const beat = setInterval(() => { save({}).catch(() => {}); }, 60000);

  run(ctx)
    .then(async (res) => {
      await save({ status: 'done', note: res?.summary || 'Finished.', rows: res?.rows ?? [], columns: res?.columns ?? [], notes: res?.notes ?? [], finishedAt: Date.now(), done: (res?.rows || []).length, total: (res?.rows || []).length });
    })
    .catch(async (e) => {
      const cancelled = ctrl.signal.aborted;
      await save({ status: cancelled ? 'cancelled' : 'error', error: cancelled ? '' : String(e?.message || e), note: cancelled ? 'Cancelled.' : `Stopped: ${String(e?.message || e)}`, finishedAt: Date.now() });
    })
    .finally(() => { clearInterval(beat); running.delete(id); });

  return job;
}

export async function cancelJob(id) {
  const ctrl = running.get(id);
  if (ctrl) ctrl.abort(new Error('Cancelled'));
  else chrome.runtime.sendMessage({ type: 'job-cancel', id }, () => void chrome.runtime.lastError); // it runs in another context
  const job = await getJob(id);
  if (job && job.status === 'running') await write({ ...job, status: 'cancelled', note: 'Cancelled.', finishedAt: Date.now() });
  return !!job;
}

export async function deleteJob(id) {
  const { [INDEX]: ids = [] } = await chrome.storage.local.get(INDEX);
  await chrome.storage.local.set({ [INDEX]: ids.filter((x) => x !== id) });
  await chrome.storage.local.remove(KEY(id));
}
