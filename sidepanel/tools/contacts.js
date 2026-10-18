// EMAIL EXTRACTOR + SOCIAL LINK EXTRACTOR — crawl a list of sites (and their contact/about pages).
import { h, toast, runJob, plural } from '../ui.js';
import { capList } from '../plan.js';
import { makeSheet, setDataset } from '../state.js';
import { urlSource, card, numberField, checkbox, actions, primary, secondary } from '../widgets.js';
import { getActiveTab, callInTab, runInNewTab } from '../../lib/tab.js';
import { crawlContacts } from '../../lib/crawl.js';

const renderInTab = (url, method, args) => runInNewTab(url, method, args, { waitMs: 2000 });

const PLATFORMS = ['LinkedIn', 'Twitter/X', 'Facebook', 'Instagram', 'YouTube', 'TikTok', 'GitHub', 'Pinterest', 'Threads', 'Telegram', 'WhatsApp', 'Discord', 'Reddit', 'Medium', 'Bluesky'];

function crawlerOptions(preset, settings) {
  const deep = checkbox('Deep scan — also visit contact / about / team pages', preset.deep ?? true);
  const maxSub = numberField('Max sub-pages per site', preset.maxSubpages ?? 5, { min: 1, max: 30 });
  const conc = numberField('Parallel sites', preset.concurrency ?? Math.max(settings.concurrency, 4), { min: 1, max: 12 });
  return {
    els: [deep.el, h('div', { class: 'row' }, maxSub.el, conc.el)],
    get: () => ({ deep: deep.get(), maxSubpages: maxSub.get(), concurrency: conc.get() }),
  };
}

async function scanCurrentPage() {
  const tab = await getActiveTab();
  return { tab, c: await callInTab(tab.id, 'contacts') };
}

export const emailTool = {
  id: 'email',
  title: 'Email Extractor',
  icon: '✉',
  desc: 'Emails from many sites — follows links to contact pages, decodes protected emails.',
  render(ctx) {
    const preset = ctx.preset || {};
    const urls = urlSource({ initial: preset.urls || [] });
    const opts = crawlerOptions(preset, ctx.settings);
    const domain = h('input', { placeholder: 'Only emails at this domain (optional), e.g. acme.com', value: preset.domain || '' });
    const phones = checkbox('Also collect phone numbers (separate sheet)', preset.phones ?? false);

    const getConfig = () => ({ ...opts.get(), domain: domain.value.trim(), phones: phones.get() });

    async function run() {
      const list = capList(urls.get(), 'contactSites', 'the email finder');
      if (!list.length) { toast('Add some websites.', 'error'); return; }
      const cfg = getConfig();
      await runJob(`Scanning ${plural(list.length, 'site')}…`, async (signal, progress) => {
        const res = await crawlContacts(list, { ...cfg, emailDomainFilter: cfg.domain, signal, renderInTab, onProgress: (d, t) => progress(`${d} / ${t} sites`, d, t) });
        const sheets = [makeSheet('Emails', res.emails, ['site', 'email', 'found_on', 'source'])];
        if (cfg.phones) sheets.push(makeSheet('Phones', res.phones, ['site', 'phone', 'found_on']));
        if (res.failures.length) sheets.push(makeSheet('Failed', res.failures, ['url', 'error']));
        await setDataset({ title: `Emails from ${plural(list.length, 'site')}`, url: list[0], source: 'Email Extractor', sheets });
        toast(`Found ${plural(res.emails.length, 'email')}${res.failures.length ? ` · ${res.failures.length} sites failed` : ''}.`, 'ok');
        ctx.go('table');
      });
    }

    async function thisPage() {
      try {
        const { tab, c } = await scanCurrentPage();
        const site = new URL(tab.url).host;
        await setDataset({ title: tab.title, url: tab.url, source: 'Email Extractor', sheets: [
          makeSheet('Emails', c.emails.map((e) => ({ site, email: e.email, found_on: tab.url, source: e.source })), ['site', 'email', 'found_on', 'source']),
          makeSheet('Phones', c.phones.map((p) => ({ site, phone: p.phone, found_on: tab.url })), ['site', 'phone', 'found_on']),
        ] });
        toast(`Found ${plural(c.emails.length, 'email')} on this page.`, 'ok');
        ctx.go('table');
      } catch (e) { toast(e.message, 'error'); }
    }

    if (ctx.autoRun) setTimeout(run, 50);
    return h('div', { class: 'stack' },
      card('This page', h('button', { type: 'button', class: 'btn secondary', onclick: thisPage }, 'Find emails on the current page')),
      card('Many websites', urls.el, ...opts.els, domain, phones.el),
      actions(primary('Find emails', run), secondary('Save recipe', () => ctx.saveRecipe(ctx.tool, { ...getConfig(), urls: urls.get() }))));
  },
};

export const socialTool = {
  id: 'social',
  title: 'Social Link Extractor',
  icon: '⊕',
  desc: 'LinkedIn, X, Instagram, Facebook, YouTube, TikTok… profiles for a list of sites.',
  render(ctx) {
    const preset = ctx.preset || {};
    const urls = urlSource({ initial: preset.urls || [] });
    const opts = crawlerOptions(preset, ctx.settings);
    const chosen = new Set(preset.platforms || PLATFORMS.slice(0, 8));
    const platBox = h('div', { class: 'chip-grid' }, PLATFORMS.map((p) => h('label', { class: 'chip' },
      h('input', { type: 'checkbox', checked: chosen.has(p), onchange: (e) => { if (e.target.checked) chosen.add(p); else chosen.delete(p); } }), p)));
    const wide = checkbox('One row per site (a column per platform)', preset.wide ?? true);

    const getConfig = () => ({ ...opts.get(), platforms: [...chosen], wide: wide.get() });

    async function run() {
      const list = capList(urls.get(), 'contactSites', 'the social link finder');
      if (!list.length) { toast('Add some websites.', 'error'); return; }
      const cfg = getConfig();
      await runJob(`Scanning ${plural(list.length, 'site')}…`, async (signal, progress) => {
        const res = await crawlContacts(list, { ...cfg, signal, renderInTab, onProgress: (d, t) => progress(`${d} / ${t} sites`, d, t) });
        const found = res.socials.filter((s) => chosen.has(s.platform));
        let sheet;
        if (cfg.wide) {
          const bySite = new Map(list.map((u) => { try { return [new URL(u).host.replace(/^www\./, ''), {}]; } catch { return [u, {}]; } }));
          for (const s of found) {
            const row = bySite.get(s.site) || {};
            row[s.platform] = row[s.platform] ? `${row[s.platform]} | ${s.profile}` : s.profile;
            bySite.set(s.site, row);
          }
          const cols = ['site', ...[...chosen].filter((p) => found.some((s) => s.platform === p))];
          sheet = makeSheet('Social links', [...bySite].map(([site, r]) => ({ site, ...r })), cols);
        } else {
          sheet = makeSheet('Social links', found, ['site', 'platform', 'profile', 'found_on']);
        }
        const sheets = [sheet];
        if (res.failures.length) sheets.push(makeSheet('Failed', res.failures, ['url', 'error']));
        await setDataset({ title: `Social links from ${plural(list.length, 'site')}`, url: list[0], source: 'Social Link Extractor', sheets });
        toast(`Found ${plural(found.length, 'profile')}.`, 'ok');
        ctx.go('table');
      });
    }

    async function thisPage() {
      try {
        const { tab, c } = await scanCurrentPage();
        const rows = c.socials.filter((s) => chosen.has(s.platform)).map((s) => ({ platform: s.platform, profile: s.url, text: s.text }));
        await setDataset({ title: tab.title, url: tab.url, source: 'Social Link Extractor', sheets: [makeSheet('Social links', rows, ['platform', 'profile', 'text'])] });
        ctx.go('table');
      } catch (e) { toast(e.message, 'error'); }
    }

    if (ctx.autoRun) setTimeout(run, 50);
    return h('div', { class: 'stack' },
      card('This page', h('button', { type: 'button', class: 'btn secondary', onclick: thisPage }, 'Find social links on the current page')),
      card('Many websites', urls.el, ...opts.els),
      card('Platforms', platBox, wide.el),
      actions(primary('Find social links', run), secondary('Save recipe', () => ctx.saveRecipe(ctx.tool, { ...getConfig(), urls: urls.get() }))));
  },
};
