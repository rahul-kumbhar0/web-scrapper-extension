/*
 * PullRows site config — every external link lives here.
 * Edit the values below; elements with data-href="KEY" / data-mail pick them up on load.
 * (Static hrefs in the HTML are only no-JavaScript fallbacks.)
 */
window.PULLROWS_CONFIG = {
  CHROME_STORE_URL: "https://chromewebstore.google.com/detail/pullrows",
  EDGE_URL: "https://microsoftedge.microsoft.com/addons/detail/pullrows",

  // Dodo Payments checkout links (one per product).
  CHECKOUT_PRO_MONTHLY: "https://checkout.dodopayments.com/buy/REPLACE_ME_PRO_MONTHLY",
  CHECKOUT_PRO_YEARLY: "https://checkout.dodopayments.com/buy/REPLACE_ME_PRO_YEARLY",
  CHECKOUT_LIFETIME: "https://checkout.dodopayments.com/buy/REPLACE_ME_LIFETIME",

  // Optional: separate INR checkout links. Leave empty to use the links above for both currencies.
  CHECKOUT_PRO_MONTHLY_INR: "",
  CHECKOUT_PRO_YEARLY_INR: "",
  CHECKOUT_LIFETIME_INR: "",

  SUPPORT_EMAIL: "support@pullrows.com"
};
