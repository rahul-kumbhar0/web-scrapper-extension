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
};
const UNLIMITED = Object.fromEntries(Object.keys(FREE_LIMITS).map((k) => [k, Infinity]));

// Features only Pro has (everything else is free, within the limits above).
export const PRO_ONLY = {
  xlsx: 'Excel export',
  json: 'JSON export',
};

const REVALIDATE_MS = 24 * 3600 * 1000;
const GRACE_MS = 14 * 24 * 3600 * 1000;

const FREE = { plan: 'free' };

export async function getLicense() {
  const { license } = await chrome.storage.local.get('license');
  return license?.plan ? license : FREE;
}

export const isPro = (lic) => lic?.plan === 'pro';
export const limitsFor = (lic) => (isPro(lic) ? UNLIMITED : FREE_LIMITS);

async function apiBase() {
  const { devLicenseApi } = await chrome.storage.local.get('devLicenseApi'); // tests only
  return devLicenseApi || LICENSE_API;
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
  if (lic.key && lic.instanceId) {
    await post('/licenses/deactivate', { license_key: lic.key, license_key_instance_id: lic.instanceId }).catch(() => {});
  }
  await chrome.storage.local.set({ license: FREE });
  return FREE;
}

// Re-check a Pro licence once a day. Network trouble never downgrades within the grace period.
export async function refreshLicense({ force = false } = {}) {
  const lic = await getLicense();
  if (!isPro(lic) || (!force && Date.now() - (lic.validatedAt || 0) < REVALIDATE_MS)) return lic;
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

export async function useMcpCall() {
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
