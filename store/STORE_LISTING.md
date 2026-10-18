# Chrome Web Store listing: PullRows 1.3.1

Upload `dist/pullrows-1.3.1.zip`, which you build with `npm run package`. Images are in `store/`.

## Store listing tab

**Name** (from manifest): PullRows – Web Scraper & Data Extractor

**Summary** (132 chars max, from manifest):
Turn any website into rows: lists, pages, emails, socials, images, Shopify, sitemaps. Export CSV/Excel. Works with Claude.

**Category:** Tools. **Language:** English.

**Description**
```
PullRows turns any website into a clean table, right from Chrome's side panel. No code, no account.

CLICK ONE ITEM, GET THE WHOLE LIST
Open a page with a list: search results, a directory, a shop category, a map, a job board. Press "Auto-detect list" or click one item. Every similar item becomes a row, with readable column names.
• Next buttons, "Load more" buttons and infinite scroll, including scrolling panels
• Scrolls one screen at a time, so lazy-loaded and virtualised items are captured
• Merges half-loaded rows and skips duplicates
• Tables, div grids, two-row lists (forums, Hacker News) and single-page apps; column names from table headers
• Finds "Next" and "Load more" in 35+ languages
• Built-in presets for map results, job listings, social posts and reels, X and Reddit feeds, video lists and product search

ELEVEN TOOLS IN ONE PANEL
• List Extractor: lists, grids and tables, with pagination
• Page Extractor: the same fields from hundreds of URLs, one row per page
• Email Extractor: crawls contact/about pages and decodes protected addresses
• Social Link Extractor: LinkedIn, X, Instagram, Facebook, YouTube, TikTok and GitHub profiles
• Image Downloader: full-size, lazy-loaded and background images, filtered by size
• Shopify Extractor: a store's whole catalogue, with variants, prices and stock
• Sitemap Explorer: every URL of a site, grouped and filterable
• Page Text: clean article text and Markdown
• Quick Scan: emails, phones, links, tables and prices on the current page
• Trend Finder: the best Reels, TikToks, YouTube Shorts, X posts and Reddit threads for any topic, #hashtag or subreddit, ranked, with views, likes, shares, hashtags, sound, length, the spoken script (Pro) and the patterns the winners share
• AI Extract: describe what you want in plain English (uses your own Anthropic API key)

AN EDITABLE DATA TABLE
Rename, sort, edit, merge columns, dedupe and clean. You can also add an AI column ("classify the industry") or ask questions about the data. Export to CSV or copy to any spreadsheet; Excel and JSON export are part of Pro. Save any setup as a recipe and re-run it in one click.

WORKS WITH CLAUDE
Turn on the Claude connector and add your private link to Claude as a custom connector. You can then ask Claude to "find every café in Pune with a rating above 4.5 and export it". Claude runs PullRows in your own browser, with your logins, and the results land in your Data Table. The connector is off by default and read-only unless you allow actions. Email, banking, password-manager and local-network sites are always blocked.

PRIVATE BY DESIGN
Your scraped data stays in your browser. PullRows has no analytics and no tracking, and needs no account.

FREE FOREVER, PRO WHEN YOU NEED MORE
The free plan includes every tool and unlimited CSV export, with sensible per-run limits. Try Pro free for 3 days, no card needed. Pro (from $9/month, or $59/year) removes all limits and adds Excel and JSON export, unlimited recipes and unlimited Claude connector calls.

Use PullRows responsibly: respect each website's terms and privacy laws when collecting data.
```

**Images**
- Store icon: `icons/icon128.png` (96×96 artwork with 16px transparent padding)
- Screenshots (1280×800): `store/screenshot-1-home.png` … `screenshot-5-pro.png`
- Small promo tile (440×280): `store/promo-small-440x280.png`
- Marquee (1400×560): `store/promo-marquee-1400x560.png`

**Additional fields**
- Official URL / homepage: https://pullrows.vercel.app (switch to https://pullrows.com once the domain is bought)
- Support URL: https://pullrows.vercel.app/docs
- Mature content: No

## Privacy practices tab

**Single purpose**
> Extract structured data from web pages the user chooses (manually, or through the user's own AI assistant) into a table the user can edit and export.

**Permission justifications**

| Permission | Justification |
|---|---|
| `<all_urls>` host access | The user scrapes pages on any site they choose. The engine is injected into the page the user is on, and multi-URL tools fetch the list of pages the user pasted (for example, contact pages of companies) in the background. |
| `scripting` | Injects the bundled extraction engine (`content/engine.js`) into the tab the user is scraping. No remote code is ever injected. |
| `storage` | Saves the user's settings, Data Table, recent results (history) and saved recipes locally. |
| `unlimitedStorage` | A scraped dataset or the history of results can exceed the default local storage quota. It is stored only on the user's device. |
| `sidePanel` | The whole user interface lives in Chrome's side panel. |
| `downloads` | Saves images the user selects in the Image Downloader (and exported files) into a Downloads subfolder. |
| `offscreen` | Parses pages fetched in the background with DOMParser for scraping jobs the user starts from their own Claude assistant (Claude connector, off by default). The same document keeps the connector's connection to our relay open while the user has the connector turned on. |

**Remote code:** No. All JavaScript is in the package. The relay server only sends data (a tool name and JSON arguments), which map to bundled functions.

**Data usage disclosures:** check these:
- **Website content.** Pages the user scrapes. This data is processed locally. It is sent to Anthropic only when the user uses AI features (with their own key), and, when the user turns on the Claude connector, the results Claude asks for pass through our relay server (not stored) to the user's Claude session.
- **Personal communications.** Only if the user asks their Claude assistant to read a messaging page that isn't blocked; webmail is blocked by default.
- **Web history.** When the Claude connector is on, the titles and URLs of open tabs are shared with the user's Claude session (`browser_tabs`).
- **Personally identifiable information.** Email addresses and phone numbers that the user chooses to extract from websites.
- **Authentication information.** The user's own Anthropic API key, stored locally and sent only to api.anthropic.com. The licence key is sent to the licence server.

Certify all three: not sold to third parties; not used for unrelated purposes; not used for creditworthiness or lending.

**Privacy policy URL:** https://pullrows.vercel.app/privacy

## Payments
The listing says the extension has in-app purchases (Pro). Payment happens on the website through Dodo Payments; nothing is purchased inside Chrome Web Store.

## Test instructions for the reviewer
```
1. Open any page with a list, e.g. https://books.toscrape.com/ .
2. Click the PullRows toolbar icon to open the side panel → "Auto-detect list" → "Extract list".
   20 books appear in the Data Table; export with "CSV".
3. Pagination: in List Extractor choose "Click 'Next' page" (auto-detected) and extract again → 200 rows (free plan stops at 10 pages).
4. Email Extractor: paste "https://www.python.org" → Find emails.
5. The Claude connector (Settings) is optional and off by default; it requires the user's own Claude account.
6. Pro features can be tested with this licence key: <PASTE A TEST KEY FROM DODO TEST MODE>.
```

## Edge Add-ons
Upload the same zip at https://partner.microsoft.com/dashboard/microsoftedge. Reuse the same texts, privacy URL and images. Edge also wants a 300×300 logo; render it from `brand/logo.svg`.
