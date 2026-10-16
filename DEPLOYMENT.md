# How PullRows is deployed

```
                ┌────────────────────────── user's computer ──────────────────────────┐
                │  Chrome + PullRows extension                                         │
                │  (all scraping, Data Table, history, recipes — stays here)          │
                └───────────────┬──────────────────────────────────────┬──────────────┘
                     long-poll  │ /bridge/<secret>                      │ licence check (daily)
                                ▼                                       ▼
 Claude (claude.ai,   ──MCP──▶  Relay on Render                     Dodo Payments
 Desktop, Code)      /mcp/<id>  web-scrapper-extension.onrender.com  (licence keys, checkout)
                                (stores nothing; passes calls through)

 Website on Vercel: pullrows.vercel.app — landing page, docs, privacy, terms, pricing → checkout
```

| Piece | Where | What it does | Cost |
|---|---|---|---|
| Extension | Chrome Web Store (+ Edge Add-ons) | Everything the user sees; scraping runs locally | $5 one-time developer fee |
| Website | Vercel project `pullrows` (`website/`) | Marketing, docs, legal, checkout links | Free (Hobby) |
| Relay | Render service from `render.yaml` (`server/`) | Connects Claude to each user's browser | Free now → **Starter ($7/mo) before launch** |
| Payments | Dodo Payments | Checkout, tax, licence keys, payouts | % per sale |

## How a user connects Claude: nothing to send them

Every user gets **their own private link automatically**. You don't hand out an API link and you don't need any backend sign-up:

1. The user installs PullRows and opens **Settings → Claude connector**.
2. They turn on **Allow Claude to use this browser** and accept the consent screen.
3. The extension makes a secret for that browser and shows the user's link, for example `https://web-scrapper-extension.onrender.com/mcp/AUymoA00vT0dqg…`. The link holds only a hash of the secret.
4. The guided steps in Settings do the rest:
   - **Copy link & open Claude** copies the link and opens claude.ai → Settings → Connectors. The user chooses **Add custom connector**, pastes the link and clicks Add.
   - **Claude Code** gets a copyable command: `claude mcp add --transport http pullrows <link>`.
   - **Try it**: the user asks Claude "Use PullRows to list my open tabs", and the call appears in Recent Claude activity.

All users share the one relay. The `<id>` in each link routes Claude's calls to that user's browser only. **Generate new link** in Settings revokes the old link.

The website's Docs page (`/docs#claude-connector`) explains the same steps for people who arrive from the site.

## Deploying updates
- **Website:** push to `main`. If the Vercel project isn't wired to GitHub auto-deploy, redeploy the latest commit from the Vercel dashboard.
- **Relay:** push to `main`, and Render redeploys from `render.yaml`. Connected browsers reconnect by themselves (automatic retry with backoff). A call that is running during a deploy fails once, and Claude can retry it.
- **Extension:** bump `version` in `manifest.json` and `package.json`, run `npm test` and `npm run package`, then upload `dist/pullrows-<version>.zip` in the Chrome Web Store dashboard. Users update automatically within about a day.

## Before charging money (checklist)
1. **Render: upgrade to Starter or better.** Free instances sleep after inactivity and restart, which drops connections. Set the env vars from `render.yaml` (`PUBLIC_URL`, `OAUTH_SECRET`, `TRUST_PROXY=1`, `NODE_ENV=production`, `HOST=0.0.0.0`).
2. **Custom domains (optional but more trustworthy):**
   - `pullrows.com` → Vercel.
   - `relay.pullrows.com` → Render (Settings → Custom domain).
   - Then update `DEFAULT_RELAY` and `SITE_URL` in `lib/config.js`, and `PUBLIC_URL` in `render.yaml`, and ship a new extension version.
   - Keep the old onrender.com address working: existing links keep pointing at it until users copy a new one.
3. **Uptime monitor:** watch `https://<relay>/health` with UptimeRobot or Better Stack (free) and get an alert when it's down.
4. **Scale:** one Starter instance holds thousands of idle connected browsers, since each is a cheap long-poll. The relay keeps its state in memory, so **don't run more than one instance** without sticky routing. When you outgrow one instance, move up an instance size first.
5. **Payments:** create the Dodo products and paste the checkout links (see `LAUNCH.md` §2).
6. **Reviews:** the extension asks happy users for a review once, after their 2nd export or 5th run, with **no reward attached**. Chrome Web Store policy bans incentivised reviews, so never give a trial or discount in exchange for a rating; the extension could be removed. The 3-day Pro trial is offered to everyone, separately.
