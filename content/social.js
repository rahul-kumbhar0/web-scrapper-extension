// SOCIAL POSTS — reads Reels, TikToks, Shorts/videos and posts as data: caption, hashtags, views,
// likes, comments, shares, saves, sound/music, duration, date, author, followers and (where the
// platform publishes captions) a transcript link.
//
// Instagram, TikTok and YouTube embed each post's data as JSON inside the page (<script> blocks such
// as __UNIVERSAL_DATA_FOR_REHYDRATION__, ytInitialData/ytInitialPlayerResponse, Instagram's
// data-sjs blocks). Reading that JSON gives exact numbers ("1234567", not "1.2M") and fields the
// layout never shows (the sound, the duration, the exact upload time), and it keeps working when
// the platforms reshuffle their markup. The visible page (og: tags, tile links) is the fallback.
//
// Loaded after content/engine.js and attached to the same global. Works on live pages and on
// fetched (DOMParser) documents.
(() => {
  const W = globalThis.__webScraper;
  if (!W || W.socialPost) return;

  const clean = (s, max = 5000) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const baseOf = (doc) => doc.baseURI || location.href;
  const hostOf = (doc) => { try { return new URL(baseOf(doc)).hostname.replace(/^(www|m)\./, ''); } catch { return ''; } };
  const abs = (u, doc) => { try { return new URL(u, baseOf(doc)).href; } catch { return ''; } };
  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);

  // ---------- JSON embedded in the page ----------

  // The balanced {...} or [...] that starts at `start` (string-aware), or null.
  function sliceJson(text, start) {
    const open = text[start];
    const close = open === '{' ? '}' : open === '[' ? ']' : '';
    if (!close) return null;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
  }

  const ASSIGNED = /(?:ytInitialData|ytInitialPlayerResponse|__INITIAL_STATE__|__APOLLO_STATE__|__PRELOADED_STATE__|__NUXT__|_sharedData|__additionalDataLoaded\([^,]+,|SIGI_STATE)\s*["'\]]*\s*[=,(]?\s*(?=[{[])/g;
  const MAX_SCRIPT = 12 * 1024 * 1024;

  // Every JSON value embedded in the page, tagged with where it came from.
  function pageJson(doc) {
    const out = [];
    for (const s of doc.querySelectorAll('script')) {
      const text = s.textContent || '';
      if (text.length < 20 || text.length > MAX_SCRIPT) continue;
      const type = (s.getAttribute('type') || '').toLowerCase();
      if (type.includes('json')) {
        try { out.push({ name: s.id || type, data: JSON.parse(text) }); } catch { /* not JSON */ }
        continue;
      }
      if (type && !/javascript|module/.test(type)) continue;
      ASSIGNED.lastIndex = 0;
      let m;
      let n = 0;
      while ((m = ASSIGNED.exec(text)) && n++ < 6) {
        const json = sliceJson(text, m.index + m[0].length);
        if (!json) continue;
        const name = m[0].match(/^[\w$]+/)?.[0] || 'inline';
        try { out.push({ name, data: JSON.parse(json) }); } catch { /* JS object literal, not JSON */ }
        ASSIGNED.lastIndex = m.index + m[0].length + json.length;
      }
    }
    return out;
  }

  // Depth-first walk with a node budget (some pages embed megabytes of JSON).
  function walk(root, visit, budget = 400000) {
    const stack = [root];
    let n = 0;
    while (stack.length && n++ < budget) {
      const o = stack.pop();
      if (Array.isArray(o)) { for (let i = o.length - 1; i >= 0; i--) if (o[i] && typeof o[i] === 'object') stack.push(o[i]); continue; }
      if (!isObj(o)) continue;
      visit(o);
      for (const k in o) { const v = o[k]; if (v && typeof v === 'object') stack.push(v); }
    }
  }

  // ---------- value helpers ----------

  // YouTube text objects: "x", {simpleText}, {runs:[{text}]}, {content}.
  const txt = (x) => {
    if (x == null) return '';
    if (typeof x === 'string' || typeof x === 'number') return String(x);
    if (x.simpleText != null) return String(x.simpleText);
    if (Array.isArray(x.runs)) return x.runs.map((r) => r.text || '').join('');
    if (x.content != null) return String(x.content);
    if (x.text != null && typeof x.text !== 'object') return String(x.text);
    return '';
  };
  const SUFFIX = { k: 1e3, m: 1e6, b: 1e9, '万': 1e4, '萬': 1e4, '亿': 1e8, '億': 1e8, 'mil': 1e3, 'mio': 1e6, 'lakh': 1e5, 'cr': 1e7 };
  // 1234, "1,234", "1.2M views", "12万" → number; anything else → null.
  function num(x) {
    if (x == null || x === '') return null;
    if (typeof x === 'number') return Number.isFinite(x) ? x : null;
    if (isObj(x)) return num(txt(x));
    const s = String(x).replace(/[  ]/g, ' ');
    const m = s.match(/(\d[\d,.\s]*)\s*(k|m|b|万|萬|亿|億|mil|mio|lakh|cr)?\b/i) || s.match(/(\d[\d,.\s]*)\s*(万|萬|亿|億)/);
    if (!m) return null;
    let d = m[1].trim().replace(/\s/g, '');
    const suffix = (m[2] || '').toLowerCase();
    if (suffix) d = d.replace(',', '.'); // "1,2K"
    else d = d.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.');
    const n = parseFloat(d);
    return Number.isFinite(n) ? Math.round(n * (SUFFIX[suffix] || 1)) : null;
  }
  const first = (...xs) => { for (const x of xs) if (x != null && x !== '') return x; return null; };
  const firstNum = (...xs) => { for (const x of xs) { const n = num(x); if (n != null) return n; } return null; };

  // Unix seconds/ms, ISO strings, or "3 days ago" → ISO date-time.
  const AGO_UNITS = [[/sec|second|秒|초|сек/i, 1], [/min|minute|分|분|мин/i, 60], [/hour|hr|\bh\b|時間|小时|시간|час|घंटे|घंटा/i, 3600], [/day|\bd\b|日|天|일|дн|день|दिन/i, 86400], [/week|\bw\b|週|周|주|недел|सप्ताह|हफ्ते/i, 604800], [/month|mo\b|か月|个月|개월|месяц|महीने/i, 2592000], [/year|\by\b|年|년|год|лет|साल|वर्ष/i, 31536000]];
  function toIso(x) {
    if (x == null || x === '') return '';
    if (typeof x === 'number' || /^\d{9,13}$/.test(String(x))) {
      const n = Number(x);
      const d = new Date(n < 1e12 ? n * 1000 : n);
      return Number.isNaN(d.getTime()) ? '' : d.toISOString();
    }
    const s = clean(txt(x), 120);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const d = new Date(s); return Number.isNaN(d.getTime()) ? s : d.toISOString(); }
    const ago = s.match(/(\d+)\s*([^\d\s]+)/);
    if (ago && /ago|前|전|назад|पहले|hace|il y a|vor|fa\b|geleden|sedan|önce|streamed|premiered/i.test(s)) {
      const unit = AGO_UNITS.find(([re]) => re.test(ago[2]));
      if (unit) return new Date(Date.now() - Number(ago[1]) * unit[1] * 1000).toISOString();
    }
    if (/yesterday|gestern|hier|ayer|昨日|어제|вчера|कल/i.test(s)) return new Date(Date.now() - 86400000).toISOString();
    const d = new Date(s);
    return Number.isNaN(d.getTime()) || d.getFullYear() < 2004 ? '' : d.toISOString();
  }
  // "1:02:03" / "0:45" / 45 → seconds
  function seconds(x) {
    if (x == null || x === '') return null;
    if (typeof x === 'number') return x > 36000 ? Math.round(x / 1000) : Math.round(x); // ms or s
    const s = txt(x);
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
    const m = s.match(/(?:(\d+):)?(\d{1,2}):(\d{2})/);
    return m ? (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) : null;
  }

  const HASHTAG = /(?:^|[^\p{L}\p{N}_&/])#([\p{L}\p{N}_][\p{L}\p{N}_.]*[\p{L}\p{N}_]|[\p{L}\p{N}_])/gu;
  const MENTION = /(?:^|[^\p{L}\p{N}_@/])@([\w.]{2,30}\w)/gu;
  const tagsIn = (s) => [...String(s || '').matchAll(HASHTAG)].map((m) => m[1]).filter((t) => /\p{L}/u.test(t)).map((t) => '#' + t);
  const mentionsIn = (s) => [...String(s || '').matchAll(MENTION)].map((m) => '@' + m[1]);
  const uniq = (a) => [...new Set(a.filter(Boolean).map((x) => String(x)))];

  // ---------- one platform object → one normalised post ----------

  const POST_FIELDS = ['platform', 'url', 'type', 'author', 'author_followers', 'community', 'caption', 'hashtags', 'mentions', 'views', 'likes', 'comments', 'shares', 'saves', 'music', 'original_audio', 'duration_s', 'posted', 'thumbnail', 'transcript_url', 'id'];

  function platformOf(doc, o) {
    const h = hostOf(doc);
    if (/instagram\.com$/.test(h)) return 'instagram';
    if (/tiktok\.com$/.test(h)) return 'tiktok';
    if (/youtube\.com$|youtu\.be$/.test(h)) return 'youtube';
    if (/(^|\.)(x|twitter)\.com$/.test(h)) return 'x';
    if (/reddit\.com$/.test(h)) return 'reddit';
    if (o?.videoId) return 'youtube';
    if (o?.aweme_id || o?.diggCount != null || o?.stats?.diggCount != null) return 'tiktok';
    if (o?.shortcode || o?.code || o?.taken_at != null) return 'instagram';
    return h || 'web';
  }

  function music(o) {
    const cm = o.clips_metadata || o.clips_music_attribution_info && { music_info: { music_asset_info: o.clips_music_attribution_info } };
    const mi = cm?.music_info?.music_asset_info || o.music_metadata?.music_info?.music_asset_info;
    if (mi) return { music: clean([mi.title || mi.song_name, mi.display_artist || mi.artist_name].filter(Boolean).join(' — '), 200), original: false };
    const os = cm?.original_sound_info || o.music_metadata?.original_sound_info;
    if (os) return { music: clean(`${os.original_audio_title || 'Original audio'}${os.ig_artist?.username ? ` — ${os.ig_artist.username}` : ''}`, 200), original: true };
    if (isObj(o.music) && (o.music.title || o.music.authorName)) {
      return { music: clean([o.music.title, o.music.authorName].filter(Boolean).join(' — '), 200), original: !!o.music.original || /original sound|son original|sonido original/i.test(o.music.title || '') };
    }
    return null;
  }

  function idOf(o) {
    if (o.videoId && typeof o.videoId === 'string') return o.videoId;
    if (o.aweme_id) return String(o.aweme_id);
    if (o.code && typeof o.code === 'string' && (o.taken_at != null || o.like_count != null || o.caption !== undefined)) return o.code;
    if (o.shortcode && typeof o.shortcode === 'string') return o.shortcode;
    if (o.id != null && (o.desc != null || o.stats || o.statsV2 || o.video?.duration != null || o.createTime != null)) return String(o.id);
    return null;
  }

  // TikTok / YouTube / Instagram "item" objects → a post, or null if `o` isn't one.
  function postFrom(o, doc) {
    // YouTube renderers keep the useful object one level down.
    const lockup = o.shortsLockupViewModel;
    if (lockup) {
      const vid = lockup.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId || lockup.entityId?.replace(/^shorts-shelf-item-/, '');
      if (!vid) return null;
      return finish({ platform: 'youtube', id: vid, type: 'short', url: `https://www.youtube.com/shorts/${vid}`,
        caption: txt(lockup.overlayMetadata?.primaryText) || lockup.accessibilityText?.split(',')[0] || '',
        hashtags: tagsIn(txt(lockup.overlayMetadata?.primaryText)),
        views: num(txt(lockup.overlayMetadata?.secondaryText)),
        thumbnail: lockup.thumbnail?.sources?.[0]?.url || '' });
    }
    const id = idOf(o);
    if (!id) return null;
    const platform = platformOf(doc, o);
    const stats = o.stats || o.statsV2 || {};
    const caption = clean(first(
      o.caption?.text, typeof o.caption === 'string' ? o.caption : null,
      o.edge_media_to_caption?.edges?.[0]?.node?.text,
      o.desc, txt(o.title), txt(o.headline), o.shortDescription, txt(o.descriptionSnippet), o.accessibility_caption,
    ) || '', 5000);
    const author = clean(first(o.user?.username, o.owner?.username, o.author?.uniqueId, typeof o.author === 'string' ? o.author : null,
      o.author?.name, txt(o.ownerText), txt(o.longBylineText), txt(o.shortBylineText), o.ownerChannelName) || '', 100);
    const mus = music(o);
    const isReel = o.product_type === 'clips' || o.media_type === 2 && o.product_type !== 'feed' || !!o.clips_metadata;
    let url = '';
    let type = '';
    if (platform === 'youtube') {
      const shortLike = !!o.headline || o.isShortsEligible || /shorts/.test(o.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || '');
      type = shortLike ? 'short' : 'video';
      url = shortLike ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`;
    } else if (platform === 'tiktok') {
      type = o.imagePost ? 'photo' : 'video';
      url = author ? `https://www.tiktok.com/@${author}/${type === 'photo' ? 'photo' : 'video'}/${id}` : '';
    } else if (platform === 'instagram') {
      type = isReel ? 'reel' : o.carousel_media_count || o.edge_sidecar_to_children ? 'carousel' : o.is_video ? 'video' : 'post';
      url = `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${id}/`;
    }
    const thumbs = o.thumbnail?.thumbnails;
    const post = {
      platform, id, type, url, author,
      author_followers: firstNum(o.user?.follower_count, o.owner?.edge_followed_by?.count, o.authorStats?.followerCount, o.authorStats?.followers, o.author?.followerCount),
      caption,
      hashtags: uniq([...tagsIn(`${caption} ${txt(o.descriptionSnippet)}`), ...(o.textExtra || []).map((t) => t.hashtagName && '#' + t.hashtagName), ...(o.challenges || []).map((c) => c.title && '#' + c.title), ...(o.keywords || []).filter((k) => /^#/.test(k))]),
      mentions: uniq([...mentionsIn(caption), ...(o.usertags?.in || []).map((u) => u.user?.username && '@' + u.user.username)]),
      views: firstNum(o.play_count, o.ig_play_count, o.view_count, o.video_view_count, o.video_play_count, stats.playCount, o.playCount, o.viewCount, txt(o.viewCountText), txt(o.shortViewCountText)),
      likes: firstNum(o.like_count, o.edge_media_preview_like?.count, o.edge_liked_by?.count, stats.diggCount, o.diggCount, o.likeCount),
      comments: firstNum(o.comment_count, o.edge_media_to_comment?.count, o.edge_media_to_parent_comment?.count, stats.commentCount, o.commentCount),
      shares: firstNum(o.reshare_count, o.share_count, stats.shareCount, o.shareCount),
      saves: firstNum(o.save_count, stats.collectCount, o.collectCount),
      music: mus?.music || '',
      original_audio: mus ? (mus.original ? 'yes' : 'no') : '',
      duration_s: seconds(first(o.video_duration, o.video?.duration, o.lengthSeconds, txt(o.lengthText))),
      posted: toIso(first(o.taken_at, o.taken_at_timestamp, o.createTime, o.publishDate, o.uploadDate, o.datePublished, txt(o.publishedTimeText))),
      thumbnail: first(o.image_versions2?.candidates?.[0]?.url, o.display_url, o.thumbnail_src, o.video?.cover, o.video?.originCover, thumbs?.[thumbs.length - 1]?.url) || '',
      transcript_url: tiktokSubtitles(o) || '',
    };
    if (!post.caption && post.views == null && post.likes == null && !post.music) return null;
    return finish(post);
  }

  function tiktokSubtitles(o) {
    const subs = o.video?.subtitleInfos || o.video?.subtitles;
    if (!Array.isArray(subs) || !subs.length) return '';
    const pick = subs.find((s) => /^en/i.test(s.LanguageCodeName || s.languageCodeName || '')) || subs[0];
    return pick.Url || pick.url || '';
  }

  function finish(p) {
    const out = {};
    for (const k of POST_FIELDS) out[k] = p[k] ?? '';
    out.hashtags = Array.isArray(p.hashtags) ? p.hashtags.join(' ') : p.hashtags || '';
    out.mentions = Array.isArray(p.mentions) ? p.mentions.join(' ') : p.mentions || '';
    return out;
  }

  // Combine two readings of the same post, keeping every value either one has.
  function mergePost(a, b) {
    if (!a) return b;
    if (!b) return a;
    const out = { ...a };
    for (const k of POST_FIELDS) {
      if (out[k] === '' || out[k] == null) out[k] = b[k];
      else if (typeof out[k] === 'number' && typeof b[k] === 'number') out[k] = Math.max(out[k], b[k]); // the fresher count
      else if (k === 'caption' && String(b[k]).length > String(out[k]).length) out[k] = b[k];
      else if (k === 'hashtags' || k === 'mentions') out[k] = uniq(`${out[k]} ${b[k]}`.split(/\s+/)).join(' ');
    }
    return out;
  }
  const filled = (p) => POST_FIELDS.filter((k) => p[k] !== '' && p[k] != null).length;

  // ---------- page-level readers ----------

  // YouTube watch / Shorts page: ytInitialPlayerResponse holds the video; likes are in ytInitialData.
  function youtubeWatch(blobs, doc) {
    const player = blobs.find((b) => b.name === 'ytInitialPlayerResponse')?.data;
    const vd = player?.videoDetails;
    if (!vd?.videoId) return null;
    const mf = player.microformat?.playerMicroformatRenderer || {};
    const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const track = tracks.find((t) => /^en/.test(t.languageCode) && t.kind !== 'asr') || tracks.find((t) => /^en/.test(t.languageCode)) || tracks[0];
    const data = JSON.stringify(blobs.find((b) => b.name === 'ytInitialData')?.data || {});
    // Exact counts first (likeCountIfIndifferentNumber / numeric likeCount); "along with N other people"
    // only for the video itself — comments carry the same phrase.
    const likes = data.match(/"likeCountIfIndifferentNumber"\s*:\s*"(\d+)"/)?.[1] || data.match(/"likeCount"\s*:\s*(\d+)/)?.[1] ||
      data.match(/like this video along with ([\d,.\s]+) other/)?.[1] || data.match(/"likeCount(?:IfLiked|WithLikeText)?"\s*:\s*\{[^}]*?"content"\s*:\s*"([^"]+)"/)?.[1] ||
      data.match(/"title"\s*:\s*"([\d.,]+\s*[KMB]?)"\s*,\s*"[^"]*"\s*:\s*[^,]*,\s*"iconName"\s*:\s*"LIKE"/)?.[1];
    const comments = data.match(/"commentCount"\s*:\s*\{[^}]*?"content"\s*:\s*"([^"]+)"/)?.[1] || data.match(/"contextualInfo"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([\d.,]+\s*[KMB]?)"/)?.[1];
    const short = /\/shorts\//.test(baseOf(doc)) || mf.isShortsEligible;
    const desc = vd.shortDescription || '';
    return finish({
      platform: 'youtube', id: vd.videoId, type: short ? 'short' : 'video',
      url: short ? `https://www.youtube.com/shorts/${vd.videoId}` : `https://www.youtube.com/watch?v=${vd.videoId}`,
      author: vd.author || mf.ownerChannelName || '',
      caption: clean(`${vd.title || ''}${desc ? `\n${desc}` : ''}`, 5000),
      hashtags: uniq([...tagsIn(`${vd.title} ${desc}`), ...(vd.keywords || []).map((k) => (k.startsWith('#') ? k : ''))]),
      mentions: uniq(mentionsIn(desc)),
      views: num(vd.viewCount), likes: num(likes), comments: num(comments),
      duration_s: seconds(vd.lengthSeconds), posted: toIso(mf.publishDate || mf.uploadDate),
      thumbnail: vd.thumbnail?.thumbnails?.slice(-1)[0]?.url || '',
      transcript_url: track?.baseUrl || '',
      music: (data.match(/"attributionTitle"\s*:\s*\{[^}]*?"content"\s*:\s*"([^"]+)"/) || data.match(/"reelSoundMetadata"[\s\S]{0,400}?"(?:title|content)"\s*:\s*"([^"]+)"/))?.[1] || '',
    });
  }

  // Instagram's server-rendered og:description: "1,234 likes, 56 comments - user on May 4, 2026: "caption"."
  function instagramMeta(doc) {
    const d = doc.querySelector('meta[property="og:description"], meta[name="description"]')?.getAttribute('content') || '';
    const m = d.match(/^\s*([\d.,]+\s*[KkMm]?)\s+likes?,\s*([\d.,]+\s*[KkMm]?)\s+comments?\s*-\s*([\w.]+)\s+on\s+([^:]+?):\s*"?([\s\S]*?)"?\.?\s*$/i);
    if (!m) return null;
    const code = baseOf(doc).match(/\/(?:p|reels?|tv)\/([\w-]+)/)?.[1] || '';
    const caption = m[5].trim();
    return finish({ platform: 'instagram', id: code, type: /\/reels?\//.test(baseOf(doc)) ? 'reel' : 'post', url: code ? baseOf(doc).split('?')[0] : '',
      author: m[3], likes: num(m[1]), comments: num(m[2]), posted: toIso(m[4]), caption, hashtags: tagsIn(caption), mentions: mentionsIn(caption),
      thumbnail: doc.querySelector('meta[property="og:image"]')?.getAttribute('content') || '' });
  }

  // ---------- Reddit ----------

  const REDDIT = 'https://www.reddit.com';
  // Reddit's JSON escapes &, < and > in titles and text.
  const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x200B;/gi, '').replace(/&amp;/g, '&');
  function redditPost(d) {
    if (!d?.id || !d.permalink) return null;
    const media = d.media?.reddit_video || d.secure_media?.reddit_video;
    const thumb = /^https?:/.test(d.thumbnail || '') ? d.thumbnail : (d.preview?.images?.[0]?.source?.url || '').replace(/&amp;/g, '&');
    const caption = clean(unescape(`${d.title || ''}${d.selftext ? `\n${d.selftext}` : ''}`), 5000);
    return finish({
      platform: 'reddit', id: d.id, url: REDDIT + d.permalink,
      type: d.is_video ? 'video' : d.is_gallery ? 'gallery' : d.is_self ? 'text' : d.post_hint === 'image' ? 'image' : 'link',
      author: d.author || '', community: d.subreddit_name_prefixed || (d.subreddit ? `r/${d.subreddit}` : ''),
      caption, hashtags: tagsIn(caption), mentions: uniq((caption.match(/\bu\/[\w-]+/g) || [])),
      views: num(d.view_count), likes: num(d.score ?? d.ups), comments: num(d.num_comments), shares: num(d.num_crossposts),
      duration_s: seconds(media?.duration), posted: toIso(d.created_utc), thumbnail: thumb,
    });
  }
  /** Posts in Reddit listing JSON (/search.json, /r/sub/top.json, /comments/id.json). */
  function redditFromJson(json) {
    const out = [];
    walk(json, (o) => { if (o.kind === 't3' && o.data) { const p = redditPost(o.data); if (p) out.push(p); } });
    return out;
  }
  // New Reddit renders each post as <shreddit-post> with its data in attributes.
  function redditFromDom(doc) {
    return [...doc.querySelectorAll('shreddit-post[permalink], shreddit-post[post-title]')].map((el) => {
      const a = (k) => el.getAttribute(k) || '';
      const caption = clean(`${a('post-title')}${el.querySelector('[slot="text-body"]')?.textContent ? `\n${el.querySelector('[slot="text-body"]').textContent}` : ''}`, 5000);
      return finish({
        platform: 'reddit', id: (a('id') || a('thingid') || '').replace(/^t3_/, '') || urlId(a('permalink')), url: abs(a('permalink'), doc).replace(/^https?:\/\/[^/]+/, (h) => (/reddit\.com$/.test(new URL(h).hostname) ? REDDIT : h)),
        type: a('post-type'), author: a('author'), community: a('subreddit-prefixed-name'), caption, hashtags: tagsIn(caption),
        likes: num(a('score')), comments: num(a('comment-count')), posted: toIso(a('created-timestamp')),
        thumbnail: el.querySelector('img[src*="preview"], img[src*="redd.it"]')?.getAttribute('src') || '',
      });
    }).filter((p) => p.id);
  }

  // ---------- X (Twitter) ----------
  // X builds its pages with JavaScript, so posts are read from the rendered timeline. Counts come from
  // the action buttons' labels ("1,234 Likes. Like"), which start with the number in every language.
  const firstNumber = (s) => num(String(s || '').match(/[\d][\d.,\s]*\s*[KkMmBb万萬亿億]?/)?.[0]);
  function xFromDom(doc) {
    const out = [];
    for (const art of doc.querySelectorAll('article[data-testid="tweet"], article[role="article"]')) {
      if (art.querySelector('[data-testid="placementTracking"]')) continue; // ads
      const time = art.querySelector('time');
      const link = time?.closest('a[href*="/status/"]') || art.querySelector('a[href*="/status/"]');
      const url = link ? abs(link.getAttribute('href'), doc).split('?')[0].replace(/\/(analytics|photo|video)\/.*$/, '') : '';
      const id = urlId(url);
      if (!id) continue;
      const textEl = art.querySelector('[data-testid="tweetText"]');
      const caption = clean(textEl ? (doc.defaultView ? textEl.innerText : textEl.textContent) : '', 5000);
      const label = (t) => art.querySelector(`[data-testid="${t}"], [data-testid="un${t}"]`)?.getAttribute('aria-label') || art.querySelector(`[data-testid="${t}"], [data-testid="un${t}"]`)?.textContent;
      const views = art.querySelector('a[href$="/analytics"]')?.getAttribute('aria-label') || art.querySelector('a[href$="/analytics"]')?.textContent;
      const group = art.querySelector('[role="group"][aria-label]')?.getAttribute('aria-label') || '';
      const fromGroup = (re) => num(group.match(re)?.[1]);
      out.push(finish({
        platform: 'x', id, url: url.replace(/^https?:\/\/(www\.)?twitter\.com/, 'https://x.com'),
        type: art.querySelector('[data-testid="videoPlayer"], [data-testid="videoComponent"], video') ? 'video' : art.querySelector('[data-testid="tweetPhoto"]') ? 'photo' : 'text',
        author: url.match(/\/([^/]+)\/status\//)?.[1] || '',
        caption, hashtags: tagsIn(caption), mentions: mentionsIn(caption),
        comments: firstNumber(label('reply')) ?? fromGroup(/([\d.,]+[KMB]?)\s+repl/i),
        shares: firstNumber(label('retweet')) ?? fromGroup(/([\d.,]+[KMB]?)\s+(?:repost|retweet)/i),
        likes: firstNumber(label('like')) ?? fromGroup(/([\d.,]+[KMB]?)\s+like/i),
        saves: firstNumber(label('bookmark')) ?? fromGroup(/([\d.,]+[KMB]?)\s+bookmark/i),
        views: firstNumber(views) ?? fromGroup(/([\d.,]+[KMB]?)\s+view/i),
        posted: toIso(time?.getAttribute('datetime')),
        thumbnail: abs(art.querySelector('[data-testid="tweetPhoto"] img, video[poster]')?.getAttribute('src') || art.querySelector('video[poster]')?.getAttribute('poster') || '', doc),
      }));
    }
    return out;
  }

  // The id a post URL points at.
  function urlId(u) {
    const s = String(u || '');
    return s.match(/\/(?:p|reels?|tv)\/([\w-]+)/)?.[1] || s.match(/\/(?:video|photo)\/(\d+)/)?.[1] || s.match(/[?&]v=([\w-]{6,})/)?.[1] ||
      s.match(/\/shorts\/([\w-]+)/)?.[1] || s.match(/youtu\.be\/([\w-]+)/)?.[1] ||
      s.match(/\/status(?:es)?\/(\d+)/)?.[1] || s.match(/\/comments\/(\w+)/)?.[1] || '';
  }

  /** Every post the page carries data for (search results, hashtag pages, feeds, profiles). */
  function socialPosts(doc = document) {
    const blobs = pageJson(doc);
    const byId = new Map();
    const add = (p) => { if (p?.id) byId.set(p.id, mergePost(byId.get(p.id), p)); };
    add(youtubeWatch(blobs, doc));
    for (const b of blobs) walk(b.data, (o) => add(postFrom(o, doc)));
    for (const p of [...redditFromDom(doc), ...xFromDom(doc)]) add(p);
    // Tiles in the visible page that the JSON didn't cover (content loaded while scrolling).
    for (const a of doc.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/video/"], a[href*="/shorts/"], a[href*="/watch?v="]')) {
      const url = abs(a.getAttribute('href'), doc).split('#')[0];
      const id = urlId(url);
      if (!id || byId.has(id) || /\/(explore|accounts|stories)\//.test(url)) continue;
      const tile = a.closest('[data-e2e*="item"], article, li, ytd-rich-item-renderer, ytd-video-renderer') || a;
      const viewsEl = tile.querySelector('[data-e2e="video-views"], [aria-label*="view" i], #metadata-line span');
      const caption = clean(a.querySelector('img')?.getAttribute('alt') || a.getAttribute('title') || a.getAttribute('aria-label') || tile.querySelector('#video-title, [data-e2e*="desc"]')?.textContent || '', 2000);
      add(finish({ platform: platformOf(doc), id, url: url.replace(/\?.*$/, (q) => (/[?&]v=/.test(q) ? `?v=${id}` : '')), type: /\/reels?\//.test(url) ? 'reel' : /shorts/.test(url) ? 'short' : '',
        caption, hashtags: tagsIn(caption), views: num(viewsEl?.textContent || viewsEl?.getAttribute('aria-label')),
        thumbnail: abs(a.querySelector('img')?.getAttribute('src') || '', doc) }));
    }
    return [...byId.values()].filter((p) => p.url);
  }

  /** The single post a post page is about, with as many fields as the page provides (or null). */
  function socialPost(doc = document) {
    const want = urlId(baseOf(doc));
    const blobs = pageJson(doc);
    let best = youtubeWatch(blobs, doc);
    if (best && want && best.id !== want) best = null;
    const all = [];
    if (!best) {
      for (const b of blobs) walk(b.data, (o) => { const p = postFrom(o, doc); if (p) all.push(p); });
      const same = all.filter((p) => want && p.id === want);
      best = (same.length ? same : all).reduce((acc, p) => (same.length ? mergePost(acc, p) : !acc || filled(p) > filled(acc) ? p : acc), null);
    }
    // Reddit / X post pages: the post itself, not replies or related posts.
    const domPosts = [...redditFromDom(doc), ...xFromDom(doc)];
    const own = domPosts.find((p) => want && p.id === want) || (!best && domPosts[0]);
    if (own) best = mergePost(own, best && best.id === own.id ? best : null);
    best = mergePost(best, instagramMeta(doc));
    if (!best) {
      const og = (p) => doc.querySelector(`meta[property="og:${p}"]`)?.getAttribute('content') || '';
      const caption = clean(og('description') || og('title'), 5000);
      if (!caption) return null;
      best = finish({ platform: platformOf(doc), id: want, url: baseOf(doc), caption, hashtags: tagsIn(caption), mentions: mentionsIn(caption), thumbnail: og('image') });
    }
    if (!best.url) best.url = baseOf(doc);
    return best;
  }

  Object.assign(W, { socialPost, socialPosts, redditFromJson, POST_FIELDS, _social: { pageJson, num, toIso, seconds, tagsIn, urlId, mergePost } });
})();
