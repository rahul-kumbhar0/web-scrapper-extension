// The user's plan inside the side panel: current licence, limits, and the upgrade prompt.
import { formDialog, toast } from './ui.js';
import { getLicense, refreshLicense, isPro, limitsFor, PRO_ONLY, getTrial, startTrial, TRIAL_DAYS } from '../lib/license.js';

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
  if (area === 'local' && (changes.license || changes.trial)) getLicense().then(setLicense);
});

export async function canTrial() { return !plan.pro && !(await getTrial()); }

export async function beginTrial() {
  const lic = await startTrial();
  setLicense(lic);
  toast(`PullRows Pro trial started — ${TRIAL_DAYS} days, every limit removed. No card needed.`, 'ok');
  return lic;
}

// Days (rounded up) left in the trial, or 0.
export const trialDaysLeft = () => (plan.license.trial ? Math.max(1, Math.ceil((plan.license.endsAt - Date.now()) / 86400000)) : 0);

let go = null;
export const bindNavigation = (fn) => { go = fn; };

// Ask the user to upgrade. Resolves true if they chose to see the plans.
export async function upsell(reason) {
  const trial = await canTrial();
  const res = await formDialog({
    title: 'Unlock PullRows Pro',
    text: `${reason}\n\nPro removes every limit — unlimited pages, URLs and sites per run, Excel & JSON export, unlimited recipes, hourly monitors with price-drop alerts, Google Sheets auto-sync, AI lead enrichment and unlimited Claude connector calls.${trial ? `\n\nTry it free for ${TRIAL_DAYS} days — no card, no signup.` : ''}`,
    submit: trial ? `Start ${TRIAL_DAYS}-day free trial` : 'See plans',
  });
  if (!res) return false;
  if (trial) await beginTrial(); else go?.('upgrade');
  return true;
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
