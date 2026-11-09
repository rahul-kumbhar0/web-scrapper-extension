// ACCOUNT SCAN — every reel / video an account has posted, with its numbers and its spoken words.
//
// Where Trend Finder looks across a topic, this looks down one account: the whole back catalogue,
// each post opened for its real figures, each one's transcript where the platform publishes
// captions. It is deliberately slow and thorough — it runs as a background job (lib/jobs.js)
// because it takes far longer than one Claude tool call may.
//
// YouTube is paged through the site's own browse API, so a channel with 800 videos is read without
// opening a single tab. Instagram and TikTok have no such public paging, so their profiles are
// scrolled in a tab, which is also what makes them slower and login-dependent.
import { transcriptFor, rankPosts, insightsFor } from './trends.js';

const engine = () => globalThis.__webScraper;
const clean = (s, max = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

export const ACCOUNT_COLUMNS = [
  'posted', 'type', 'url', 'hook', 'caption', 'hashtags', 'views', 'likes', 'comments', 'shares', 'saves',
  'engagement_rate', 'views_per_day', 'duration_s', 'music', 'original_audio', 'transcript', 'transcript_source',
  'video_url', 'thumbnail', 'id',
];

// ---------- which account, and which pages hold its posts ----------

const YT_BASE = (seg) => `https://www.youtube.com/${seg}`;

/** "@nasa", "https://www.tiktok.com/@nasa", "instagram.com/nasa/reels/" → platform + pages. */
export function resolveAccount(input, platform = '') {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Give an account: a handle like @nasa, or a link to the profile.');

  let host = '';
  let path = '';
  if (/^https?:\/\//i.test(raw) || /^[\w-]+(\.[\w-]+)+\//.test(raw)) {
    const u = new URL(/^https?:/i.test(raw) ? raw : `https://${raw}`);
    host = u.hostname.replace(/^www\./, '').toLowerCase();
    path = u.pathname;
  }

  const from = (p, handle, pages) => ({ platform: p, handle, pages, profile: pages[0] });

  if (/youtube\.com$|youtu\.be$/.test(host)) {
    const m = path.match(/^\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)/);
    if (!m) throw new Error('That YouTube link has no channel in it. Use the channel URL or @handle.');
    const seg = m[1];
    return from('youtube', seg.replace(/^.*\//, '').replace(/^@/, ''), [YT_BASE(`${seg}/videos`), YT_BASE(`${seg}/shorts`)]);
  }
  if (/tiktok\.com$/.test(host)) {
    const h = (path.match(/^\/@([\w.-]+)/) || [])[1];
    if (!h) throw new Error('That TikTok link has no @account in it.');
    return from('tiktok', h, [`https://www.tiktok.com/@${h}`]);
  }
  if (/instagram\.com$/.test(host)) {
    const h = (path.match(/^\/([\w.]+)/) || [])[1];
    if (!h || /^(p|reel|reels|explore|stories|accounts|direct)$/.test(h)) throw new Error('That Instagram link is a post, not a profile.');
    return from('instagram', h, [`https://www.instagram.com/${h}/reels/`, `https://www.instagram.com/${h}/`]);
  }
  if (/(^|\.)(x|twitter)\.com$/.test(host)) {
    const h = (path.match(/^\/([\w]+)/) || [])[1];
    if (!h) throw new Error('That X link has no account in it.');
    return from('x', h, [`https://x.com/${h}`]);
  }
  if (host) throw new Error(`PullRows can scan accounts on YouTube, TikTok, Instagram and X — not ${host}.`);

  // A bare handle: the platform has to be named.
  const handle = raw.replace(/^@/, '');
  if (!/^[\w.-]{1,40}$/.test(handle)) throw new Error(`"${raw}" is not a handle or a profile link.`);
  switch (platform) {
    case 'youtube': case 'youtube-shorts':
      return from('youtube', handle, [YT_BASE(`@${handle}/videos`), YT_BASE(`@${handle}/shorts`)]);
    case 'tiktok': return from('tiktok', handle, [`https://www.tiktok.com/@${handle}`]);
    case 'instagram': return from('instagram', handle, [`https://www.instagram.com/${handle}/reels/`, `https://www.instagram.com/${handle}/`]);
    case 'x': return from('x', handle, [`https://x.com/${handle}`]);
    default:
      throw new Error(`Say which platform "${raw}" is on (platform: "youtube", "tiktok", "instagram" or "x"), or paste the profile link.`);
  }
}

// ---------- YouTube: page the channel through the site's own browse API ----------

const ytCfg = (html, key) => {
  const m = html.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
  return m ? m[1] : '';
};

// The continuation token sits at the end of the first page of items.
function ytContinuation(data) {
  let token = '';
  const E = engine();
  E._social.walk(data, (o) => {
    const t = o.continuationCommand?.token || o.continuationEndpoint?.continuationCommand?.token;
    if (t) token = t;
  });
  return token;
}

/**
 * Every video / short on a channel, with no tab. Falls back to throwing, and the caller then
 * scrolls the page instead.
 */
export async function youtubeChannel(pages, want, io) {
  const E = engine();
  const out = new Map();
  for (const pageUrl of pages) {
    if (out.size >= want || io.signal?.aborted) break;
    const html = await io.fetchText(pageUrl, { signal: io.signal });
    const apiKey = ytCfg(html, 'INNERTUBE_API_KEY');
    const clientVersion = ytCfg(html, 'clientVersion') || '2.20240101.00.00';
    const doc = { baseURI: pageUrl };
    const first = html.match(/ytInitialData\s*=\s*({[\s\S]*?});?<\/script>/);
    let data = null;
    if (first) { try { data = JSON.parse(first[1]); } catch { /* fall through */ } }
    if (!data) throw new Error('YouTube did not send its channel data in the page');
    for (const p of E.postsFromJson(data, doc)) out.set(p.url, p);
    await io.progress?.(`Reading the channel… ${out.size} videos`);

    let token = ytContinuation(data);
    if (!apiKey || !token) continue; // first page only
    const context = { client: { clientName: 'WEB', clientVersion, hl: 'en' } };
    for (let page = 0; page < 60 && token && out.size < want && !io.signal?.aborted; page++) {
      const body = JSON.stringify({ context, continuation: token });
      let next;
      try {
        next = await io.postJson(`https://www.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(apiKey)}`, body, { signal: io.signal });
      } catch { break; }
      const before = out.size;
      for (const p of E.postsFromJson(next, doc)) out.set(p.url, p);
      token = ytContinuation(next);
      await io.progress?.(`Reading the channel… ${out.size} videos`);
      if (out.size === before) break; // nothing new: the end of the list
      await io.sleep(400); // polite pacing
    }
  }
  if (!out.size) throw new Error('No videos found in the channel data');
  return [...out.values()];
}

// ---------- the scan ----------

const COMPLETE = (p) => p.views != null && p.views !== '' && p.posted && (p.likes != null && p.likes !== '');
const hookOf = (p) => clean(String(p.transcript || p.caption || '').split(/(?<=[.!?])\s|\n/)[0], 180);

/**
 * opts: { account, platform, limit, transcripts, detail, order }
 * io:   { fetchDoc, fetchText, postJson, collectPosts, renderInTab, smartRun, sleep, signal,
 *         progress(note, done, total), partial(rows), deadline }
 */
export async function scanAccount(opts, io) {
  const { account, platform = '', limit = 300, transcripts = true, detail = true } = opts;
  const E = engine();
  const merge = E._social.mergePost;
  const acc = resolveAccount(account, platform);
  const want = Math.max(1, Math.min(Number(limit) || 300, 2000));
  const notes = [];
  const byUrl = new Map();
  const add = (p) => { if (p?.url) byUrl.set(p.url, merge(byUrl.get(p.url), p)); };

  // 1. Collect every post the account has.
  await io.progress(`Looking up ${acc.platform} account @${acc.handle}…`, 0, want);
  if (acc.platform === 'youtube') {
    try {
      for (const p of await youtubeChannel(acc.pages, want, io)) add(p);
      notes.push(`Read the channel through YouTube's own feed — no tab was opened for the listing.`);
    } catch (e) {
      notes.push(`YouTube's channel feed could not be paged (${clean(e.message, 90)}); the page was scrolled instead.`);
    }
  }

  for (const pageUrl of acc.pages) {
    if (byUrl.size >= want || io.signal?.aborted) break;
    // Try the plain HTML first: profile pages often ship the first page of posts as JSON.
    if (acc.platform !== 'youtube') {
      try {
        const { doc } = await io.fetchDoc(pageUrl, { signal: io.signal });
        if (!E.pageBlock(doc)) for (const p of E.socialPosts(doc)) add(p);
      } catch { /* the profile needs a tab */ }
      await io.progress(`Found ${byUrl.size} posts so far…`, byUrl.size, want);
    }
    if (byUrl.size >= want) break;
    // Then scroll it. An account's whole back catalogue needs a lot of screens, so the step
    // budget is generous and patience is high — this is the slow part, and that is expected.
    const slow = acc.platform === 'instagram' || acc.platform === 'x';
    const r = await io.collectPosts(pageUrl, {
      steps: Math.min(Math.ceil(want / 3) + 20, 400),
      want,
      stepMs: slow ? 2200 : 1400,
      patience: slow ? 6 : 4,
      until: io.deadline || 0,
    }).catch((e) => { notes.push(`Could not scroll ${pageUrl}: ${clean(e.message, 90)}`); return { posts: [] }; });
    for (const p of r.posts || []) add(p);
    if (r.block) notes.push(`${r.block.label} on ${new URL(pageUrl).hostname} — log in there in this Chrome (or clear the check) and run the scan again to see the rest.`);
    await io.progress(`Found ${byUrl.size} posts so far…`, byUrl.size, want);
  }

  let posts = [...byUrl.values()].slice(0, want);
  if (!posts.length) {
    throw new Error(`No posts found for @${acc.handle} on ${acc.platform}. If the account is private or the platform asks you to log in, sign in to it in this Chrome and run the scan again.`);
  }
  if (byUrl.size > want) notes.push(`The account has more than ${want} posts; scanned the first ${want}. Raise "limit" for more.`);

  // 2. Open each post for its real figures.
  const todo = detail ? posts.map((p, i) => [p, i]).filter(([p]) => !COMPLETE(p)) : [];
  let done = 0;
  const lane = async (queue) => {
    for (let item = queue.shift(); item && !io.signal?.aborted; item = queue.shift()) {
      const [p, i] = item;
      try {
        const { result } = await io.smartRun(p.url, 'socialPost', [], { mode: 'auto', isEmpty: (r) => !r || (r.views === '' && r.likes === '') });
        if (result) posts[i] = merge(p, result);
      } catch (e) {
        posts[i] = { ...p, error: clean(e.message, 200) };
      }
      done++;
      await io.progress(`Reading each post… ${done} / ${todo.length}`, done, todo.length);
      await io.sleep(400);
    }
  };
  if (todo.length) {
    const queue = [...todo];
    await Promise.all(Array.from({ length: Math.min(3, todo.length) }, () => lane(queue)));
    await io.partial(rowsOf(posts), ACCOUNT_COLUMNS);
  }

  // 3. The voice: a transcript for every post that has a caption file.
  if (transcripts && !io.signal?.aborted) {
    let got = 0;
    let missing = 0;
    for (const [k, p] of posts.entries()) {
      if (io.signal?.aborted) break;
      if (!p.transcript_url) { if (p.type !== 'photo') missing++; continue; }
      await io.progress(`Fetching the spoken words… ${k + 1} / ${posts.length}`, k + 1, posts.length);
      try {
        p.transcript = await transcriptFor(p, io);
        p.transcript_source = p.transcript ? 'platform captions' : '';
        if (p.transcript) got++;
      } catch { p.transcript_source = ''; }
      if (k % 10 === 0) await io.partial(rowsOf(posts), ACCOUNT_COLUMNS);
    }
    if (got) notes.push(`${got} transcript(s) came from the platform's own caption files.`);
    if (missing) {
      notes.push(`${missing} post(s) publish no caption file, so there is no transcript. Their video_url is in the rows: hand it to a transcription tool to get the spoken words.`);
    }
  }

  // 4. Rank within the account and describe the patterns.
  const ranked = rankPosts(posts, opts.rankBy || 'balanced');
  for (const p of ranked) p.hook = hookOf(p);
  const rows = rowsOf(ranked);
  const insights = insightsFor(ranked.slice(0, Math.min(10, ranked.length)), ranked);

  return {
    account: `@${acc.handle}`,
    platform: acc.platform,
    profile: acc.profile,
    rows,
    columns: ACCOUNT_COLUMNS,
    ranked,
    insights,
    notes,
    summary: `${rows.length} posts from @${acc.handle}, ${rows.filter((r) => r.transcript).length} with transcripts.`,
  };
}

function rowsOf(posts) {
  return posts.map((p) => {
    const row = {};
    for (const c of ACCOUNT_COLUMNS) row[c] = p[c] ?? '';
    row.hook = p.hook || hookOf(p);
    return row;
  });
}
