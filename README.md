# Web Scraper Extension

A Chrome (Manifest V3) extension for pulling structured data out of any web page — no code, no build step.

## Features

- **9 one-click extractors:** emails, phone numbers, links (internal / external), images (incl. lazy-loaded, CSS backgrounds, og:image), HTML tables, page text, social profiles, prices (with currency + surrounding context), pagination.
- **Point-and-click picker:** click one item on the page (a product title, a name, a row) and the extension builds a CSS selector that matches every similar item. Each match returns its text plus the link and image from its card.
- **Multi-page scraping:** follows "Next" links automatically (up to 100 pages), with a configurable delay, merges and de-duplicates the results, and tags each row with its `page_url`.
- **Infinite scroll:** optionally scrolls to the bottom first so lazy content is loaded.
- **AI extraction (Claude):** describe what you want ("every product with name, price, rating") and get a clean table back. Uses your own Anthropic API key, stored only in your browser.
- **Export:** CSV and clipboard (current tab), Excel `.xlsx` (one sheet per data type), JSON, Google Sheets.
- **History:** the last 20 scrapes are saved locally and can be reopened and re-exported.

## Install (development)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension and click its icon — the side panel opens.

After editing code, click the reload icon on the extension card (and reload the page you're scraping).

## Project layout

```
manifest.json            MV3 manifest
background.js            Service worker: opens the side panel on icon click
content/scraper.js       Injected into the page on demand: extractors, picker, auto-scroll, next-page detection
sidepanel/               UI (HTML/CSS/JS, plain ES modules)
lib/tab.js               Inject + call the scraper in a tab, navigate for multi-page runs
lib/export.js            CSV / TSV / JSON / dependency-free XLSX writer, downloads
lib/ai.js                Claude Messages API call (structured JSON output)
lib/sheets.js            Google Sheets export via chrome.identity
lib/storage.js           Settings + history in chrome.storage.local
test/                    End-to-end test (Playwright) + fixture pages
```

How it works: the side panel injects `content/scraper.js` into the active tab with `chrome.scripting.executeScript` only when you scrape, so it works on tabs that were already open and runs nothing on pages you don't scrape.

## Configuration

### Claude AI extraction
Settings → paste an Anthropic API key (from console.anthropic.com) → pick a model (Opus 5.5 default, Sonnet 5.5, Haiku 5.5). The page's visible text (up to 150k characters) is sent to the Anthropic API along with your request.

> Calling the API straight from the browser with a user-supplied key is fine for personal/internal use. If you publish this for other people, route requests through your own backend instead so no key lives in the extension.

### Google Sheets
1. In Google Cloud Console create a project, enable the **Google Sheets API**.
2. Create an **OAuth client ID** of type *Chrome extension*, using your extension's ID (shown on `chrome://extensions`).
3. Put the client ID in `manifest.json` → `oauth2.client_id`.

The extension only requests the `drive.file` scope (it can only touch spreadsheets it creates). CSV, Excel and JSON export work without this.

## Testing

Requires Node 18+ and Playwright with Chromium.

```bash
NODE_PATH=$(npm root -g) node test/e2e.mjs
```

The test loads the unpacked extension in headless Chromium, serves `test/fixtures/`, and drives the real side panel: picker, every extractor, multi-page following, all exports, history, and AI extraction against a mocked API response.

## Roadmap ideas

- Multiple named fields per item (e.g. title + price + rating from the same card) as a "recipe".
- Saved recipes per site, scheduled re-scrapes.
- Click-to-load "Load more" buttons.
- Firefox build.

## Credits

The feature set was modelled after the open-source [reallydeep/ultimate-web-scraper](https://github.com/reallydeep/ultimate-web-scraper) (MIT); this codebase was written independently.
