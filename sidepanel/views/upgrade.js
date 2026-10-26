// PLAN — what Pro adds, checkout links, and licence key activation.
import { h, fill, toast, confirmDialog } from '../ui.js';
import { card } from '../widgets.js';
import { icon } from '../icons.js';
import { plan, setLicense, canTrial, beginTrial, trialDaysLeft } from '../plan.js';
import { activate, deactivate, refreshLicense, FREE_LIMITS, getUsage, getTrial } from '../../lib/license.js';
import { CHECKOUT, LINKS, SUPPORT_EMAIL } from '../../lib/config.js';

const ROWS = [
  ['List pagination per run', `${FREE_LIMITS.listPages} pages · ${FREE_LIMITS.scrollSteps} scrolls`, 'Unlimited'],
  ['Page Extractor URLs per run', FREE_LIMITS.pageUrls, 'Unlimited'],
  ['Email & social finder sites per run', FREE_LIMITS.contactSites, 'Unlimited'],
  ['Images per download', FREE_LIMITS.images, 'Unlimited'],
  ['Shopify products · sitemap URLs', `${FREE_LIMITS.shopifyProducts} · ${FREE_LIMITS.sitemapUrls.toLocaleString()}`, 'Unlimited'],
  ['Trend Finder posts scanned per run', FREE_LIMITS.trendPosts, 'Up to 500'],
  ['Video scripts (transcripts) of winners', '—', '✓'],
  ['Monitors (re-run a recipe on a schedule, alert on changes & price drops)', `${FREE_LIMITS.monitors} · daily`, 'Unlimited · hourly'],
  ['Google Sheets: send rows', '✓', '✓'],
  ['Google Sheets: auto-sync after every monitor run', '—', '✓'],
  ['AI lead enrichment (industry, size, lead score…)', '—', '✓'],
  ['CSV & copy export', '✓', '✓'],
  ['Excel & JSON export', '—', '✓'],
  ['Saved recipes', FREE_LIMITS.recipes, 'Unlimited'],
  ['Claude connector calls / day', FREE_LIMITS.mcpCallsPerDay, 'Unlimited'],
  ['AI Extract, AI column, Ask Claude (your API key)', '✓', '✓'],
];

const open = (url) => chrome.tabs.create({ url });

export default {
  id: 'upgrade',
  title: 'Upgrade',
  icon: '★',
  render() {
    const status = h('div', { class: 'stack' });
    const key = h('input', { id: 'license-key', placeholder: 'Paste your licence key', spellcheck: false, autocomplete: 'off' });

    async function renderStatus() {
      const lic = plan.license;
      const usage = await getUsage();
      if (plan.license.trial) {
        fill(status,
          h('div', { class: 'notice' }, icon('crown', { size: 16 }), h('span', {}, h('strong', {}, `Pro trial — ${trialDaysLeft()} ${trialDaysLeft() === 1 ? 'day' : 'days'} left.`), ` Ends ${new Date(lic.endsAt).toLocaleDateString()}. Your data stays when it ends; only the limits come back.`)),
          licenceInput());
      } else if (plan.pro) {
        fill(status,
          h('div', { class: 'notice' }, icon('check', { size: 16 }), h('span', {}, h('strong', {}, 'PullRows Pro is active in this browser.'), ` Key ${String(lic.key).slice(0, 6)}… · checked ${new Date(lic.validatedAt || lic.activatedAt).toLocaleDateString()}`)),
          h('div', { class: 'row wrap' },
            h('button', { type: 'button', class: 'btn secondary', onclick: async () => { setLicense(await refreshLicense({ force: true })); toast(plan.pro ? 'Licence is valid.' : 'Licence is no longer valid.', plan.pro ? 'ok' : 'error'); renderStatus(); } }, 'Re-check licence'),
            h('button', { type: 'button', class: 'btn secondary', onclick: async () => {
              if (!(await confirmDialog('Deactivate this browser?', 'Frees one of your 3 browser seats. You can activate again any time with the same key.', 'Deactivate'))) return;
              setLicense(await deactivate());
              toast('This browser is back on the free plan.', 'ok');
              renderStatus();
            } }, 'Deactivate this browser')));
      } else {
        const pastTrial = await getTrial();
        const trialBtn = (await canTrial()) ? h('button', { id: 'start-trial', type: 'button', class: 'btn grad', onclick: async () => { await beginTrial(); renderStatus(); } }, icon('crown', { size: 15 }), 'Try Pro free for 3 days') : null;
        fill(status,
          lic.status === 'invalid' ? h('div', { class: 'notice warn' }, icon('lock', { size: 16 }), 'Your previous licence is no longer valid (refunded, expired or cancelled).') : null,
          pastTrial && !trialBtn ? h('div', { class: 'notice' }, icon('clock', { size: 16 }), `Your ${3}-day Pro trial ended on ${new Date(pastTrial.endsAt).toLocaleDateString()}. Everything you scraped is still here.`) : null,
          trialBtn,
          trialBtn ? h('p', { class: 'hint' }, 'No card, no signup — every limit is removed for 3 days, once per browser.') : null,
          h('p', { class: 'hint' }, `Free plan · ${usage.mcp} of ${FREE_LIMITS.mcpCallsPerDay} Claude connector calls used today.`),
          licenceInput());
      }
    }
    function licenceInput() {
      return h('div', { class: 'stack' },
          h('label', { class: 'field' }, 'Already bought Pro? Activate it here',
            h('div', { class: 'license-row' }, key,
              h('button', { id: 'activate-license', type: 'button', class: 'btn primary', onclick: async (e) => {
                e.currentTarget.disabled = true;
                try {
                  setLicense(await activate(key.value));
                  toast('Welcome to PullRows Pro — all limits are gone.', 'ok');
                  renderStatus();
                } catch (err) { toast(err.message, 'error'); } finally { e.target.disabled = false; }
              } }, 'Activate'))),
          h('p', { class: 'hint' }, 'Your key arrives by email after checkout. One licence works in up to 3 browsers.'));
    }
    renderStatus();
    const onPlan = () => renderStatus();
    plan.listeners.add(onPlan);

    const price = (label, amount, per, url, opts = {}) => h('button', { type: 'button', class: `price ${opts.best ? 'best' : ''}`, onclick: () => open(url) },
      opts.tag ? h('span', { class: 'tag' }, opts.tag) : null,
      h('span', { class: 'muted small' }, label),
      h('span', { class: 'amount' }, amount),
      h('span', { class: 'per' }, per));

    const el = h('div', { class: 'stack' },
      h('section', { class: 'plan-hero' },
        h('div', { class: 'crown' }, icon('crown', { size: 22 })),
        h('h3', {}, plan.pro && !plan.license.trial ? 'You’re on PullRows Pro' : 'Scrape without limits'),
        h('p', {}, plan.pro && !plan.license.trial ? 'Thanks for supporting an independent tool.' : 'Everything in Free, minus the caps. Cancel any time · 14-day refund.')),
      plan.pro && !plan.license.trial ? null : h('div', { class: 'price-grid' },
        price('Monthly', '$9', 'per month · ₹399 in India', CHECKOUT.monthly),
        price('Yearly', '$59', 'per year · save 45%', CHECKOUT.yearly, { best: true, tag: 'Best value' }),
        price('Lifetime', '$79', 'one-time · launch price, was $99', CHECKOUT.lifetime, { tag: 'Launch' })),
      card(plan.pro ? 'Your licence' : 'Licence', status),
      card('Free vs Pro',
        h('div', { class: 'table-wrap' }, h('table', { class: 'compare' },
          h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Free'), h('th', {}, 'Pro'))),
          h('tbody', {}, ROWS.map(([what, free, pro]) => h('tr', {}, h('td', {}, what), h('td', {}, String(free)), h('td', { class: pro === '✓' || pro === 'Unlimited' ? 'yes' : '' }, String(pro)))))))),
      h('div', { class: 'row wrap muted small' },
        h('button', { type: 'button', class: 'link-btn', onclick: () => open(LINKS.pricing) }, 'Pricing & FAQ'),
        h('span', {}, '·'),
        h('button', { type: 'button', class: 'link-btn', onclick: () => open(`mailto:${SUPPORT_EMAIL}`) }, SUPPORT_EMAIL)));
    return { el, cleanup: () => plan.listeners.delete(onPlan) };
  },
};
