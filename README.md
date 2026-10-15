# Web Scraper Extension

A no-code Chrome (Manifest V3) scraper that lives in the side panel: ten point-and-click tools that all write into one editable Data Table, with Claude AI built in. Plain JavaScript, no build step.

## Tools

| Tool | What it does |
|---|---|
| **List Extractor** | Click one item of any list, grid or table (or press *Auto-detect*) and every similar item becomes a row, with columns generated automatically. Cycle through alternative lists with *Try another*, untick/rename columns. Pagination: click a **Next** button/link, click **Load more**, or **infinite scroll** (including scrollable panels such as Google Maps' results feed). |
| **Page Extractor** | Define fields once (click elements on a sample page, or add built-ins/presets: page metadata, contacts, product price, **Google Maps place**) and extract them from a list of URLs — one row per page. *Fast* mode fetches HTML in the background; *Browser* mode renders each page in a background tab. |
| **Email Extractor** | Emails from many sites. Deep scan follows links to contact/about/team/impressum pages. Decodes Cloudflare-protected and "name (at) domain (dot) com" addresses, filters junk, optional domain filter and phone numbers. |
| **Social Link Extractor** | LinkedIn, X, Instagram, Facebook, YouTube, TikTok, GitHub… profiles for a list of sites; one row per site with a column per platform. Ignores share buttons. |
| **Image Downloader** | Every image on a page — `srcset` originals, lazy-loaded, CSS backgrounds, og:image. Filter by size/type, pick in a thumbnail grid, download into `Downloads/web-scraper/<site>/` with readable file names. Also downloads an image-URL column from the Data Table. |
| **Shopify Extractor** | A Shopify store's whole catalogue (or one collection) via its public JSON: one row per variant (price, compare-at, SKU, availability), one row per product, or **Shopify import CSV** format. |
| **Sitemap Explorer** | Finds sitemaps (robots.txt + common paths), follows sitemap indexes and `.gz` files, groups URLs by section, filters by text or `/regex/`, and sends the URLs to the Page / Email / Social / Text tools. |
| **Page Text Extractor** | Clean main-content text and Markdown (readability-style) with title, author, date, language and word count; current page or a list of URLs. Copy or save as `.md`. |
| **Quick Scan** | One click on the current page: emails, phones, links, images, tables, text, socials, prices, pagination (+ custom selector), optionally following Next links. One sheet per type. |
| **AI Extract (Claude)** | Describe what you want in plain English; Claude reads the page (or a list of URLs) and returns a table. |

### Data Table
Sheets, search, double-click to edit cells, column menu (rename, sort, move, dedupe by column, delete, send URLs to another tool, download as images), **Dedupe**, **Clean** (trim, drop empty rows and mostly-blank columns), **Merge columns**, delete rows.
**✦ AI column** — Claude fills a new column from each row ("classify the industry", "summarise in 10 words", "extract the city"…).
**✦ Ask Claude** — ask questions about the data and get an answer with numbers from the table.
Export: CSV, Excel (one sheet per tab), JSON, clipboard, Google Sheets.

### Recipes & History
Any tool's setup can be saved as a **recipe** (optionally with a start page) and re-run in one click; export/import recipes as JSON to share them. The last 30 results are kept in **History**.

## Install (development)

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → select this folder.
3. Pin the extension and click its icon — the side panel opens.

After editing code, click the reload icon on the extension card (and reload the page you're scraping).

## Setup

**Claude** — Settings → paste an Anthropic API key (console.anthropic.com) → choose a model (Opus 5.5 default, Sonnet 5.5, Haiku 5.5). Page text or table rows are sent to the Anthropic API only when you use an AI feature.
> Calling the API from the browser with a user-supplied key is fine for personal/internal use. If you distribute this, proxy requests through your own backend instead.

**Google Sheets** (optional) — create a Google Cloud project, enable the Sheets API, create an OAuth client of type *Chrome extension* for your extension ID, and put the client ID in `manifest.json` → `oauth2.client_id`. Only the `drive.file` scope is requested.

## How it works

```
manifest.json
background.js              opens the side panel on icon click
content/engine.js          the scraping engine — injected into tabs on demand AND loaded in the
                           side panel to parse pages fetched in the background
                           · list detection (repeating siblings scored by count × richness × similarity²)
                           · field generation, item/field selectors, pagination actions, picker
                           · quick extractors, readability, contacts, JSON-LD, Maps fields
lib/tab.js                 inject + call the engine in a tab, background tabs, navigation
lib/net.js                 background fetch → DOMParser, worker pool, URL list parsing
lib/crawl.js               email/social crawler (site + contact pages)
lib/shopify.js             /products.json paging + row formats
lib/sitemap.js             sitemap discovery + crawl (.xml, index, .gz)
lib/ai.js                  Claude: AI extract, AI column (batched), Ask Claude — structured outputs
lib/export.js              CSV / TSV / JSON / dependency-free XLSX writer
lib/sheets.js              Google Sheets export
lib/storage.js             settings, history, recipes
sidepanel/                 app shell, tools/*, views/* (table, recipes, history, settings)
test/                      Playwright end-to-end test + fixture sites
```

Pages fetched in Fast mode use your browser's cookies (`credentials: include`), so logged-in pages work like in a normal tab.

## Testing

```bash
NODE_PATH=$(npm root -g) node test/e2e.mjs            # everything
NODE_PATH=$(npm root -g) node test/e2e.mjs "list"     # steps matching a pattern
```

The test loads the unpacked extension in headless Chromium, serves `test/fixtures/` (a JS-paginated catalogue, a load-more list, a Maps-style scrolling feed, product/contact/about pages, sitemaps incl. `.gz`, a fake Shopify store) and drives the real side panel through every tool, the Data Table operations, exports, recipes, history and the Claude features (against a mocked API).

## Ideas / roadmap

- MCP bridge so Claude Desktop / Claude Code can drive the extension directly (run recipes, read the Data Table).
- Scheduled re-runs of recipes, change detection.
- Nested scraping (list → open each item → page fields) as one recipe.
- Firefox build.

## Credits

Feature set modelled on the commercial *Ultimate Web Scraper* extension; list detection ideas inspired by Instant Data Scraper's approach (no code copied). All code in this repository was written independently.
