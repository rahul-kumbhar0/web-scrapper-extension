// MCP tool definitions exposed to Claude. Every call is forwarded to the PullRows extension
// running in the user's Chrome, which executes it and sends the result back.

const tabOrUrl = {
  tab_id: { type: 'integer', description: 'Tab to use (from browser_tabs). Default: the active tab.' },
  url: { type: 'string', description: 'Open this URL first (in the tab) before running.' },
};
const returned = { max_rows_returned: { type: 'integer', default: 100, description: 'How many rows to include in the reply (all rows are saved to the PullRows Data Table).' } };

export const TOOLS = [
  {
    name: 'browser_tabs',
    description: 'List the open tabs in the user\'s Chrome (id, title, url, active).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_open',
    description: 'Open a URL in a new tab in the user\'s Chrome (default) or navigate an existing tab_id (with new_tab: false; without a tab_id the active tab is navigated), and wait for it to load. Use before tools that work on "the current page".',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        tab_id: { type: 'integer', description: 'Navigate this existing tab instead of opening a new one.' },
        new_tab: { type: 'boolean', default: true },
        wait_ms: { type: 'integer', default: 1500, description: 'Extra wait after load for JavaScript-rendered content.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Screenshot of the visible part of a tab, to see the page layout before choosing what to extract.',
    inputSchema: { type: 'object', properties: { tab_id: tabOrUrl.tab_id } },
  },
  {
    name: 'page_action',
    description: 'Interact with a page: click an element, scroll to the bottom (loads lazy/infinite content), or type into an input.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: tabOrUrl.tab_id,
        action: { type: 'string', enum: ['click', 'scroll_bottom', 'fill'] },
        selector: { type: 'string', description: 'CSS selector (click / fill).' },
        text: { type: 'string', description: 'Text to type (fill).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'page_read',
    description: 'Read a page as clean Markdown (main content only, like reader mode) plus title and metadata. Uses the open tab (rendered) or fetches the URL.',
    inputSchema: {
      type: 'object',
      properties: {
        ...tabOrUrl,
        max_chars: { type: 'integer', default: 30000 },
        full_text: { type: 'boolean', default: false, description: 'Return all visible text instead of the main content.' },
      },
    },
  },
  {
    name: 'quick_scan',
    description: 'One-click extraction from a page: emails, phones, links, images, tables, text, social profiles, prices, pagination links.',
    inputSchema: {
      type: 'object',
      properties: {
        ...tabOrUrl,
        types: { type: 'array', items: { type: 'string', enum: ['emails', 'phones', 'links', 'images', 'tables', 'text', 'social', 'prices', 'pagination'] }, default: ['emails', 'phones', 'social', 'links'] },
        ...returned,
      },
    },
  },
  {
    name: 'list_detect',
    description: 'Find the repeating lists on a page (products, search results, listings, table rows…). Returns candidates with item selector, item count, auto-generated fields and sample rows, plus detected Next / Load-more buttons. Built-in presets are used automatically for Google Maps results, LinkedIn jobs, Instagram posts, YouTube videos and Amazon search. Use before list_extract.',
    inputSchema: { type: 'object', properties: { ...tabOrUrl } },
  },
  {
    name: 'list_extract',
    description: 'Extract a list from a page into rows. Scrolls through the list one screen at a time (so lazy/virtualised items like LinkedIn job cards and Instagram captions are captured), merges partially-loaded rows, and can continue across pages: click Next, click Load more, or infinite scroll (also inside panels like the Google Maps results feed). Without item_selector, the site preset or best auto-detected list is used. pagination.mode "auto" picks the preset / detected method.',
    inputSchema: {
      type: 'object',
      properties: {
        ...tabOrUrl,
        candidate: { type: 'integer', default: 0, description: 'Which list_detect candidate to use when item_selector is not given.' },
        item_selector: { type: 'string', description: 'CSS selector matching each item.' },
        fields: {
          type: 'array',
          description: 'Optional custom columns. Each: {name, selector (CSS, relative to the item; ":scope" for the item itself), attr: "text"|"href"|"src"|<attribute>}. Default: auto-generated fields.',
          items: { type: 'object', properties: { name: { type: 'string' }, selector: { type: 'string' }, attr: { type: 'string' } }, required: ['name'] },
        },
        pagination: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['none', 'next', 'loadmore', 'scroll', 'auto'], default: 'none', description: '"auto" uses a detected Next or Load-more button.' },
            button_selector: { type: 'string' },
            max_pages: { type: 'integer', default: 5, description: 'Pages for next/loadmore; for scroll, roughly how many screens×6 scroll steps (it stops early when nothing new loads).' },
            delay_ms: { type: 'integer', default: 1000 },
          },
        },
        ...returned,
      },
    },
  },
  {
    name: 'page_extract',
    description: 'Extract the same fields from many URLs — one row per page (product pages, profiles, Google Maps places, articles…). Fields are CSS selectors and/or built-ins.',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' } },
        fields: {
          type: 'array',
          description: 'Each: {name, selector, attr ("text" default, "href", "src", "html" or any attribute), multiple (join all matches)} or {name, builtin}. Built-ins: title, h1, description, canonical, og_image, author, published, language, word_count, emails, phones, socials, price, main_text, ig_type, ig_likes, ig_comments, ig_author, ig_date, ig_caption (Instagram post/Reel pages: likes & comments as numbers), maps_name, maps_rating, maps_reviews, maps_category, maps_address, maps_phone, maps_website, maps_hours.',
          items: { type: 'object', properties: { name: { type: 'string' }, selector: { type: 'string' }, attr: { type: 'string' }, multiple: { type: 'boolean' }, builtin: { type: 'string' } }, required: ['name'] },
        },
        mode: { type: 'string', enum: ['auto', 'fast', 'browser'], default: 'auto', description: 'auto = fetch each page in the background and open a hidden tab only for pages that need JavaScript or a login. fast = background only, never a tab. browser = always a background tab (Google Maps).' },
        concurrency: { type: 'integer', default: 3 },
        ...returned,
      },
      required: ['urls', 'fields'],
    },
  },
  {
    name: 'trends_find',
    description: 'Find the best-performing Reels / TikToks / YouTube Shorts & videos / X posts / Reddit posts for a topic or #hashtag (or from a search/profile page, or a list of post links) and rank them. Each post comes with caption, hook, hashtags, views, likes, comments, shares, saves, engagement rate, views per day, sound/music, duration, upload time, creator followers and (Pro, where the platform publishes captions) the spoken transcript. Also returns patterns the winners share (hashtags, sounds, length, hooks, timing). Posts are read in the background where possible; Instagram/TikTok search pages are opened in a tab (the user must be logged in there). After calling, analyse why the top posts work and suggest ideas.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic ("ai tools") or hashtag ("#aitools").' },
        platform: { type: 'string', enum: ['instagram', 'tiktok', 'youtube', 'youtube-shorts', 'x', 'reddit'], default: 'youtube', description: 'reddit: query can be a topic or r/subreddit (read fully in the background; scores are upvotes). x: needs the user logged in to x.com (opened and scrolled in a tab).' },
        page_url: { type: 'string', description: 'Instead of query: a search, hashtag, profile or feed page to collect posts from.' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Instead of query: post / Reel / video links to compare.' },
        scan: { type: 'integer', default: 30, description: 'How many posts to read before ranking (free plan: 30).' },
        top: { type: 'integer', default: 10 },
        rank_by: { type: 'string', enum: ['trending', 'balanced', 'views', 'engaging'], default: 'trending', description: 'trending = fastest-growing (views per hour) + engagement; engaging = interactions per view.' },
        transcripts: { type: 'boolean', default: true, description: 'Fetch the spoken script of the winners where captions exist (Pro).' },
        max_age_days: { type: 'integer', description: 'Only posts newer than this.' },
        min_views: { type: 'integer' },
      },
    },
  },
  {
    name: 'post_details',
    description: 'Full data for one or more social posts (Instagram post/Reel, TikTok, YouTube video/Short, X post, Reddit post): caption, hashtags, mentions, views, likes, comments, shares, saves, sound/music, original audio or not, duration, upload time, author, followers, thumbnail, and the transcript where captions exist (Pro). Read in the background; a hidden tab is used only when the page needs it.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        urls: { type: 'array', items: { type: 'string' } },
        transcript: { type: 'boolean', default: true },
        ...returned,
      },
    },
  },
  {
    name: 'find_emails',
    description: 'Find email addresses on websites. Deep mode also visits contact/about/team pages. Decodes protected and obfuscated emails.',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'Websites or domains.' },
        deep: { type: 'boolean', default: true },
        max_subpages: { type: 'integer', default: 5 },
        include_phones: { type: 'boolean', default: false },
        ...returned,
      },
      required: ['urls'],
    },
  },
  {
    name: 'find_social_links',
    description: 'Find social media profiles (LinkedIn, X, Instagram, Facebook, YouTube, TikTok, GitHub…) for a list of websites.',
    inputSchema: {
      type: 'object',
      properties: { urls: { type: 'array', items: { type: 'string' } }, deep: { type: 'boolean', default: true }, ...returned },
      required: ['urls'],
    },
  },
  {
    name: 'shopify_products',
    description: 'Export products of a Shopify store (all or one collection): one row per variant, per product, or Shopify import-CSV format.',
    inputSchema: {
      type: 'object',
      properties: {
        store: { type: 'string', description: 'Store domain or URL.' },
        collection: { type: 'string', description: 'Collection handle (optional).' },
        format: { type: 'string', enum: ['variants', 'products', 'shopify-csv'], default: 'variants' },
        ...returned,
      },
      required: ['store'],
    },
  },
  {
    name: 'sitemap_urls',
    description: 'List a website\'s URLs from its sitemaps (robots.txt, sitemap indexes, .gz). Optional filter by text or /regex/.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string' },
        filter: { type: 'string' },
        max_urls: { type: 'integer', default: 5000 },
        ...returned,
      },
      required: ['site'],
    },
  },
  {
    name: 'images_find',
    description: 'Find images on a page (incl. lazy-loaded, srcset, CSS backgrounds), filtered by minimum size.',
    inputSchema: {
      type: 'object',
      properties: { ...tabOrUrl, min_width: { type: 'integer', default: 100 }, min_height: { type: 'integer', default: 100 }, scroll: { type: 'boolean', default: true }, ...returned },
    },
  },
  {
    name: 'images_download',
    description: 'Download images into the user\'s Downloads/pullrows/<folder>/ directory.',
    inputSchema: {
      type: 'object',
      properties: { urls: { type: 'array', items: { type: 'string' } }, folder: { type: 'string', default: 'claude' } },
      required: ['urls'],
    },
  },
  {
    name: 'data_table_read',
    description: 'Read rows currently in the PullRows Data Table (results of the last scrape, by the user or by Claude).',
    inputSchema: {
      type: 'object',
      properties: { sheet: { type: 'string' }, offset: { type: 'integer', default: 0 }, limit: { type: 'integer', default: 100 } },
    },
  },
  {
    name: 'recipes_list',
    description: 'List the user\'s saved scraping recipes (re-runnable setups).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'recipe_run',
    description: 'Run one of the user\'s saved recipes by id and return the results.',
    inputSchema: { type: 'object', properties: { recipe_id: { type: 'string' }, ...returned }, required: ['recipe_id'] },
  },
  {
    name: 'monitors_list',
    description: 'List the user\'s monitors (recipes re-run on a schedule in the background) with their latest results: new rows, gone rows, changed values, price drops.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'monitor_create',
    description: 'Watch a page for changes on a schedule — new listings/jobs/leads, price drops, changed values. Give recipe_id (from recipes_list) or the url of a list page (optionally with item_selector / fields / pagination like list_extract; it is saved as a recipe). The user gets a Chrome notification when something changes. Free plan: 1 monitor, daily; Pro: unlimited, hourly.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'string' },
        url: { type: 'string', description: 'A list page to watch (instead of recipe_id).' },
        name: { type: 'string' },
        item_selector: { type: 'string' },
        fields: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, selector: { type: 'string' }, attr: { type: 'string' } }, required: ['name'] } },
        pagination: { type: 'object', properties: { mode: { type: 'string', enum: ['none', 'next', 'loadmore', 'scroll', 'auto'] }, max_pages: { type: 'integer' } } },
        every_minutes: { type: 'integer', enum: [60, 360, 1440, 10080], default: 1440 },
        alert_on: { type: 'string', enum: ['any', 'new', 'drops'], default: 'any', description: 'any change, only new rows, or only price drops' },
      },
    },
  },
];

// Page tools also return a screenshot of the page, so the user sees what was scraped in the chat.
for (const t of TOOLS) {
  if (['browser_open', 'list_detect', 'list_extract', 'page_action', 'quick_scan', 'images_find'].includes(t.name)) {
    t.inputSchema.properties.screenshot = { type: 'boolean', default: true, description: 'Also return a screenshot of the page (shown to the user in the chat). Set false to save tokens.' };
  }
}

export const INSTRUCTIONS = `Tools for the user's PullRows Chrome extension. Every tool runs inside the user's own Chrome (their logged-in sessions), and results are also saved to the PullRows Data Table so the user can export them (CSV, Excel, Google Sheets).
Typical flows:
- Lists (products, search results, directories, Google Maps): browser_open → list_detect → list_extract (with pagination if needed).
- Details for many pages: page_extract with selectors/built-ins (use sitemap_urls or list_extract link columns to get URLs).
- Leads: find_emails / find_social_links on a list of websites.
- Watching for changes ("tell me when the price drops", "new jobs every morning"): monitor_create; monitors_list shows the latest changes.
- Social research ("best reels about X", "what's trending for #tag"): trends_find, then explain why the winners work from their hooks, transcripts, sounds and the patterns. post_details for specific post links.
Use browser_screenshot or page_read to understand an unfamiliar page. Keep scrapes polite (reasonable page counts and delays).
Some sites are blocked by the user's safety settings (email, banking, password managers, local network); clicking/typing (page_action click/fill) and images_download only work if the user enabled 'Allow actions' in PullRows Settings — if a tool says it's disabled, tell the user how to enable it rather than retrying.`;
