# PullRows

**Pull any website into rows.** PullRows is a no-code web scraper that lives in Chrome's side panel. It has ten point-and-click tools that write into one editable Data Table, and Claude can drive it through MCP. Plain JavaScript, Manifest V3, no build step.

- Website: `website/` (static, deployed to Vercel)
- Store listing, images and permission justifications: `store/`
- Brand: `brand/`
- Launch checklist: [`LAUNCH.md`](LAUNCH.md)

## Tools

| Tool | What it does |
|---|---|
| **List Extractor** | Click one item of any list, grid or table, or press *Auto-detect*. Every similar item becomes a row, and the columns get readable names. **Site presets** cover map results, job listings, Instagram posts and Reels, YouTube and Amazon. It scrolls one screen at a time, merges half-loaded rows, and paginates through **Next**, **Load more** or **infinite scroll** (including scrolling panels). |
| **Page Extractor** | Define fields once (by clicking, or with built-ins and presets) and extract them from a list of URLs, one row per page. *Fast* mode fetches pages in the background; *Browser* mode renders each one in a tab. |
| **Email Extractor** | Finds emails across many sites. A deep scan follows contact, about and team pages, and decodes protected or obfuscated addresses. |
| **Social Link Extractor** | Finds LinkedIn, X, Instagram, Facebook, YouTube, TikTok and GitHub profiles, giving one row per site. |
| **Image Downloader** | Collects `srcset` originals, lazy-loaded and CSS-background images. Filter, pick, then download to `Downloads/pullrows/<site>/`. |
| **Shopify Extractor** | Exports a whole catalogue or one collection. Output can be one row per variant, one per product, or the Shopify import CSV. |
| **Sitemap Explorer** | Reads robots.txt, sitemap indexes and `.gz` files. Groups URLs by section, filters them, and can send them to other tools. |
| **Page Text Extractor** | Clean main-content text and Markdown. |
| **Quick Scan** | Emails, phones, links, images, tables, socials and prices on the current page. |
| **AI Extract** | Describe what you want; Claude, using the user's own API key, returns a table. |

**Data Table:** sheets, search, editing, rename, sort, dedupe, clean, merge, an AI column and Ask Claude. Export to CSV or the clipboard (free), or to Excel and JSON (Pro). **Recipes** re-run any setup in one click. **History** keeps the last 30 results.

## Plans and licensing

| | Free | Pro |
|---|---|---|
| Every tool, CSV and copy export, AI features with your own key | ✓ | ✓ |
| List pagination per run | 10 pages, 60 scrolls | unlimited |
| URLs per run (Page Extractor, emails/socials, text) | 25 | unlimited |
| Images, Shopify products, sitemap URLs | 100 / 100 / 1,000 | unlimited |
| Excel and JSON export | | ✓ |
| Saved recipes | 3 | unlimited |
| Claude connector calls per day | 25 | unlimited |

Limits are defined in `lib/license.js` (`FREE_LIMITS`). Pro licence keys are sold through **Dodo Payments** (merchant of record). The extension activates a key once per browser, up to 3 browsers, and re-validates it daily. If the licence server can't be reached, Pro keeps working for 14 days (`activate`/`validate`/`deactivate` in `lib/license.js`). Checkout links, the site URL and the relay URL are all in `lib/config.js`.

## Claude connector (MCP)

```
Claude ──MCP (HTTPS)──▶ relay ◀──long-poll── PullRows in your Chrome
        /mcp/<id>                /bridge/<secret>
```

Claude's cloud can't reach your browser, so a small **relay** (`server/`, zero dependencies) passes tool calls and results through. It stores nothing.
- **The link contains only a hash of the browser's secret.** `id = base64url(sha256(secret))[:32]`. Someone who has the link can call tools, but cannot impersonate the browser.
- **Consent.** Turning the connector on shows a disclosure that the user must accept. It is off by default.
- **Read-only by default.** Clicking, typing and downloads need *Allow actions* and *Allow downloads*.
- **Blocked sites.** Email, accounts, payments and password managers are blocked (an editable list). Banking or wallet hosts and local-network addresses are always blocked (`lib/guard.js`).
- **Visibility and limits.** A toolbar badge shows while Claude is working, and every call is logged in Settings. At most 2 commands run in parallel. Calls are capped per plan.
- **Relay hardening.** Origin checks, rate limits, body limits, fast offline detection, and cancellation of abandoned calls. OAuth is hardened: `PUBLIC_URL`, exact redirect URIs, single-use codes, signed refresh tokens.

**Use it:** Settings → *Claude connector* → turn on → **Copy** the private link → in Claude go to Settings → Connectors → *Add custom connector*. For Claude Code: `claude mcp add --transport http pullrows <link>`.

**Deploy your own relay:** Render Blueprint (`render.yaml`), or `docker build -t pullrows-relay . && docker run -p 8787:8787 pullrows-relay`. Set `PUBLIC_URL`, `OAUTH_SECRET` and `TRUST_PROXY=1` behind a proxy.

## Development

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. Pin PullRows and click the icon to open the side panel.

```bash
NODE_PATH=$(npm root -g) npm test        # relay, oauth, e2e, mcp, realistic, patterns (headless Chromium)
NODE_PATH=$(npm root -g) node test/e2e.mjs "list"   # steps matching a pattern
npm run package                          # → dist/pullrows-<version>.zip (allow-listed files only)
NODE_PATH=$(npm root -g) node scripts/store-assets.mjs   # → store/*.png screenshots + promo tiles
```

```
manifest.json, background.js   service worker: side panel, bridge lifecycle, guarded browser ops
content/engine.js              scraping engine: injected into tabs, and also loaded in extension pages for DOMParser docs
lib/                           tab, net, crawl, shopify, sitemap, ai, export, list-runner, storage,
                               license (plans), guard (connector safety), config, mcp-exec
offscreen/                     Claude bridge (long-poll, 2 parallel commands, cancellation)
sidepanel/                     app shell, icons, plan, tools/*, views/* (table, recipes, history, settings, upgrade)
onboarding/                    welcome page opened on install
server/                        MCP relay + OAuth (Node, zero deps)
website/                       marketing site (static)
store/                         listing text, screenshots, promo tiles, demo site used for screenshots
scripts/                       package + store-asset builders
test/                          Playwright suites + fixture sites + fake Shopify / licence APIs
```

## Roadmap
- Background jobs for very long scrapes (avoids Claude's per-call timeout)
- Nested scraping (list → open each item → page fields) as one recipe
- Scheduled recipe runs and change alerts
- Firefox build
