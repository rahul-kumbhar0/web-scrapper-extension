// AI extraction via the Claude Messages API, called directly from the side panel with the
// user's own API key (stored locally). The extension has no build step, so this uses fetch
// rather than bundling the SDK.

const API_URL = 'https://api.anthropic.com/v1/messages';
export const MAX_PAGE_CHARS = 150000;

const SYSTEM = `You extract structured data from web page text for a web scraping tool.
Return every item that matches the user's request, as a table: pick short, consistent column names, then one row per item with values in the same order as the columns.
Copy values exactly as they appear on the page; use an empty string when a value is missing. Do not invent data. If nothing matches, return no rows.`;

// Structured outputs require additionalProperties:false, so rows are arrays aligned to `columns`.
const SCHEMA = {
  type: 'object',
  properties: {
    columns: { type: 'array', items: { type: 'string' } },
    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
  },
  required: ['columns', 'rows'],
  additionalProperties: false,
};

export async function aiExtract({ apiKey, model, goal, page, signal }) {
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.');

  const body = {
    model,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Page title: ${page.title}\nPage URL: ${page.url}\n\n<page_text>\n${page.text}\n</page_text>\n\nWhat to extract: ${goal}`,
    }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  // If a safety classifier declines on Opus/Sonnet, let the API retry on a suitable fallback model.
  if (/opus|sonnet/.test(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }

  const res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    if (res.status === 401) throw new Error('Invalid API key. Check it in Settings.');
    if (res.status === 429) throw new Error('Rate limited by the API — wait a moment and try again.');
    throw new Error(`Claude API error ${res.status}: ${msg}`);
  }
  if (json.stop_reason === 'refusal') throw new Error('Claude declined this request.');
  if (json.stop_reason === 'max_tokens') throw new Error('Too much data for one request — narrow down what to extract.');

  const text = json.content?.find((b) => b.type === 'text')?.text;
  const { columns, rows } = JSON.parse(text);
  return {
    rows: rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? '']))),
    usage: json.usage,
    model: json.model,
  };
}
