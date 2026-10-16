// Product-wide constants: brand, website, the official Claude relay and licensing.
// Everything a release needs to point somewhere else lives here.

export const BRAND = 'PullRows';
export const SITE_URL = 'https://pullrows.vercel.app';
export const SUPPORT_EMAIL = 'support@pullrows.com';

// Official relay for the Claude connector (users can still point to their own in Settings).
export const DEFAULT_RELAY = 'https://web-scrapper-extension.onrender.com';

export const LINKS = {
  pricing: `${SITE_URL}/#pricing`,
  docs: `${SITE_URL}/docs`,
  connectorDocs: `${SITE_URL}/docs#claude-connector`,
  privacy: `${SITE_URL}/privacy`,
  terms: `${SITE_URL}/terms`,
  changelog: `${SITE_URL}/changelog`,
  uninstall: `${SITE_URL}/uninstall`,
};

// Licence keys are sold and validated by Dodo Payments (merchant of record). Their licence
// activate / validate / deactivate endpoints are public: they take the key, never a secret.
export const LICENSE_API = 'https://live.dodopayments.com';
export const CHECKOUT = {
  monthly: `${SITE_URL}/#pricing`,
  yearly: `${SITE_URL}/#pricing`,
  lifetime: `${SITE_URL}/#pricing`,
};
