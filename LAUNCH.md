# PullRows launch checklist

Steps marked **you** need your accounts, identity or payment details. Everything else is already in the repo.

## 1. Domain (you, about $10–15/yr)
- [ ] Register **pullrows.com**. The .io, .app and .ai versions were also free on 2026-10-16.
- [ ] In Vercel: open the `pullrows` project → Settings → Domains → add `pullrows.com` and `www.pullrows.com`, then set the DNS records Vercel shows.
- [ ] Replace `https://pullrows.vercel.app` with `https://pullrows.com` in `lib/config.js` (`SITE_URL`), `manifest.json` (`homepage_url`), `website/` (canonical/OG URLs) and `store/STORE_LISTING.md`.

## 2. Payments with Dodo Payments (you)
Dodo is a merchant of record for founders in India: it handles global tax, pays out to an Indian bank account, and issues licence keys.
- [ ] Sign up at dodopayments.com and complete KYC.
- [ ] Create three products. Turn on **License keys** for each, with **activation limit 3**:
  - PullRows Pro Monthly: $9/month (₹399 with Indian pricing)
  - PullRows Pro Yearly: $59/year (₹2,499)
  - PullRows Lifetime: $79 one-time launch price (₹3,999) for the first 500, then $99 (₹4,999).
- [ ] Copy each product's checkout link into:
  - `lib/config.js` → `CHECKOUT.monthly / yearly / lifetime`
  - `website/assets/config.js` → `CHECKOUT_PRO_MONTHLY / _YEARLY / _LIFETIME`
- [ ] Set the success page to show the licence key, and link to `https://pullrows.com/docs#activate`.
- [ ] Create a test-mode key for the Chrome Web Store reviewer.
- Optional: run `chrome.storage.local.set({devLicenseApi:'https://test.dodopayments.com'})` in the side panel console to test against test mode.

## 3. Relay server on Render
- [ ] Push this repo to GitHub. Render redeploys the relay.
- [ ] In the Render dashboard → service → Environment, check that these are set: `PUBLIC_URL`, `OAUTH_SECRET` (generated), `TRUST_PROXY=1`, `NODE_ENV=production` and `HOST=0.0.0.0`. They are all in `render.yaml`; apply them through Blueprint sync or add them by hand.
- [ ] Upgrade from the free instance to the paid **Starter** instance before launch. Free instances sleep and restart, which drops connections.
- [ ] Later: move the relay to `relay.pullrows.com` and update `DEFAULT_RELAY` in `lib/config.js`.
- ⚠ Connector links changed in v1.0: the link now holds a hash of the secret. After updating, open PullRows → Settings → Claude connector, turn it on again (one consent screen), **copy the new link**, and replace the old connector in Claude.

## 4. Website
- [ ] Fill the placeholders in `website/assets/config.js`: Chrome Web Store URL (after step 5), checkout links, support email.
- [ ] Redeploy: push to the Vercel project.
- [ ] Set up `support@pullrows.com`, for example with Cloudflare Email Routing or Zoho Mail free.

## 5. Chrome Web Store (you, $5 one-time)
- [ ] Register at https://chrome.google.com/webstore/devconsole and turn on 2-step verification.
- [ ] Run `npm run package` and upload `dist/pullrows-1.0.1.zip`.
- [ ] Fill in the listing, privacy tab and permission justifications from `store/STORE_LISTING.md`, and upload the images in `store/`.
- [ ] Privacy policy URL: `https://pullrows.com/privacy`, or the vercel.app URL until the domain is live.
- [ ] Add the reviewer test instructions, including the test-mode licence key.
- Review usually takes 2–7 days; `<all_urls>` can mean an in-depth review of up to 3 weeks.
- [ ] Once it's published, put the store URL in `website/assets/config.js` (`CHROME_STORE_URL`) and redeploy the site.

## 6. Microsoft Edge Add-ons (free)
- [ ] Register at partner.microsoft.com and upload the same zip and texts.

## 7. After launch
- [ ] Ask the first users for reviews (in-product, after a successful export). Don't buy reviews.
- [ ] Write SEO pages per use case: "Scrape Google Maps to Excel", "Export a Shopify store", and others (ideas in `website/`).
- [ ] Watch the Render logs and set up `/health` uptime monitoring, for example with UptimeRobot.
