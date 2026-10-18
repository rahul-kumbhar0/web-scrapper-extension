// TREND FINDER — "show me the best 10 Reels / TikToks / Shorts about X, and why they work".
//
//   1. Collect posts for a topic or hashtag (or from a search/profile page, or a pasted list):
//      background fetch first; if the platform needs a logged-in, scrolling page, PullRows opens it
//      in a tab and scrolls it.
//   2. Read every post in full: caption, hashtags, views, likes, comments, shares, saves, sound,
//      duration, upload time, creator followers. Background first, hidden tab only when needed.
//   3. Score and rank: views per hour since posting (momentum), engagement per view, reach beyond
//      the creator's followers, and raw views, as percentiles inside this scan so different
//      platforms and sizes compare fairly.
//   4. Transcripts (the spoken script) for the winners, where the platform publishes captions.
//   5. Patterns: hashtags, sounds, lengths, hooks and timing the winners share.
//
// Shared by the side panel and the Claude connector. io = {
//   fetchDoc(url, {signal}) → {doc}, fetchText(url, {signal}) → string,
//   renderInTab(url, method, args) → engine result from a hidden tab,
//   fetchJson(url, {signal}) → object (Reddit's JSON feeds),
//   collectPosts(url, {steps, want, onProgress}) → {posts, block},
//   signal, sleep(ms), progress?(message, done, total) }
import { smartRun } from './smart.js';

const engine = () => globalThis.__webScraper;
const enc = encodeURIComponent;

export const PLATFORMS = {
  youtube: 'YouTube (videos + Shorts)',
  'youtube-shorts': 'YouTube Shorts',
  tiktok: 'TikTok',
  instagram: 'Instagram Reels',
  x: 'X (Twitter)',
  reddit: 'Reddit',
};

export const RANKINGS = {
  trending: 'Trending now — fastest-growing (views per hour) + engagement',
  balanced: 'Balanced — views, engagement and momentum',
  views: 'Most viewed',
  engaging: 'Most engaging — likes, comments, shares per view',
};

// Reddit's own time windows for "top".
const redditWindow = (days) => (!days ? 'week' : days <= 1 ? 'day' : days <= 7 ? 'week' : days <= 31 ? 'month' : days <= 365 ? 'year' : 'all');

/** The search / hashtag page for a topic on a platform. */
export function searchUrl(platform, query, { maxAgeDays = 0 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Enter a topic or #hashtag.');
  const tag = q.replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, '');
  const isTag = q.startsWith('#') || (!/\s/.test(q) && platform === 'instagram');
  switch (platform) {
    case 'youtube': return `https://www.youtube.com/results?search_query=${enc(q)}`;
    case 'youtube-shorts': return isTag ? `https://www.youtube.com/hashtag/${enc(tag)}/shorts` : `https://www.youtube.com/results?search_query=${enc(`${q} #shorts`)}`;
    case 'tiktok': return isTag ? `https://www.tiktok.com/tag/${enc(tag)}` : `https://www.tiktok.com/search/video?q=${enc(q)}`;
    // Instagram now sends hashtag pages to keyword search, which fails when the query has a "#".
    case 'instagram': return `https://www.instagram.com/explore/search/keyword/?q=${enc(isTag ? tag : q.replace(/#/g, ''))}`;
    case 'x': return `https://x.com/search?q=${enc(q)}&src=typed_query&f=top`;
    case 'reddit': {
      const sub = q.match(/^\/?r\/([\w]+)/i)?.[1];
      const t = redditWindow(maxAgeDays);
      return sub ? `https://www.reddit.com/r/${sub}/top.json?t=${t}&limit=100` : `https://www.reddit.com/search.json?q=${enc(q)}&sort=top&t=${t}&limit=100&type=link`;
    }
    default: throw new Error(`Unknown platform: ${platform}`);
  }
}

// Reddit pages have a JSON twin: /r/sub/ → /r/sub/.json, /search?q= → /search.json?q=.
export function redditJsonUrl(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  if (!/reddit\.com$/.test(u.hostname) && !/\.json$/.test(u.pathname)) return '';
  if (!/\.json$/.test(u.pathname)) { const path = u.pathname.replace(/\/+$/, ''); u.pathname = path ? `${path}.json` : '/.json'; }
  if (!u.searchParams.has('limit')) u.searchParams.set('limit', '100');
  return u.href;
}

// Read Reddit listing JSON, following `after` pages until `want` posts.
async function redditCollect(url, want, io) {
  const E = engine();
  const posts = [];
  let next = url;
  for (let page = 0; next && posts.length < want && page < 10 && !io.signal?.aborted; page++) {
    const json = await io.fetchJson(next, { signal: io.signal });
    posts.push(...E.redditFromJson(json));
    const after = json?.data?.after;
    if (!after) break;
    const u = new URL(next);
    u.searchParams.set('after', after);
    next = u.href;
    await io.sleep(1000); // Reddit allows ~1 request/second without an API key
  }
  return posts;
}

// ---------- transcripts ----------

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));

/** Caption files (YouTube json3/XML, WebVTT, SRT) → plain spoken text. */
export function captionsToText(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      return (j.events || []).flatMap((e) => (e.segs || []).map((x) => x.utf8 || '')).join('').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
    } catch { return ''; }
  }
  if (/<text[\s>]/.test(s)) return decode([...s.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1]).join(' ')).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const lines = [];
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^WEBVTT|^NOTE\b|^STYLE\b|^Kind:|^Language:|^\d+$/.test(t) || /-->/.test(t)) continue;
    const text = decode(t.replace(/<[^>]+>/g, '')).trim();
    if (text && lines[lines.length - 1] !== text) lines.push(text); // auto-captions repeat lines
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

async function transcriptFor(post, io) {
  let u = post.transcript_url;
  if (!u) return '';
  if (/timedtext/.test(u) && !/[?&]fmt=/.test(u)) u += `${u.includes('?') ? '&' : '?'}fmt=json3`;
  return captionsToText(await io.fetchText(u, { signal: io.signal })).slice(0, 20000);
}

// ---------- scoring ----------

const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const fmt = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}K` : String(Math.round(v)));
const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

// Percentile rank of each value among the posts that have one (0…1); null where missing.
function percentiles(values) {
  const have = values.map((v, i) => [v, i]).filter(([v]) => v != null).sort((a, b) => a[0] - b[0]);
  const out = values.map(() => null);
  have.forEach(([, i], k) => { out[i] = have.length === 1 ? 1 : k / (have.length - 1); });
  return out;
}

const WEIGHTS = {
  trending: { velocity: 0.45, engagement: 0.25, views: 0.2, reach: 0.1 },
  balanced: { views: 0.35, engagement: 0.3, velocity: 0.25, reach: 0.1 },
  views: { views: 1 },
  engaging: { engagement: 0.7, views: 0.3 },
};

/** Adds metrics, score (0–100), rank and a one-line reason; returns posts best first. */
export function rankPosts(posts, rankBy = 'trending', now = Date.now()) {
  const m = posts.map((p) => {
    const views = n(p.views);
    const likes = n(p.likes) ?? 0;
    const comments = n(p.comments) ?? 0;
    const shares = n(p.shares) ?? 0;
    const saves = n(p.saves) ?? 0;
    const interactions = likes + comments + shares + saves;
    const ageH = p.posted ? Math.max(1, (now - Date.parse(p.posted)) / 3600000) : null;
    // Reddit has no view counts: upvotes are its popularity, comments per upvote its engagement.
    const votes = p.platform === 'reddit' && views == null;
    // Instagram photo posts have no view count: estimate reach from likes (~4% of viewers like).
    const reachViews = views ?? (n(p.likes) != null ? (votes ? likes : likes * 25) : null);
    return {
      views: reachViews,
      votes,
      likes, comments,
      estimated: views == null && reachViews != null && !votes,
      engagement: views ? (likes + 2 * comments + 3 * shares + 2 * saves) / views : votes && likes ? (2 * comments + 3 * shares) / likes : null,
      rate: views ? interactions / views : null,
      velocity: reachViews != null && ageH ? reachViews / ageH : null,
      reach: reachViews != null && n(p.author_followers) ? reachViews / n(p.author_followers) : null,
      ageH,
    };
  });
  // "Most engaging" ignores tiny posts where 3 likes on 20 views would look like a hit.
  const floor = rankBy === 'engaging' ? (median(m.map((x) => x.views)) || 0) * 0.2 : 0;
  const pct = Object.fromEntries(['views', 'engagement', 'velocity', 'reach'].map((k) => [k, percentiles(m.map((x) => x[k]))]));
  const w = WEIGHTS[rankBy] || WEIGHTS.trending;
  const scored = posts.map((p, i) => {
    let sum = 0;
    let wsum = 0;
    for (const [k, wt] of Object.entries(w)) if (pct[k][i] != null) { sum += wt * pct[k][i]; wsum += wt; }
    let score = wsum ? (sum / wsum) * 100 : 0;
    if (wsum < 0.5 * Object.values(w).reduce((a, b) => a + b, 0)) score *= 0.7; // too little data to trust
    if (floor && (m[i].views ?? 0) < floor) score *= 0.5;
    const x = m[i];
    const why = (x.votes ? [
      `${fmt(x.likes)} upvotes`, `${fmt(x.comments)} comments`,
      x.velocity != null && `${fmt(x.velocity * 24)} upvotes/day`,
      p.community,
    ] : [
      x.views != null && `${fmt(x.views)}${x.estimated ? ' est.' : ''} views`,
      x.velocity != null && x.ageH && `${fmt(x.velocity * 24)}/day`,
      x.rate != null && `${(x.rate * 100).toFixed(1)}% engagement`,
    ]).concat([
      x.reach != null && x.reach >= 1.5 && `${x.reach.toFixed(1)}× the creator's followers`,
      x.ageH != null && (x.ageH < 48 ? `${Math.round(x.ageH)}h old` : `${Math.round(x.ageH / 24)}d old`),
    ]).filter(Boolean).join(' · ');
    return {
      ...p,
      score: Math.round(score * 10) / 10,
      engagement_rate: x.rate != null ? `${(x.rate * 100).toFixed(2)}%` : '',
      views_per_day: x.velocity != null && !x.votes ? Math.round(x.velocity * 24) : '',
      why,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  scored.forEach((p, i) => { p.rank = i + 1; });
  return scored;
}

// ---------- patterns ----------

const hookOf = (p) => {
  const src = p.transcript || p.caption || '';
  const firstLine = src.split(/\n|(?<=[.!?])\s/)[0] || '';
  return firstLine.replace(/#[\p{L}\p{N}_]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 120);
};

function countBy(list, key) {
  const c = new Map();
  for (const p of list) for (const v of key(p)) if (v) c.set(v, (c.get(v) || 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1]);
}

/** What the winners have in common, as rows { insight, detail }. */
export function insightsFor(top, all) {
  const rows = [];
  const add = (insight, detail) => detail && rows.push({ insight, detail });
  const rest = all.filter((p) => !top.includes(p));
  const tagCount = (list) => countBy(list, (p) => String(p.hashtags || '').toLowerCase().split(/\s+/));
  const restTags = new Map(tagCount(rest));
  add('Hashtags the top posts use', tagCount(top).slice(0, 10).map(([t, c]) => `${t} (${c}/${top.length}${rest.length ? `, ${restTags.get(t) || 0}/${rest.length} of the rest` : ''})`).join(', '));
  const sounds = countBy(top, (p) => [p.music]).filter(([, c]) => c >= 2);
  add('Sounds trending among the winners', sounds.slice(0, 5).map(([s, c]) => `${s} (${c} posts)`).join('; ') ||
    (top.some((p) => p.music) ? `No shared sound — top sound: ${top.find((p) => p.music).music}` : ''));
  const orig = top.filter((p) => p.original_audio === 'yes').length;
  const lic = top.filter((p) => p.original_audio === 'no').length;
  if (orig + lic) add('Original voice vs trending sound', `${orig} of ${orig + lic} winners use original audio (voice-over / talking), ${lic} use a trending track.`);
  const dur = (list) => median(list.map((p) => n(p.duration_s)));
  if (dur(top) != null) add('Best length', `Winners median ${Math.round(dur(top))}s${dur(rest) != null ? ` vs ${Math.round(dur(rest))}s for the rest` : ''}.`);
  const words = (list) => median(list.map((p) => (p.caption ? p.caption.split(/\s+/).length : null)));
  if (words(top) != null) add('Caption length', `Winners median ${words(top)} words${words(rest) != null ? ` vs ${words(rest)} for the rest` : ''}.`);
  const hooks = top.slice(0, 5).map(hookOf).filter(Boolean);
  if (hooks.length) add('Opening hooks of the top 5', hooks.map((h, i) => `${i + 1}. “${h}”`).join('  '));
  const q = top.filter((p) => /\?/.test(hookOf(p))).length;
  const num = top.filter((p) => /\b\d+\b/.test(hookOf(p))).length;
  const pov = top.filter((p) => /^(pov|stop|nobody|this|you|how|why|i )/i.test(hookOf(p))).length;
  add('Hook styles', [num && `${num} use a number (“3 tools…”)`, q && `${q} ask a question`, pov && `${pov} open with POV / “Stop…” / “Nobody…” / “How…”`].filter(Boolean).join(', '));
  const dated = top.filter((p) => p.posted);
  if (dated.length >= 3) {
    const days = countBy(dated, (p) => [new Date(p.posted).toLocaleDateString(undefined, { weekday: 'long' })]);
    const hours = countBy(dated, (p) => [`${new Date(p.posted).getHours()}:00`]);
    add('When winners were posted (your time zone)', `Most on ${days[0][0]} (${days[0][1]}), around ${hours[0][0]} (${hours[0][1]}).`);
    add('Freshness', `Median age of the winners: ${Math.round(median(dated.map((p) => (Date.now() - Date.parse(p.posted)) / 86400000)))} days.`);
  }
  const communities = countBy(top, (p) => [p.community]);
  if (communities.length) add('Communities the winners were posted in', communities.slice(0, 8).map(([c, k]) => `${c} (${k})`).join(', '));
  const kinds = countBy(top, (p) => [p.type]);
  if (kinds.length > 1) add('Post formats among the winners', kinds.map(([t, k]) => `${t} ${k}`).join(', '));
  const creators = countBy(top, (p) => [p.author]).filter(([, c]) => c >= 2);
  if (creators.length) add('Creators with several winners', creators.map(([a, c]) => `@${a} (${c})`).join(', '));
  const withSubs = top.filter((p) => p.transcript_url).length;
  if (top.some((p) => /youtube|tiktok|instagram/.test(p.platform))) add('Scripts', withSubs ? `${withSubs} of ${top.length} winners publish captions — transcripts ${top.some((p) => p.transcript) ? 'are in the “transcript” column' : 'are available with Pro'}.` : 'None of the winners publish captions, so no spoken script is available (the caption text is included).');
  return rows;
}

// ---------- the whole job ----------

// Listings that already carry everything a post page would add.
const COMPLETE = (p) => {
  if (!p.caption || p.likes === '' || p.comments === '') return false;
  if (p.platform === 'reddit') return true; // no views or sounds on Reddit
  if (p.platform === 'x') return p.views !== '';
  return p.views !== '' && (p.platform === 'youtube' && p.type === 'video' || !!p.music);
};

export async function findTrends(opts, io) {
  const { platform = 'youtube', query = '', pageUrl = '', urls = [], scan = 30, top = 10, rankBy = 'trending', transcripts = false, maxAgeDays = 0, minViews = 0 } = opts;
  const E = engine();
  const merge = E._social.mergePost;
  const notes = [];
  const say = (msg, done, total) => io.progress?.(msg, done, total);
  let via = { background: 0, tab: 0 };

  // 1. Collect
  let posts = [];
  let source = '';
  if (urls.length) {
    posts = urls.map((url) => ({ url }));
    source = `${urls.length} pasted links`;
  } else {
    source = pageUrl || searchUrl(platform, query, { maxAgeDays });
    say('Looking for posts in the background…');
    const redditJson = redditJsonUrl(source);
    if (redditJson) {
      try { posts = await redditCollect(redditJson, scan, io); } catch (e) {
        if (io.signal?.aborted) throw e;
        notes.push(`Reddit's JSON feed refused the request (${String(e.message || e).slice(0, 60)}); read the page instead.`);
      }
      if (/\.json(\?|$)/.test(source) && !posts.length) source = source.replace(/\/?\.json/, '/');
    }
    if (!posts.length) {
      try {
        const { doc } = await io.fetchDoc(source, { signal: io.signal });
        if (!E.pageBlock(doc)) posts = E.socialPosts(doc);
      } catch (e) { if (io.signal?.aborted) throw e; }
    }
    if (posts.length) via.background++;
    if (posts.length < Math.min(scan, 8)) {
      say('Opening the page and scrolling it to collect posts…');
      // X and Instagram load the next posts slowly: give each scroll more time before giving up.
      const slow = /(^|\.)(x|twitter|instagram)\.com$/.test(new URL(source).hostname);
      const r = await io.collectPosts(source, { steps: Math.ceil(scan / 3) + 6, want: scan, stepMs: slow ? 2200 : 1200, patience: slow ? 5 : 3, until: io.deadline ? io.deadline - 15000 : 0, onProgress: (count) => say(`Collecting posts… ${count} found`) });
      const byUrl = new Map(posts.map((p) => [p.url, p]));
      for (const p of r.posts) byUrl.set(p.url, merge(byUrl.get(p.url), p));
      posts = [...byUrl.values()];
      via.tab++;
      if (r.block) notes.push(`${r.block.label} on ${new URL(source).hostname} — log in there (or solve the check) and run again for more results.`);
    }
  }
  const seen = new Set();
  posts = posts.filter((p) => p.url && !seen.has(p.url) && seen.add(p.url)).slice(0, scan);
  if (!posts.length) throw new Error(`No posts found on ${source}. ${notes[0] || 'If the site needs you to be logged in, log in in this browser first.'}`);

  // 2. Read each post in full (only the ones the listing didn't fully describe)
  const todo = posts.map((p, i) => [p, i]).filter(([p]) => !COMPLETE(p));
  let done = 0;
  const late = () => io.deadline && Date.now() > io.deadline;
  let skipped = 0;
  const lane = async (queue) => {
    for (let item = queue.shift(); item && !io.signal?.aborted; item = queue.shift()) {
      if (late()) { skipped++; continue; }
      const [p, i] = item;
      try {
        const { result, via: v } = await smartRun(p.url, 'socialPost', [], io, { mode: 'auto', isEmpty: (r) => !r || (r.views === '' && r.likes === '') });
        via[v === 'tab' ? 'tab' : 'background']++;
        if (result) posts[i] = merge(p, result);
      } catch (e) {
        if (io.signal?.aborted) throw e;
        posts[i] = { ...p, error: String(e.message || e).slice(0, 200) };
      }
      say(`Reading posts… ${++done} / ${todo.length}`, done, todo.length);
      await io.sleep(400); // polite pacing
    }
  };
  if (todo.length) {
    const queue = [...todo];
    await Promise.all(Array.from({ length: Math.min(3, todo.length) }, () => lane(queue)));
  }

  if (skipped) notes.push(`${skipped} post(s) were ranked from the listing only (not opened) to stay within Claude's time limit; run it from the PullRows side panel for full details.`);

  // Optional filters
  let pool = posts;
  if (platform === 'youtube-shorts' && !urls.length && !pageUrl) pool = pool.filter((p) => p.type === 'short' || (n(p.duration_s) != null && n(p.duration_s) <= 180));
  if (maxAgeDays) pool = pool.filter((p) => !p.posted || Date.now() - Date.parse(p.posted) <= maxAgeDays * 86400000);
  if (minViews) pool = pool.filter((p) => n(p.views) == null || n(p.views) >= minViews);

  // 3. Rank
  const ranked = rankPosts(pool, rankBy);
  const winners = ranked.slice(0, top);

  // 4. Transcripts for the winners
  if (transcripts) {
    let got = 0;
    for (const [k, p] of winners.entries()) {
      if (!p.transcript_url || late()) continue;
      say(`Fetching scripts… ${k + 1} / ${winners.length}`);
      try { p.transcript = await transcriptFor(p, io); if (p.transcript) got++; } catch { /* captions not available */ }
    }
    const withUrl = winners.filter((p) => p.transcript_url).length;
    if (withUrl > got) notes.push(`${withUrl - got} caption file(s) couldn't be downloaded (the platform may require playing the video first).`);
  }
  for (const p of winners) p.hook = hookOf(p);

  return {
    source,
    scanned: posts.length,
    ranked,
    top: winners,
    insights: insightsFor(winners, ranked),
    notes,
    via,
  };
}

export const TOP_COLUMNS = ['rank', 'score', 'why', 'platform', 'url', 'author', 'community', 'hook', 'caption', 'hashtags', 'views', 'likes', 'comments', 'shares', 'saves', 'engagement_rate', 'views_per_day', 'music', 'original_audio', 'duration_s', 'posted', 'author_followers', 'transcript', 'thumbnail'];
export const ALL_COLUMNS = ['rank', 'score', 'platform', 'url', 'type', 'author', 'author_followers', 'community', 'caption', 'hashtags', 'mentions', 'views', 'likes', 'comments', 'shares', 'saves', 'engagement_rate', 'views_per_day', 'music', 'original_audio', 'duration_s', 'posted', 'thumbnail', 'error'];
