# PullRows 1.0.1: Chrome Web Store form, field by field

Dashboard: https://chrome.google.com/webstore/devconsole → **New item** → upload `pullrows-1.0.1.zip`.
Every image named below is in this kit's `images/` folder.

---

## 1. Package
| Field | Value |
|---|---|
| Upload | `pullrows-1.0.1.zip` |

## 2. Store listing
| Field | Paste this |
|---|---|
| Title | *(read from the manifest)* PullRows – Web Scraper & Data Extractor |
| Summary | *(read from the manifest)* Turn any website into rows: lists, pages, emails, socials, images, Shopify, sitemaps. Export CSV/Excel. Works with Claude. |
| Category | **Tools** |
| Language | **English** |
| Store icon | `images/icon-128.png` |
| Screenshots (in this order) | `images/screenshot-1-home.png`, `images/screenshot-2-detect.png`, `images/screenshot-3-table.png`, `images/screenshot-4-claude.png`, `images/screenshot-5-pro.png` |
| Small promo tile (440×280) | `images/promo-small-440x280.png` |
| Marquee promo tile (1400×560) | `images/promo-marquee-1400x560.png` |
| Promo video | *(leave empty)* |
| Official URL | https://pullrows.vercel.app |
| Homepage URL | https://pullrows.vercel.app |
| Support URL | https://pullrows.vercel.app/docs |
| Mature content | **No** |

**Description**: paste everything between the lines:

---
PullRows turns any website into a clean table, right from Chrome's side panel. No code, no account.

CLICK ONE ITEM, GET THE WHOLE LIST
Open a page with a list: search results, a directory, a shop category, a map, a job board. Press "Auto-detect list" or click one item. Every similar item becomes a row, with readable column names.
• Next buttons, "Load more" buttons and infinite scroll, including scrolling panels
• Scrolls one screen at a time, so lazy-loaded and virtualised items are captured
• Merges half-loaded rows and skips duplicates
• Tables, div grids, two-row lists (forums, Hacker News) and single-page apps; column names from table headers
• Finds "Next" and "Load more" in 35+ languages
• Built-in presets for map results, job listings, social posts and reels, video lists and product search

TEN TOOLS IN ONE PANEL
• List Extractor: lists, grids and tables, with pagination
• Page Extractor: the same fields from hundreds of URLs, one row per page
• Email Extractor: crawls contact and about pages, and decodes protected addresses
• Social Link Extractor: LinkedIn, X, Instagram, Facebook, YouTube, TikTok and GitHub profiles
• Image Downloader: full-size, lazy-loaded and background images, filtered by size
• Shopify Extractor: a store's whole catalogue, with variants, prices and stock
• Sitemap Explorer: every URL of a site, grouped and filterable
• Page Text: clean article text and Markdown
• Quick Scan: emails, phones, links, tables and prices on the current page
• AI Extract: describe what you want in plain English (uses your own Anthropic API key)

AN EDITABLE DATA TABLE
Rename, sort, edit, merge columns, dedupe and clean. You can add an AI column ("classify the industry") or ask questions about the data. Export to CSV or copy to any spreadsheet; Excel and JSON export are part of Pro. Save any setup as a recipe and re-run it in one click.

WORKS WITH CLAUDE
Turn on the Claude connector and add your private link to Claude as a custom connector. Then ask: "find every café in Pune rated above 4.5 and export it." Claude runs PullRows in your own browser, with your logins, and the results land in your Data Table.
The connector is off by default and read-only unless you allow actions. Email, banking, password-manager and local-network sites are always blocked.

PRIVATE BY DESIGN
Your scraped data stays in your browser. No analytics, no tracking, no account.

FREE FOREVER, PRO WHEN YOU NEED MORE
The free plan includes every tool and unlimited CSV export, with sensible per-run limits. You can try Pro free for 3 days, with no card needed. Pro ($9/month or $59/year) removes all limits and adds Excel and JSON export, unlimited recipes and unlimited Claude connector calls.

Use PullRows responsibly: respect each website's terms and privacy laws when collecting data.
---

## 3. Privacy practices
**Single purpose description**
```
Extract structured data from web pages the user chooses (manually, or through the user's own AI assistant) into a table the user can edit and export.
```

**Permission justifications** (one box per permission):

| Permission | Paste this |
|---|---|
| Host permission (`<all_urls>`) | The user scrapes pages on any website they choose. The bundled extraction engine is injected into the page the user is on, and the multi-URL tools (Page Extractor, Email and Social finders, Sitemap Explorer) fetch the list of pages the user entered. |
| scripting | Injects the extension's own bundled extraction script (content/engine.js) into the tab the user is scraping. No remote code is ever injected. |
| storage | Saves the user's settings, current Data Table, recent results (history) and saved recipes locally on the device. |
| unlimitedStorage | A scraped dataset or the history of results can exceed the default local storage quota. Data never leaves the device. |
| sidePanel | The whole user interface is a Chrome side panel next to the page being scraped. |
| downloads | Saves images the user selects in the Image Downloader, and exported CSV, Excel or JSON files, into the Downloads folder. |
| offscreen | Uses DOMParser in an offscreen document to parse pages fetched in the background for scraping jobs the user starts from their Claude assistant. |

**Are you using remote code?** → **No, I am not using remote code.**
*(If a reason box appears: "All JavaScript is bundled in the package. The optional relay server sends only data (a tool name plus JSON arguments) that call bundled functions.")*

**Data usage**: tick these:
- ☑ Personally identifiable information *(emails and phone numbers the user chooses to extract from websites)*
- ☑ Authentication information *(the user's own Anthropic API key, stored locally and sent only to Anthropic; the Pro licence key, sent to the licence server)*
- ☑ Web history *(when the user enables the Claude connector, open-tab titles and URLs are shared with the user's own Claude session)*
- ☑ Website content *(pages the user scrapes)*
- ☐ Health info, ☐ Financial and payment info, ☐ Personal communications, ☐ Location, ☐ User activity: leave unticked

**Certify all three:**
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://pullrows.vercel.app/privacy

## 4. Distribution
| Field | Value |
|---|---|
| Payments | **Contains in-app purchases** *(Pro is sold on our website; nothing is bought through the Web Store)* |
| Visibility | **Public** |
| Regions | **All regions** |

## 5. Test instructions (for the reviewer)
```
No account is needed.
1. Open https://books.toscrape.com/ and click the PullRows toolbar icon to open the side panel.
2. Press "Auto-detect list", then "Extract list". 20 books appear in the Data Table. Click "CSV" to export.
3. Pagination: in List Extractor choose "Click 'Next' page" (it is auto-detected) and extract again.
   The free plan stops at 10 pages (200 rows).
4. Email Extractor: paste https://www.python.org and press "Find emails".
5. Pro features: click the "Free" badge (top right), then "Try Pro free for 3 days". All limits are removed,
   and Excel/JSON export become available. No payment or key is needed.
6. The Claude connector (Settings) is optional and off by default. It requires the user's own Claude account.
```

---

## Microsoft Edge Add-ons (optional, free)
https://partner.microsoft.com/dashboard/microsoftedge → New extension → same zip, same description and privacy URL.
Logo: `images/logo-300x300.png`. Screenshots and tiles: the same files.
