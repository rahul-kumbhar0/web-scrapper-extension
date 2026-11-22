# PullRows on Reddit: launch posts

Store: https://chromewebstore.google.com/detail/pullrows/lkdikgfkdacljfeedaacgbmeajknoibg
Site: https://pullrows.vercel.app

## Rules that keep the posts up (and the account unbanned)

1. **Say you built it**, in the first lines. Undisclosed self-promotion is the fastest way to get removed.
2. **Read each subreddit's rules first.** Some allow self-promo only on certain days or in a weekly thread (noted below).
3. **One subreddit a day**, from your own account. Never post the same text twice; the versions below are already different.
4. **Answer every comment** for the first few hours. Replies matter more than the post.
5. **Have some normal history** first: a brand-new account that only posts its own link gets filtered. Comment helpfully in these subs for a week.
6. **No upvotes from friends or second accounts.** Reddit detects vote rings and shadow-bans the account and the link.
7. Lead with what it does for the reader; the link goes at the end.

## Channel plan (researched Nov 2026; check each sidebar before posting, rules change)

| Day | Where | Self-promo rule | Image | Post |
|---|---|---|---|---|
| 1 | r/SideProject | Allowed; it's what the sub is for | `reddit-sideproject.png` | Short post below |
| 2 | r/chrome_extensions | Allowed, links OK; needs substance | `reddit-chrome-extensions.png` | Section 2 |
| 3 | r/ClaudeAI | Unclear; check sidebar and flair list, ask mods if unsure | `reddit-claude.png` | Section 3 |
| 4 | r/indiehackers | One post per product, "Self Promotion" flair, framed as a feedback request | `reddit-sideproject.png` | Ask for feedback on pricing / first users |
| 5 | r/IMadeThis | Allowed; explain how you built it | `reddit-chrome-extensions.png` | Build story |
| 6 | r/socialmedia or r/InstagramMarketing | Unknown; read rules, many use a weekly thread | `reddit-trends.png` | Section 4 |
| 7 | r/webscraping | Only in the monthly self-promotion thread (ask mods first) | none, text only | Section 6 |
| later | r/GrowthHacking | Stories only, no pitching, needs 100+ karma in the sub | none | A growth-experiment story once you have install numbers |

**Skip:** r/leadgeneration (bans self-promotion outright, permanent-ban risk), r/InternetIsBeautiful (bans extensions/downloads), r/SaaS (launches only in weekly threads), r/chrome (needs mod approval; message mods first if you want to try).

### Short r/SideProject post (use this one)

**Title:** I built a free Chrome extension that turns any website into a spreadsheet

I'm the developer. I got tired of copy-pasting lists into Google Sheets, so I built PullRows.

Click "Auto-detect" on any page (shop, Google Maps, job board) and every item becomes a row, across all pages. It can also search any site for you, find emails, and alert you when prices drop.

Free, no account, data stays in your browser.

What site should I test it on? Tell me where it breaks.

https://chromewebstore.google.com/detail/pullrows/lkdikgfkdacljfeedaacgbmeajknoibg

---|---|---|---|
| 1 | r/SideProject | Launch story | Self-promo welcome |
| 2 | r/chrome_extensions | What it does | Self-promo welcome |
| 3 | r/ClaudeAI | Claude connector (MCP) | Check the flair for "Built with Claude" / showcase |
| 4 | r/InstagramMarketing or r/socialmedia | Trend Finder | Check rules; some only allow tools in a weekly thread |
| 5 | r/coldemail or r/leadgeneration | Google Maps leads + emails | Check rules; often weekly promo thread only |
| 6 | r/webscraping | Technical write-up | Strict: no product promo outside their monthly self-promotion thread. Post there, or write about the technique without the link |
| 7 | r/InternetIsBeautiful | Only if the reader can use it in a browser without installing | Usually not a fit for extensions; skip unless the rules allow |

---

## 1. r/SideProject

**Title:** I built a free Chrome extension that turns any website into a spreadsheet (and Claude can drive it)

**Body:**

Hi all, I'm the developer. I kept copy-pasting lists from websites into Google Sheets for lead research, so I built PullRows.

What it does:
- Open any page with a list (shop, directory, Google Maps, job board), click **Auto-detect**, and every item becomes a row. It follows Next / Load more / infinite scroll.
- Finds emails and social links across a list of websites.
- **Search any site**: type a site and a query ("standing desk" on amazon.in), it finds the search page and pulls the results.
- **Monitors**: re-runs a saved scrape every hour/day and alerts you on price drops or new listings.
- Trend Finder: top Reels / TikToks / Shorts / Reddit posts for a topic, ranked, with hashtags and sounds.
- Works with Claude as a connector, so you can ask from your phone: "find cafés in Pune above 4.5 stars" and it runs in your own browser.

Everything stays in your browser (no account, no tracking). Free plan covers every tool with per-run limits; Pro is $10/month or $20 once.

Honest feedback very welcome, especially sites where auto-detect picks the wrong list.

Link: https://chromewebstore.google.com/detail/pullrows/lkdikgfkdacljfeedaacgbmeajknoibg

---

## 2. r/chrome_extensions

**Title:** [Release] PullRows – click one item, get the whole list as rows (free, no account)

**Body:**

I made a side-panel scraper for people who don't want to write selectors.

- Auto-detects lists, grids and tables (including two-level table headers and two-row items like Hacker News)
- Pagination: Next buttons, Load more, infinite scroll, also inside scrolling panels like Google Maps
- Editable Data Table: dedupe, clean prices to numbers, merge columns, export CSV (Excel/JSON on Pro)
- Recipes: save a setup and re-run it in one click; Monitors re-run it on a schedule
- Data stays local. Permissions are explained in the listing

Built it myself, would love bug reports. Free to try:
https://chromewebstore.google.com/detail/pullrows/lkdikgfkdacljfeedaacgbmeajknoibg

---

## 3. r/ClaudeAI

**Title:** I built an MCP connector that lets Claude scrape websites in your own Chrome (works from the phone app)

**Body:**

I'm the developer of PullRows, a Chrome extension. It has a Claude connector: you add a private link as a custom connector in Claude, and Claude gets ~25 tools that run inside your own browser, with your logins.

Things I use it for:
- "Search amazon.in for standing desks under ₹15,000 and give me the top 20 by rating" → `site_search`
- "Find the best Reels about AI tools this week and explain why they work" → `trends_find`
- "Watch this product page and tell me when the price drops" → `monitor_create`

Design choices people asked about:
- Pages are read in the background with no tab when the HTML has the data; script-built pages use a hidden tab that closes afterwards, so Claude doesn't take over your screen.
- Each result says how it ran (what was read, which pages were followed).
- Banking, webmail, password managers and local network addresses are blocked; clicking/typing is off unless you allow it.

Free plan includes 25 Claude calls a day. Setup is in Settings → Claude connector:
https://chromewebstore.google.com/detail/pullrows/lkdikgfkdacljfeedaacgbmeajknoibg

Happy to answer questions about how the relay and the MCP side work.

---

## 4. r/InstagramMarketing / r/socialmedia

**Title:** I made a free tool that ranks the top Reels for any topic and shows what the winners have in common

**Body:**

Disclosure: I built this. I was tired of scrolling hashtags to see what's working, so I added a "Trend Finder" to my Chrome extension.

Give it a topic or hashtag and it ranks the posts by growth (views per day) and engagement, then lists:
- hook (first line), caption, hashtags, sound, length, posting time
- the patterns the top 10 share vs the rest (length, hooks, sounds, timing)
- the spoken script for videos that have captions (Pro)

Works on Instagram, TikTok, YouTube Shorts, X and Reddit (you need to be logged in to Instagram/TikTok in your browser). Exports to CSV/Google Sheets.

If that's useful: https://chromewebstore.google.com/detail/pullrows/lkdikgfkdacljfeedaacgbmeajknoibg — feedback on what other metrics you'd want is very welcome.

---

## 5. r/coldemail / r/leadgeneration

**Title:** How I build local lead lists from Google Maps without paying for a data tool

**Body (lead with the method, tool second):**

The workflow that works for me:
1. Google Maps search ("dentists in Austin"), scroll the results panel to load everything.
2. Pull name, rating, reviews, category, phone, website into a sheet.
3. Visit each website's contact/about pages for emails and LinkedIn/Instagram.
4. Score leads (rating × reviews, has website, has email) and drop chains.

I built a Chrome extension to do steps 2–4 (disclosure: it's mine): PullRows. Maps preset + "Emails from websites" + an optional AI lead score column. Free plan does 25 sites per run.
https://chromewebstore.google.com/detail/pullrows/lkdikgfkdacljfeedaacgbmeajknoibg

Please respect CAN-SPAM/GDPR and the sites' terms when you email people.

---

## 6. r/webscraping (monthly self-promotion thread only)

**Comment for the self-promo thread:**

PullRows (I'm the dev) – free Chrome side-panel scraper. List auto-detection without selectors, pagination incl. scrolling containers (Maps), merge-by-key for virtualised lists (LinkedIn), background fetch+DOMParser first with hidden-tab fallback, Reddit via old.reddit JSON, and an MCP connector for Claude. Feedback on detection failures welcome.
https://chromewebstore.google.com/detail/pullrows/lkdikgfkdacljfeedaacgbmeajknoibg

---

## Replies to common comments

- **"Is this legal?"** – Scraping public pages is generally fine, but respect each site's terms, robots rules and privacy laws (GDPR, CAN-SPAM) for personal data. PullRows keeps a polite delay and blocks sensitive sites.
- **"Why does it need access to all sites?"** – It scrapes whatever page you choose; the extraction script is bundled, nothing remote is injected, and data stays in your browser.
- **"Free vs paid?"** – Every tool is free with per-run limits (10 pages per list run, 25 sites per email run). Pro removes the limits: $10/month or $20 once.
- **"Doesn't work on site X"** – Ask for the URL, try it, and reply with the fix or the workaround (click one item instead of auto-detect).

## Getting real reviews (the allowed way)

- PullRows already asks for a review once, after a few successful runs. Leave that on.
- Ask people who used it from your Reddit threads to leave honest feedback if it helped them.
- Reply to every store review, especially the bad ones, and fix what they report.
