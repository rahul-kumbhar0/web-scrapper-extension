// TREND FINDER — the best Reels / TikToks / Shorts / posts for a topic, ranked, with why they work:
// caption, hashtags, views, likes, comments, shares, saves, sound, length, date, the spoken script
// (where the platform publishes captions), and the patterns the winners share.
import { h, toast, runJob, plural } from '../ui.js';
import { makeSheet, setDataset } from '../state.js';
import { urlSource, card, numberField, checkbox, select, actions, primary } from '../widgets.js';
import { getActiveTab, runInNewTab, collectPosts, sleep } from '../../lib/tab.js';
import { fetchDoc, fetchText, fetchJson } from '../../lib/net.js';
import { findTrends, PLATFORMS, RANKINGS, TOP_COLUMNS, ALL_COLUMNS } from '../../lib/trends.js';
import { aiAsk } from '../../lib/ai.js';
import { plan, capNumber, requirePro } from '../plan.js';

const SOURCES = [
  { value: 'topic', label: 'A topic or #hashtag' },
  { value: 'tab', label: 'The page open in this tab (search, hashtag, profile, feed)' },
  { value: 'urls', label: 'A list of post / Reel / video links' },
];

const AI_PROMPT = `These are the top-ranked social posts for one topic (with metrics, hooks, captions and, where available, the spoken transcript).
Explain like a senior content strategist:
1. Why these win — the 3–5 patterns behind them (hook, format, length, sound, caption, timing), citing posts by rank.
2. The hook formulas they use, written as fill-in-the-blank templates.
3. A script outline that copies the winning structure (beats with seconds).
4. 5 new post ideas for this topic, each with a hook line, format, suggested sound/audio approach and 5 hashtags.
Be concrete and short.`;

export default {
  id: 'trends',
  title: 'Trend Finder',
  icon: '↗',
  desc: 'Best Reels, TikToks, Shorts, X posts and Reddit threads for any topic — ranked, with views, hashtags, sound, script and why they work.',
  render(ctx) {
    const preset = ctx.preset || {};
    const source = select('Find posts from', SOURCES, preset.source || 'topic');
    const platform = select('Platform', Object.entries(PLATFORMS).map(([value, label]) => ({ value, label })), preset.platform || 'instagram');
    const query = h('input', { type: 'text', value: preset.query || '', placeholder: 'e.g. ai tools · #aitools · r/ChatGPT (Reddit)', spellcheck: false });
    const urls = urlSource({ placeholder: 'Paste Reel / TikTok / YouTube links, one per line…', initial: preset.urls || [] });
    const rankBy = select('Rank by', Object.entries(RANKINGS).map(([value, label]) => ({ value, label })), preset.rankBy || 'trending');
    const scan = numberField('Posts to scan', preset.scan || 30, { min: 5, max: 500 });
    const top = numberField('Show best', preset.top || 10, { min: 3, max: 50 });
    const days = numberField('Only last N days (0 = any)', preset.maxAgeDays || 0, { min: 0, max: 3650 });
    const scripts = checkbox('Get the spoken script (transcript) of the winners', preset.transcripts ?? plan.pro);
    const ai = checkbox('AI breakdown: why they win + 5 ideas (your Anthropic key)', !!preset.ai && !!ctx.settings.apiKey);
    if (!ctx.settings.apiKey) { ai.input.disabled = true; ai.el.title = 'Add your Anthropic API key in Settings to use this.'; }

    const topicBox = h('div', { class: 'stack' }, platform.el, h('label', { class: 'field' }, 'Topic or #hashtag', query));
    const urlBox = h('div', { class: 'stack' }, urls.el);
    const tabHint = h('p', { class: 'hint' }, 'Open a search, hashtag, profile, subreddit or feed page on Instagram, TikTok, YouTube, X or Reddit (logged in if the site needs it), then run.');
    const syncSource = () => {
      topicBox.hidden = source.get() !== 'topic';
      urlBox.hidden = source.get() !== 'urls';
      tabHint.hidden = source.get() !== 'tab';
    };
    source.input.addEventListener('change', syncSource);
    syncSource();

    const getConfig = () => ({ source: source.get(), platform: platform.get(), query: query.value.trim(), urls: urls.get(), rankBy: rankBy.get(), scan: scan.get(), top: top.get(), maxAgeDays: days.get(), transcripts: scripts.get(), ai: ai.get() });

    async function run() {
      const c = getConfig();
      if (c.source === 'topic' && !c.query) { toast('Enter a topic or #hashtag.', 'error'); return; }
      if (c.source === 'urls' && !c.urls.length) { toast('Paste some post links.', 'error'); return; }
      if (c.transcripts && !plan.limits.transcripts && !requirePro('transcripts')) return;
      const n = capNumber(c.scan, 'trendPosts');
      if (n < c.scan) toast(`Free plan: scanning ${n} posts per run — upgrade to scan up to 500.`, '', true);
      let tab = null;
      if (c.source === 'tab') {
        tab = await getActiveTab();
        if (!/^https?:/.test(tab.url || '')) { toast('Open a web page first.', 'error'); return; }
      }
      await runJob('Finding the best posts…', async (signal, progress) => {
        const io = {
          fetchDoc, fetchText, fetchJson, signal, sleep,
          progress: (msg, done, total) => progress(msg, done, total),
          renderInTab: (url, method, args) => runInNewTab(url, method, args, { waitMs: 2500 }),
          collectPosts: (url, o) => collectPosts(url, { ...o, signal, reuseTabId: tab?.id }),
        };
        const r = await findTrends({
          platform: c.platform, query: c.query, pageUrl: tab?.url || '', urls: c.source === 'urls' ? c.urls : [],
          scan: n, top: c.top, rankBy: c.rankBy, transcripts: c.transcripts, maxAgeDays: c.maxAgeDays,
        }, io);
        const sheets = [
          makeSheet(`Top ${r.top.length}`, r.top, TOP_COLUMNS.filter((k) => k !== 'transcript' || c.transcripts)),
          makeSheet('All posts', r.ranked, ALL_COLUMNS.filter((k) => k !== 'error' || r.ranked.some((p) => p.error))),
          makeSheet('Patterns', r.insights, ['insight', 'detail']),
        ];
        if (c.ai) {
          progress('Claude is studying the winners…');
          try {
            const cols = ['rank', 'hook', 'caption', 'transcript', 'views', 'likes', 'comments', 'shares', 'saves', 'engagement_rate', 'views_per_day', 'music', 'duration_s', 'hashtags', 'posted'];
            const res = await aiAsk({ apiKey: ctx.settings.apiKey, model: ctx.settings.model, question: `${AI_PROMPT}\n\nTopic: ${c.query || r.source}`, rows: r.top, columns: cols, signal });
            sheets.splice(1, 0, makeSheet('AI breakdown', res.answer.split(/\n{2,}/).map((t) => ({ analysis: t.trim() })).filter((x) => x.analysis), ['analysis']));
          } catch (e) { r.notes.push(`AI breakdown failed: ${e.message}`); }
        }
        await setDataset({ title: `Trend Finder — ${c.query || r.source}`, url: r.source, source: 'Trend Finder', sheets });
        const how = r.via.tab ? `${r.via.background} read in the background, ${r.via.tab} needed a tab` : 'all read in the background';
        toast(`Ranked ${plural(r.scanned, 'post')} (${how}). Best ${r.top.length} are in “Top ${r.top.length}”, patterns in “Patterns”.${r.notes.length ? ` ⚠ ${r.notes.join(' ')}` : ''}`, r.notes.length ? '' : 'ok');
        ctx.go('table');
      });
    }

    const el = h('div', { class: 'stack' },
      card('1. What to look for', source.el, topicBox, urlBox, tabHint),
      card('2. How to pick the best', rankBy.el, h('div', { class: 'row' }, scan.el, top.el), days.el, scripts.el, ai.el,
        h('p', { class: 'hint' }, 'Posts are read in the background where possible (Reddit and YouTube fully). Instagram, TikTok and X search pages need you to be logged in; PullRows opens and scrolls them in a tab. Scripts come from the captions a platform publishes (YouTube, many TikToks); Reels without captions get their caption text only.')),
      actions(primary('Find the best posts', run), h('button', { type: 'button', class: 'btn secondary', onclick: () => ctx.saveRecipe(ctx.tool, getConfig(), `Trends — ${query.value || 'this page'}`) }, 'Save recipe')));
    if (ctx.autoRun) setTimeout(run, 50);
    return el;
  },
};
