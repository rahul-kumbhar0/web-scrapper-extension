// Counts successful runs/exports and decides when to ask, once, for a store review.
// Asking is never tied to a reward (Chrome Web Store policy forbids incentivised reviews).
const SNOOZE_MS = 14 * 24 * 3600 * 1000;

async function getStats() {
  const { stats } = await chrome.storage.local.get('stats');
  return stats || { runs: 0, exports: 0, firstAt: Date.now() };
}

export async function recordWin(kind) {
  const s = await getStats();
  if (kind === 'export') s.exports++; else s.runs++;
  await chrome.storage.local.set({ stats: s });
}

export async function shouldAskReview() {
  const s = await getStats();
  if (s.review === 'done' || s.review === 'never') return false;
  if (s.snoozedAt && Date.now() - s.snoozedAt < SNOOZE_MS) return false;
  return s.exports >= 2 || s.runs >= 5;
}

export async function answerReview(answer) {
  const s = await getStats();
  if (answer === 'later') s.snoozedAt = Date.now(); else s.review = answer;
  await chrome.storage.local.set({ stats: s });
}

export const reviewUrl = () => `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;
