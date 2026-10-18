// Unit checks for lib/clean.js and lib/trends.js helpers (no browser).
//   node test/clean.mjs
import assert from 'node:assert/strict';
import { toNumber, cleanUrl } from '../lib/clean.js';
import { blockedReason } from '../lib/guard.js';
import { urlMatcher } from '../lib/sitemap.js';
import { toTSV } from '../lib/export.js';
import { fetchWithTimeout, setFetchGuard } from '../lib/net.js';
import { captionsToText, rankPosts, searchUrl, redditJsonUrl } from '../lib/trends.js';

const cases = [['₹1,299', 1299], ['$87.53', 87.53], ['€25,00', 25], ['1.2M views', 1200000], ['12.3K likes', 12300], ['(1,234)', -1234],
  ['4.5 out of 5 stars', 4.5], ['Rated 3 out of 5', 3], ['1 234,56 €', 1234.56], ['1.234.567', 1234567], ['3,4 Mio', 3400000],
  ['12万回再生', 120000], ['2.5 lakh', 250000], ['1.5 Cr', 15000000], ['241 points', 241], ['no number', null], ['', null], ['1,234', 1234]];
for (const [input, want] of cases) assert.equal(toNumber(input), want, `toNumber(${input})`);

assert.equal(cleanUrl('https://www.amazon.in/Some-Thing/dp/B0ABCDEF12/ref=sr_1_3?keywords=x&qid=1&sr=8-3&tag=aff-21'), 'https://www.amazon.in/dp/B0ABCDEF12');
assert.equal(cleanUrl('https://shop.com/p?id=3&utm_source=a&fbclid=b#reviews'), 'https://shop.com/p?id=3');
assert.equal(cleanUrl('https://app.com/#/item/3?utm_source=x'), 'https://app.com/#/item/3?utm_source=x');

assert.equal(captionsToText('WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n<c>Hello</c> there\n\n2\n00:00:02.000 --> 00:00:03.000\nHello there\nworld &amp; more'), 'Hello there world & more');
assert.equal(captionsToText('<transcript><text start="0">It&#39;s</text><text start="1">fine</text></transcript>'), "It's fine");
assert.equal(captionsToText(JSON.stringify({ events: [{ segs: [{ utf8: 'a' }, { utf8: ' b' }] }, { segs: [{ utf8: '\n' }] }, { segs: [{ utf8: 'c' }] }] })), 'a b c');

const now = Date.parse('2026-10-18T00:00:00Z');
const posts = [
  { url: 'old-big', views: 5e6, likes: 1e5, comments: 1e3, posted: '2026-06-01T00:00:00Z' },
  { url: 'fresh-hot', views: 8e5, likes: 9e4, comments: 4e3, shares: 1e4, posted: '2026-10-17T00:00:00Z' },
  { url: 'small', views: 2e3, likes: 50, comments: 1, posted: '2026-10-10T00:00:00Z' },
];
assert.equal(rankPosts(posts, 'trending', now)[0].url, 'fresh-hot');
assert.equal(rankPosts(posts, 'views', now)[0].url, 'old-big');
assert.equal(rankPosts(posts, 'views', now)[2].rank, 3);
assert.equal(searchUrl('instagram', '#AI tools'), 'https://www.instagram.com/explore/search/keyword/?q=AItools');
assert.match(searchUrl('tiktok', 'ai tools'), /search\/video\?q=ai%20tools$/);
assert.equal(searchUrl('reddit', 'r/ChatGPT', { maxAgeDays: 30 }), 'https://www.reddit.com/r/ChatGPT/top.json?t=month&limit=100');
assert.match(searchUrl('reddit', 'ai tools'), /^https:\/\/www\.reddit\.com\/search\.json\?q=ai%20tools&sort=top&t=week/);
assert.equal(searchUrl('x', '#AI'), 'https://x.com/search?q=%23AI&src=typed_query&f=top');
assert.equal(redditJsonUrl('https://www.reddit.com/r/aitools/'), 'https://www.reddit.com/r/aitools.json?limit=100');
assert.equal(redditJsonUrl('https://www.reddit.com/search/?q=claude'), 'https://www.reddit.com/search.json?q=claude&limit=100');
assert.equal(redditJsonUrl('https://example.com/page'), '');
const reddit = rankPosts([{ platform: 'reddit', url: 'a', likes: 900, comments: 50, posted: '2026-10-17T20:00:00Z' }, { platform: 'reddit', url: 'b', likes: 5000, comments: 100, posted: '2026-09-01T00:00:00Z' }], 'trending', now);
assert.equal(reddit[0].url, 'a');
assert.match(reddit[0].why, /upvotes/);
assert.equal(reddit[0].views_per_day, '');
// Safety guard: trailing dots, IPv6 literals, look-alike names
for (const u of ['http://localhost./', 'https://mail.google.com./x', 'https://paypal.com.', 'http://metadata.google.internal./', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/', 'http://0x7f.1/', 'http://2130706433/', 'http://user@127.0.0.1/'])
  assert.ok(blockedReason(u), `must block ${u}`);
for (const u of ['https://fdic.gov/', 'https://www.fda.gov/', 'https://fcbarcelona.com/', 'https://fc2.com/', 'https://example.com/'])
  assert.equal(blockedReason(u), '', `must allow ${u}`);
// Regex filters that could hang on long URLs are treated as plain text
for (const f of ['/(a+)+$/', '/((a+))+$/', '/(a|aa)*b/', '/(.*a){20}/', '/(a)\\1/']) {
  const t0 = Date.now();
  urlMatcher(f)('https://example.com/' + 'a'.repeat(5000) + '!');
  assert.ok(Date.now() - t0 < 200, `filter ${f} must not hang`);
}
assert.equal(urlMatcher('/\\/p\\/\\d+/')('https://s.com/p/12'), true);
// TSV headers can't smuggle formulas or extra columns
assert.ok(!/^=/.test(toTSV([{ '=HYPERLINK("x")': 1 }]).split('\t')[0]));
assert.equal(toTSV([{ 'a\tb': 1 }]).split('\n')[0].split('\t').length, 1);
// The connector's fetch guard runs before any request
setFetchGuard((u) => { const why = blockedReason(u); if (why) throw new Error(`Blocked by PullRows safety settings: ${why}`); });
await assert.rejects(fetchWithTimeout('http://localhost./x'), /Blocked by PullRows/);
setFetchGuard(null);
console.log('All clean/trends unit checks passed');
