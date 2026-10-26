// Claude features, called directly from the side panel with the user's own API key (stored
// locally). The extension has no build step, so this uses fetch rather than bundling the SDK.

const API_URL = 'https://api.anthropic.com/v1/messages';
export const MAX_PAGE_CHARS = 150000;
const ROWS_PER_BATCH = 25;

async function callClaude({ apiKey, model, system, content, schema, effort = 'medium', maxTokens = 16000, signal }) {
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.');
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
    output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
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
  // Retry rate limits (429), overload (529) and server errors with exponential backoff.
  let res;
  let json;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal });
    json = await res.json().catch(() => ({}));
    const retryable = res.status === 429 || res.status >= 500;
    if (res.ok || !retryable || attempt >= 3) break;
    const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(wait, 30000)));
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('Invalid API key. Check it in Settings.');
    if (res.status === 429) throw new Error('Rate limited by the API — wait a moment and try again.');
    if (res.status === 529) throw new Error('Claude is overloaded right now — try again in a minute.');
    throw new Error(`Claude API error ${res.status}: ${json?.error?.message || res.statusText}`);
  }
  if (json.stop_reason === 'refusal') throw new Error('Claude declined this request.');
  if (json.stop_reason === 'max_tokens') throw new Error('Too much data for one request — narrow it down.');
  const text = json.content?.find((b) => b.type === 'text')?.text || '';
  if (schema && !text.trim()) throw new Error('Claude returned an empty answer — try again or rephrase the request.');
  return { text, usage: json.usage };
}

// Structured outputs require additionalProperties:false, so tables travel as columns + row arrays.
const TABLE_SCHEMA = {
  type: 'object',
  properties: {
    columns: { type: 'array', items: { type: 'string' } },
    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
  },
  required: ['columns', 'rows'],
  additionalProperties: false,
};

// 1) Extract a table from page text, guided by a plain-English request.
export async function aiExtract({ apiKey, model, goal, page, signal }) {
  const { text, usage } = await callClaude({
    apiKey, model, signal,
    system: `You extract structured data from web page text for a web scraping tool.
Return every item that matches the user's request, as a table: pick short, consistent column names, then one row per item with values in the same order as the columns.
Copy values exactly as they appear on the page; use an empty string when a value is missing. Do not invent data. If nothing matches, return no rows.`,
    content: `Page title: ${page.title}\nPage URL: ${page.url}\n\n<page_text>\n${page.text}\n</page_text>\n\nWhat to extract: ${goal}`,
    schema: TABLE_SCHEMA,
  });
  const { columns, rows } = JSON.parse(text);
  return { rows: rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? '']))), usage };
}

// 2) Add a column: run an instruction over every row (classify, summarise, extract, translate…).
export async function aiColumn({ apiKey, model, instruction, rows, columns, signal, onProgress }) {
  const out = new Array(rows.length).fill('');
  let tokens = 0;
  for (let start = 0; start < rows.length; start += ROWS_PER_BATCH) {
    if (signal?.aborted) break;
    const batch = rows.slice(start, start + ROWS_PER_BATCH).map((r, i) => ({ row: start + i, ...Object.fromEntries(columns.map((c) => [c, String(r[c] ?? '').slice(0, 2000)])) }));
    const { text, usage } = await callClaude({
      apiKey, model, signal, effort: 'low',
      system: `You fill in one new spreadsheet column. For each input row, apply the user's instruction using only that row's data and return a short value (no explanations). Return exactly one result per input row, using the same "row" numbers.`,
      content: `Instruction: ${instruction}\n\nRows (JSON):\n${JSON.stringify(batch)}`,
      schema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: { type: 'object', properties: { row: { type: 'integer' }, value: { type: 'string' } }, required: ['row', 'value'], additionalProperties: false },
          },
        },
        required: ['results'],
        additionalProperties: false,
      },
    });
    for (const r of JSON.parse(text).results) if (r.row >= 0 && r.row < out.length) out[r.row] = r.value;
    tokens += (usage?.input_tokens || 0) + (usage?.output_tokens || 0);
    onProgress?.(Math.min(start + ROWS_PER_BATCH, rows.length), rows.length);
  }
  return { values: out, tokens };
}

// 3) Ask a question about the scraped data; returns plain text (markdown).
export async function aiAsk({ apiKey, model, question, rows, columns, signal }) {
  const tsv = [columns.join('\t'), ...rows.slice(0, 2000).map((r) => columns.map((c) => String(r[c] ?? '').replace(/\s+/g, ' ').slice(0, 300)).join('\t'))].join('\n');
  const { text, usage } = await callClaude({
    apiKey, model, signal, maxTokens: 8000,
    system: 'You analyse scraped data for the user. Answer concisely and concretely, citing values from the data. Use short markdown (bullets, small tables) when helpful. If the data cannot answer the question, say so.',
    content: `Data (${rows.length} rows${rows.length > 2000 ? ', first 2000 shown' : ''}, tab-separated):\n${tsv}\n\nQuestion: ${question}`,
  });
  return { answer: text, usage };
}

// 4) Enrichment presets: several new columns per row in one pass (lead scoring, firmographics,
// sentiment…). Values come from the row's own text plus Claude's general knowledge of well-known
// companies; unknown values are left empty rather than guessed.
export const ENRICH_PRESETS = {
  lead: {
    label: 'Lead score & firmographics',
    hint: 'Industry, company size, B2B/B2C, a 0–100 lead score and why — great after Google Maps, directories or email finder runs.',
    ask: { name: 'icp', label: 'Your ideal customer (used for the lead score)', placeholder: 'e.g. B2B SaaS companies with 10–200 employees in the US that sell to marketers' },
    fields: {
      industry: 'Industry, 1–3 words',
      company_size: 'Employee range: 1-10, 11-50, 51-200, 201-1000, 1000+ or empty if unknown',
      business_type: 'B2B, B2C or both',
      lead_score: 'Integer 0-100: fit with the ideal customer described in the instruction',
      score_reason: 'Why that score, max 12 words',
    },
  },
  summary: {
    label: 'One-line summary & category',
    hint: 'A 12-word summary and a short category for each row.',
    fields: { summary: 'What this row is about, max 12 words', category: 'A short category, 1–3 words' },
  },
  sentiment: {
    label: 'Sentiment & topic (reviews, comments, posts)',
    hint: 'Positive/neutral/negative, a 1–5 score and the main topic.',
    fields: { sentiment: 'positive, neutral or negative', sentiment_score: 'Integer 1 (very negative) to 5 (very positive)', topic: 'Main topic, 1–4 words' },
  },
  contact: {
    label: 'Split names & roles',
    hint: 'First name, last name and job role from names, titles or emails.',
    fields: { first_name: 'First name or empty', last_name: 'Last name or empty', role: 'Job role / title or empty', seniority: 'owner, executive, manager, individual or empty' },
  },
  translate: {
    label: 'Translate text',
    hint: 'Adds a translated copy of the main text.',
    ask: { name: 'lang', label: 'Translate into', placeholder: 'English' },
    fields: { translation: 'The row\'s main text translated into the requested language' },
  },
};

export async function aiEnrich({ apiKey, model, preset, extra = '', rows, columns, signal, onProgress }) {
  const p = ENRICH_PRESETS[preset];
  if (!p) throw new Error(`Unknown enrichment "${preset}"`);
  const names = Object.keys(p.fields);
  const out = rows.map(() => Object.fromEntries(names.map((n) => [n, ''])));
  let tokens = 0;
  for (let start = 0; start < rows.length; start += ROWS_PER_BATCH) {
    if (signal?.aborted) break;
    const batch = rows.slice(start, start + ROWS_PER_BATCH).map((r, i) => ({ row: start + i, ...Object.fromEntries(columns.map((c) => [c, String(r[c] ?? '').slice(0, 1500)])) }));
    const { text, usage } = await callClaude({
      apiKey, model, signal, effort: 'low',
      system: 'You enrich spreadsheet rows with new columns. Use the row\'s data and well-established public knowledge only; if a value is not clear, return an empty string — never invent. Keep values short. Return exactly one result per input row with the same "row" numbers.',
      content: `New columns:\n${names.map((n) => `- ${n}: ${p.fields[n]}`).join('\n')}${extra ? `\n\nContext from the user: ${extra}` : ''}\n\nRows (JSON):\n${JSON.stringify(batch)}`,
      schema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: { type: 'object', properties: { row: { type: 'integer' }, ...Object.fromEntries(names.map((n) => [n, { type: 'string' }])) }, required: ['row', ...names], additionalProperties: false },
          },
        },
        required: ['results'],
        additionalProperties: false,
      },
    });
    for (const r of JSON.parse(text).results) if (r.row >= 0 && r.row < out.length) for (const n of names) out[r.row][n] = r[n] ?? '';
    tokens += (usage?.input_tokens || 0) + (usage?.output_tokens || 0);
    onProgress?.(Math.min(start + ROWS_PER_BATCH, rows.length), rows.length);
  }
  return { values: out, columns: names, tokens };
}
