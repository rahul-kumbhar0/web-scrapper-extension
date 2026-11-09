// Free vs Pro. A Pro licence key (sold through Dodo Payments) is activated once per browser and
// re-validated daily; if the licence server can't be reached Pro keeps working for a grace period.
// Usable from the side panel, the service worker and the offscreen bridge.
import { LICENSE_API } from './config.js';

export const FREE_LIMITS = {
  listPages: 10, // Next / Load more pages per run
  scrollSteps: 60, // infinite-scroll steps per run
  pageUrls: 25, // Page Extractor URLs per run
  contactSites: 25, // Email / Social finder sites per run
  images: 100, // images downloaded per run
  shopifyProducts: 100,
  sitemapUrls: 1000,
  textUrls: 25,
  recipes: 3,
  mcpCallsPerDay: 25, // Claude connector tool calls per day
  trendPosts: 30, // posts scanned per Trend Finder run
  transcripts: 0, // video scripts (transcripts) per Trend Finder run: Pro
  monitors: 1, // scheduled recipe monitors (free: daily at most)
};
const UNLIMITED = Object.fromEntries(Object.keys(FREE_LIMITS).map((k) => [k, Infinity]));

// Features only Pro has (everything else is free, within the limits above).
export const PRO_ONLY = {
  xlsx: 'Excel export',
  json: 'JSON export',
  transcripts: 'Video scripts (transcripts)',
  hourly: 'Hourly monitors',
  sheetSync: 'Auto-sync to Google Sheets',
  enrich: 'AI lead enrichment',
};

const REVALIDATE_MS = 24 * 3600 * 1000;
export const TRIAL_DAYS = 3;
const TRIAL_MS = TRIAL_DAYS * 24 * 3600 * 1000;
const GRACE_MS = 14 * 24 * 3600 * 1000;

const FREE = { plan: 'free' };

// ---------- offline developer key ----------
// "Load unpacked" copies (the developer's own testing, and test/e2e.mjs) may use the offline
// developer key and a test licence server. A Web Store copy honours neither, so neither can be
// used to unlock Pro there. Two independent signals have to agree: Chrome reports installType
// "development" only for an unpacked copy, and writes update_url into the manifest only for a
// Store copy. getSelf() is one of the two management methods that need no "management" permission.
export const DEV_KEY = 'PULLROWS-DEV-TEST-0000';
const noUpdateUrl = () => { try { return !chrome.runtime.getManifest().update_url; } catch { return false; } };
let devInstall = null;
function isDevInstall() {
  devInstall ??= (chrome.management?.getSelf
    ? chrome.management.getSelf().then((m) => m.installType === 'development').catch(noUpdateUrl)
    : Promise.resolve(noUpdateUrl())).then((dev) => dev && noUpdateUrl());
  return devInstall;
}
const isDevLicense = (lic) => lic?.dev === true && lic.key === DEV_KEY;

// A paid licence wins; otherwise an unexpired trial counts as Pro.
// The trial window is recomputed from startedAt rather than trusted from endsAt, so a hand-edited
// endsAt far in the future does not extend it.
export async function getLicense() {
  const { license: stored, trial } = await chrome.storage.local.get(['license', 'trial']);
  // A dev-key licence outside the build it was made for counts as no licence at all — including on
  // the way out of this function, where the stored object is otherwise returned verbatim.
  const license = isDevLicense(stored) && !(await isDevInstall()) ? FREE : stored;
  if (license?.plan === 'pro') return license;
  const ends = trialEndsAt(trial);
  if (ends > Date.now()) return { plan: 'pro', trial: true, endsAt: ends };
  return license?.plan ? license : FREE;
}

function trialEndsAt(trial) {
  const started = Number(trial?.startedAt) || 0;
  if (!started || started > Date.now() + 60000) return 0; // missing, or dated in the future
  return Math.min(Number(trial?.endsAt) || 0, started + TRIAL_MS);
}

// ---------- free trial: once per browser, no card ----------
export async function getTrial() {
  const { trial } = await chrome.storage.local.get('trial');
  return trial || null;
}

export async function startTrial() {
  if (await getTrial()) throw new Error('The free trial has already been used in this browser.');
  const now = Date.now();
  await chrome.storage.local.set({ trial: { startedAt: now, endsAt: now + TRIAL_MS } });
  return getLicense();
}

export const isPro = (lic) => lic?.plan === 'pro';
export const limitsFor = (lic) => (isPro(lic) ? UNLIMITED : FREE_LIMITS);

// The override is honoured only in an unpacked copy. In a Store build the licence API is fixed,
// so a storage write cannot turn "activate Pro" into "point validation at your own server".
async function apiBase() {
  const { devLicenseApi } = await chrome.storage.local.get('devLicenseApi'); // tests only
  return devLicenseApi && (await isDevInstall()) ? devLicenseApi : LICENSE_API;
}

async function post(path, body) {
  const res = await fetch(`${await apiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.message || json?.error || json?.code || `HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.status = res.status;
    throw err;
  }
  return json;
}

const browserLabel = () => {
  const platform = navigator.userAgentData?.platform || '';
  return `PullRows — Chrome${platform ? ` on ${platform}` : ''}`.slice(0, 60);
};

export async function activate(key) {
  key = String(key || '').trim();
  if (key.length < 8) throw new Error('That doesn’t look like a licence key.');
  if (key.toUpperCase() === DEV_KEY) {
    if (!(await isDevInstall())) throw new Error('This licence key is not valid.');
    const license = { plan: 'pro', key: DEV_KEY, dev: true, instanceId: 'dev', activatedAt: Date.now(), validatedAt: Date.now(), status: 'active' };
    await chrome.storage.local.set({ license });
    return license;
  }
  let res;
  try {
    res = await post('/licenses/activate', { license_key: key, name: browserLabel() });
  } catch (e) {
    if (e.status === 404 || e.status === 400 || e.status === 422) throw new Error('This licence key is not valid.');
    if (e.status === 403 || e.status === 409) throw new Error(`Activation refused: ${e.message} (each licence works in 3 browsers — deactivate one first).`);
    throw new Error(`Could not reach the licence server: ${e.message}`);
  }
  const license = { plan: 'pro', key, instanceId: res.id || res.license_key_instance_id || '', activatedAt: Date.now(), validatedAt: Date.now(), status: 'active' };
  await chrome.storage.local.set({ license });
  return license;
}

export async function deactivate() {
  const lic = await getLicense();
  if (lic.key && lic.instanceId && lic.key !== DEV_KEY) {
    await post('/licenses/deactivate', { license_key: lic.key, license_key_instance_id: lic.instanceId }).catch(() => {});
  }
  await chrome.storage.local.set({ license: FREE });
  return FREE;
}

// Re-check a Pro licence once a day. Network trouble never downgrades within the grace period.
export async function refreshLicense({ force = false } = {}) {
  const lic = await getLicense();
  if (lic.trial) return lic; // nothing to validate
  // The developer key is never checked online. In a Store copy getLicense has already stripped it,
  // so lic is free here and this branch is not taken.
  if (isDevLicense(lic)) return lic;
  const age = Date.now() - (lic.validatedAt || 0);
  // A timestamp in the future is not "recently checked".
  if (!isPro(lic) || (!force && age >= 0 && age < REVALIDATE_MS)) return lic;
  try {
    const res = await post('/licenses/validate', { license_key: lic.key, ...(lic.instanceId ? { license_key_instance_id: lic.instanceId } : {}) });
    const next = res.valid === false
      ? { plan: 'free', key: lic.key, status: 'invalid', checkedAt: Date.now() }
      : { ...lic, validatedAt: Date.now(), status: 'active' };
    await chrome.storage.local.set({ license: next });
    return next;
  } catch (e) {
    if (e.status && e.status < 500 && e.status !== 429) {
      const next = { plan: 'free', key: lic.key, status: 'invalid', checkedAt: Date.now() };
      await chrome.storage.local.set({ license: next });
      return next;
    }
    if (Date.now() - (lic.validatedAt || 0) > GRACE_MS) {
      const next = { ...lic, plan: 'free', status: 'offline' };
      await chrome.storage.local.set({ license: next });
      return next;
    }
    return lic;
  }
}

// ---------- daily usage (Claude connector calls on the free plan) ----------
const today = () => new Date().toISOString().slice(0, 10);

// Serialised: two Claude calls running in parallel must not both read the same count.
let usageQueue = Promise.resolve();
export function useMcpCall() {
  const run = usageQueue.then(countMcpCall);
  usageQueue = run.catch(() => {});
  return run;
}

// A call that never produced a result (blocked URL, CAPTCHA, network error) does not cost a
// free-plan call: the count is given back on the same serialised queue.
export function releaseMcpCall() {
  const run = usageQueue.then(uncountMcpCall);
  usageQueue = run.catch(() => {});
  return run;
}

async function uncountMcpCall() {
  const { usage } = await chrome.storage.local.get('usage');
  if (usage?.day !== today() || !(usage.mcp > 0)) return false;
  await chrome.storage.local.set({ usage: { ...usage, mcp: usage.mcp - 1 } });
  return true;
}

async function countMcpCall() {
  const lic = await getLicense();
  const limit = limitsFor(lic).mcpCallsPerDay;
  const { usage } = await chrome.storage.local.get('usage');
  const u = usage?.day === today() ? usage : { day: today(), mcp: 0 };
  if (u.mcp >= limit) return { allowed: false, used: u.mcp, limit };
  u.mcp++;
  await chrome.storage.local.set({ usage: u });
  return { allowed: true, used: u.mcp, limit };
}

export async function getUsage() {
  const { usage } = await chrome.storage.local.get('usage');
  return usage?.day === today() ? usage : { day: today(), mcp: 0 };
}

export const capNote = (what, limit) => `Free plan: ${what} is limited to ${limit.toLocaleString()} per run. Upgrade to PullRows Pro for no limits.`;
