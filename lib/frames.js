// KEY FRAMES FROM A VIDEO — the closest thing to "sending the reel to Claude".
//
// Claude reads text and images, never video or audio. So a reel is handed over as a short
// storyboard: a few frames spread across its length, plus its transcript and its numbers. That is
// enough to judge the hook, the pacing, the on-screen text and the cuts.
//
// The file is fetched with the extension's host permissions and turned into a blob: URL first.
// That matters — a <video> loaded straight from a CDN taints the canvas and the frames can't be
// read back, while a blob: URL is same-origin and draws cleanly.
//
// Runs in the offscreen document (it has a DOM; the service worker does not).
import { fetchWithTimeout } from './net.js';

const MAX_BYTES = 80 * 1024 * 1024;
const LOAD_TIMEOUT = 25000;
const SEEK_TIMEOUT = 15000;

function once(el, event, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); el.removeEventListener(event, ok); el.removeEventListener('error', bad); signal?.removeEventListener('abort', onAbort); fn(v); };
    const ok = () => done(resolve);
    const bad = () => done(reject, new Error(`The video could not be decoded (${el.error?.message || 'unsupported format'})`));
    const onAbort = () => done(reject, new Error('Cancelled'));
    const timer = setTimeout(() => done(reject, new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    el.addEventListener(event, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const toJpeg = async (canvas, quality) => {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/**
 * Grab `count` frames spread across the video.
 * Returns { frames: [{ at, data, mimeType }], duration, width, height }.
 */
export async function videoFrames(url, { count = 6, maxEdge = 640, quality = 0.7, signal } = {}) {
  if (typeof document === 'undefined') throw new Error('Frames can only be taken where there is a DOM (the offscreen document).');
  const res = await fetchWithTimeout(url, { timeoutMs: 90000, signal });
  if (!res.ok) throw new Error(`The video answered HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error(`That video is ${Math.round(len / 1048576)} MB — too big to read frames from.`);
  const blob = await res.blob();
  if (blob.size > MAX_BYTES) throw new Error('That video is too big to read frames from.');

  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = objectUrl;
  try {
    await once(video, 'loadedmetadata', LOAD_TIMEOUT, signal);
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const w = video.videoWidth || 0;
    const h = video.videoHeight || 0;
    if (!w || !h) throw new Error('The video has no readable picture track.');
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const canvas = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    const n = Math.max(1, Math.min(Number(count) || 6, 12));
    const frames = [];
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) break;
      // Spread the frames over the clip, skipping the very first and last moments (often black).
      const at = duration ? Math.min(duration - 0.05, duration * ((i + 0.5) / n)) : 0;
      video.currentTime = at;
      try { await once(video, 'seeked', SEEK_TIMEOUT, signal); } catch { break; }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({ at: Math.round(at * 10) / 10, data: await toJpeg(canvas, quality), mimeType: 'image/jpeg' });
    }
    if (!frames.length) throw new Error('No frame could be read from that video.');
    return { frames, duration: Math.round(duration * 10) / 10, width: w, height: h };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

// YouTube never publishes a plain video file, but it does publish per-video stills: a cover and
// three frames taken at roughly 25%, 50% and 75% of the clip. For a Short that is a usable
// storyboard, and it costs one small request each.
export const YT_ID = (url) => (String(url).match(/(?:v=|\/shorts\/|youtu\.be\/|\/embed\/)([\w-]{6,})/) || [])[1] || '';

export function youtubeStills(url) {
  const id = YT_ID(url);
  if (!id) return [];
  return [
    { at: 'cover', url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, fallback: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` },
    { at: '~25%', url: `https://i.ytimg.com/vi/${id}/1.jpg` },
    { at: '~50%', url: `https://i.ytimg.com/vi/${id}/2.jpg` },
    { at: '~75%', url: `https://i.ytimg.com/vi/${id}/3.jpg` },
  ];
}
