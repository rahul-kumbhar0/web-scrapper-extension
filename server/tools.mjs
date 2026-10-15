// MCP tool definitions exposed to Claude. Every call is forwarded to the Web Scraper extension
// running in the user's Chrome, which executes it and sends the result back.

const tabOrUrl = {
  tab_id: { type: 'integer', description: 'Tab to use (from browser_tabs). Default: the active tab.' },
  url: { type: 'string', description: 'Open this URL first (in the tab) before running.' },
};
const returned = { max_rows_returned: { type: 'integer', default: 100, description: 'How many rows to include in the reply (all rows are saved to the extension Data Table).' } };

export const TOOLS = [
  {
    name: 'browser_tabs',
    description: 'List the open tabs in the user\'s Chrome (id, title, url, active).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_open',
    description: 'Open a URL in the user\'s Chrome (navigates the active tab, or a new tab) and wait for it to load. Use before tools that work on "the current page".',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        new_tab: { type: 'boolean', default: false },
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
        mode: { type: 'string', enum: ['fast', 'browser'], default: 'fast', description: 'fast = fetch HTML (no JS). browser = open each page in a background tab (JS sites, Google Maps).' },
        concurrency: { type: 'integer', default: 3 },
        ...returned,
      },
      required: ['urls', 'fields'],
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
    description: 'Download images into the user\'s Downloads/web-scraper/<folder>/ directory.',
    inputSchema: {
      type: 'object',
      properties: { urls: { type: 'array', items: { type: 'string' } }, folder: { type: 'string', default: 'claude' } },
      required: ['urls'],
    },
  },
  {
    name: 'data_table_read',
    description: 'Read rows currently in the extension\'s Data Table (results of the last scrape, by the user or by Claude).',
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
];

export const INSTRUCTIONS = `Tools for the user's "Web Scraper" Chrome extension. Every tool runs inside the user's own Chrome (their logged-in sessions), and results are also saved to the extension's Data Table so the user can export them (CSV, Excel, Google Sheets).
Typical flows:
- Lists (products, search results, directories, Google Maps): browser_open → list_detect → list_extract (with pagination if needed).
- Details for many pages: page_extract with selectors/built-ins (use sitemap_urls or list_extract link columns to get URLs).
- Leads: find_emails / find_social_links on a list of websites.
Use browser_screenshot or page_read to understand an unfamiliar page. Keep scrapes polite (reasonable page counts and delays).`;
