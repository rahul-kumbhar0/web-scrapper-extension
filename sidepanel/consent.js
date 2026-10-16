// One-time disclosure before the first AI feature sends page or table data to Anthropic.
import { formDialog } from './ui.js';
import { saveSettings } from '../lib/storage.js';

export async function ensureAiConsent(ctx) {
  if (ctx.settings.aiConsentAt) return true;
  const ok = await formDialog({
    title: 'Send this data to Claude?',
    text: 'AI features send the page text or the table rows you choose to Anthropic’s API, using your own API key. Anthropic processes it under its API terms; PullRows never sees it.\n\nDon’t use AI features on pages with information you aren’t allowed to share.',
    submit: 'I understand',
  });
  if (!ok) return false;
  await saveSettings({ aiConsentAt: Date.now() });
  await ctx.reloadSettings();
  return true;
}
