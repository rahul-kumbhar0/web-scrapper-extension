// The user's plan inside the side panel: current licence, limits, and the upgrade prompt.
import { formDialog, toast } from './ui.js';
import { getLicense, refreshLicense, isPro, limitsFor, PRO_ONLY } from '../lib/license.js';

export const plan = {
  license: { plan: 'free' },
  get pro() { return isPro(this.license); },
  get limits() { return limitsFor(this.license); },
  listeners: new Set(),
};

export async function loadPlan() {
  plan.license = await getLicense();
  refreshLicense().then((lic) => { if (lic.plan !== plan.license.plan) setLicense(lic); }).catch(() => {});
  return plan.license;
}

export function setLicense(lic) {
  plan.license = lic;
  for (const fn of plan.listeners) fn(lic);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.license) setLicense(changes.license.newValue || { plan: 'free' });
});

let go = null;
export const bindNavigation = (fn) => { go = fn; };

// Ask the user to upgrade. Resolves true if they chose to see the plans.
export async function upsell(reason) {
  const res = await formDialog({
    title: 'Unlock PullRows Pro',
    text: `${reason}\n\nPro removes every limit — unlimited pages, URLs and sites per run, Excel & JSON export, unlimited recipes and Claude connector calls.`,
    submit: 'See plans',
  });
  if (res) go?.('upgrade');
  return !!res;
}

// Gate a Pro-only feature. Returns true when allowed.
export function requirePro(feature) {
  if (plan.pro) return true;
  upsell(`${PRO_ONLY[feature] || feature} is part of PullRows Pro.`);
  return false;
}

// Trim a list to the plan limit, telling the user when something was left out.
export function capList(list, key, what) {
  const limit = plan.limits[key];
  if (list.length <= limit) return list;
  toast(`Free plan: ${what} limited to ${limit} per run — running the first ${limit}. Upgrade for no limits.`, '', true);
  return list.slice(0, limit);
}

// Clamp a number (pages, scroll steps…) to the plan limit.
export function capNumber(n, key) {
  return Math.min(n, plan.limits[key]);
}
