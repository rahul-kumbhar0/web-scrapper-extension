// Email + social link crawler: visits each site's page, then (deep mode) its contact/about pages.
import { fetchDoc, runPool, normalizeUrl } from './net.js';
import { looksLikeShell } from './smart.js';

const engine = () => globalThis.__webScraper;
const GUESSED_PATHS = ['/contact', '/contact-us', '/about', '/about-us', '/impressum'];

// renderInTab(url, method, args): optional; used for sites that build their pages with JavaScript (or refuse
// background requests), so footers with social links and emails are read from the rendered page.
export async function crawlContacts(urls, { deep = true, maxSubpages = 5, concurrency = 4, signal, onProgress, emailDomainFilter = '', renderInTab } = {}) {
  const emailRows = [];
  const socialRows = [];
  const phoneRows = [];
  const failures = [];
  const seenEmail = new Set();
  const seenSocial = new Set();
  const seenPhone = new Set();

  const collect = (site, pageUrl, c) => {
    for (const e of c.emails) {
      if (emailDomainFilter && !e.email.endsWith('@' + emailDomainFilter.replace(/^@/, '')) && !e.email.endsWith('.' + emailDomainFilter)) continue;
      const k = site + '|' + e.email;
      if (seenEmail.has(k)) continue;
      seenEmail.add(k);
      emailRows.push({ site, email: e.email, found_on: pageUrl, source: e.source });
    }
    for (const s of c.socials) {
      const k = site + '|' + s.url.toLowerCase();
      if (seenSocial.has(k)) continue;
      seenSocial.add(k);
      socialRows.push({ site, platform: s.platform, profile: s.url, found_on: pageUrl });
    }
    for (const p of c.phones) {
      const k = site + '|' + p.phone.replace(/\D/g, '');
      if (seenPhone.has(k)) continue;
      seenPhone.add(k);
      phoneRows.push({ site, phone: p.phone, found_on: pageUrl });
    }
  };

  await runPool(urls.map(normalizeUrl).filter(Boolean), concurrency, async (url) => {
    const site = new URL(url).host.replace(/^www\./, '');
    let first;
    let finalUrl = url;
    try {
      const r = await fetchDoc(url, { signal });
      finalUrl = r.url;
      first = engine().contacts(r.doc);
      const empty = !first.emails.length && !first.socials.length;
      if (renderInTab && (looksLikeShell(r.doc) || empty)) first = (await renderInTab(finalUrl, 'contactsAfterScroll', []).catch(() => null)) || first;
    } catch (e) {
      if (!renderInTab || signal?.aborted) throw e;
      first = await renderInTab(url, 'contactsAfterScroll', []); // blocked background request: read it in a tab
    }
    collect(site, finalUrl, first);
    if (!deep) return;
    let sub = first.contactLinks.filter((u) => u !== finalUrl);
    if (!sub.length) sub = GUESSED_PATHS.map((p) => new URL(p, finalUrl).href);
    for (const subUrl of sub.slice(0, maxSubpages)) {
      if (signal?.aborted) return;
      try {
        const { doc: d, url: u } = await fetchDoc(subUrl, { signal, timeoutMs: 15000 });
        collect(site, u, engine().contacts(d));
      } catch { /* missing contact pages are normal */ }
    }
  }, {
    signal,
    onProgress: (done, total, url, res) => {
      if (!res.ok) failures.push({ url, error: res.error });
      onProgress?.(done, total, url);
    },
  });

  return { emails: emailRows, socials: socialRows, phones: phoneRows, failures };
}
