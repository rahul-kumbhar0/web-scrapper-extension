// Safety rules for the Claude connector: pages Claude may never open, read or screenshot.
// Applies only to tool calls coming from Claude; the user's own scrapes are unaffected.

// Sensitive by default (editable in Settings → Claude connector → Blocked sites).
// The word rules below (SENSITIVE_WORDS) catch "…bank…" hosts generically; this list covers the
// banks, brokers and payment providers whose names carry no such word.
export const DEFAULT_BLOCKED = [
  // mail, accounts and password managers
  'accounts.google.com', 'myaccount.google.com', 'mail.google.com', 'pay.google.com', 'passwords.google.com',
  'outlook.live.com', 'outlook.office.com', 'login.microsoftonline.com', 'account.microsoft.com',
  'appleid.apple.com', 'icloud.com', 'mail.yahoo.com', 'mail.proton.me', 'protonmail.com', 'zoho.com',
  '1password.com', 'lastpass.com', 'bitwarden.com', 'dashlane.com', 'keepersecurity.com', 'nordpass.com',
  // payments and money transfer
  'paypal.com', 'stripe.com', 'wise.com', 'revolut.com', 'venmo.com', 'cash.app', 'squareup.com',
  'payoneer.com', 'razorpay.com', 'payu.in', 'phonepe.com', 'paytm.com', 'billdesk.com', 'ccavenue.com',
  'westernunion.com', 'remitly.com', 'adyen.com', 'klarna.com', 'afterpay.com', 'mercadopago.com',
  // card issuers and credit
  'americanexpress.com', 'amex.com', 'discover.com', 'capitalone.com', 'creditkarma.com', 'experian.com',
  'equifax.com', 'transunion.com', 'cibil.com',
  // banks and brokers (no "bank" in the name)
  'chase.com', 'wellsfargo.com', 'citi.com', 'citibank.com', 'citigroup.com', 'usbank.com', 'pnc.com',
  'truist.com', 'schwab.com', 'fidelity.com', 'vanguard.com', 'etrade.com', 'robinhood.com', 'coinbase.com',
  'binance.com', 'kraken.com', 'blockchain.com', 'metamask.io',
  'hsbc.com', 'barclays.co.uk', 'lloydsbank.com', 'natwest.com', 'santander.com', 'monzo.com', 'starling.com',
  'nationwide.co.uk', 'halifax.co.uk', 'revolut.me',
  'icicidirect.com', 'hdfcsec.com', 'kotak.com', 'axisdirect.in', 'sbi.co.in', 'onlinesbi.sbi', 'zerodha.com',
  'kite.zerodha.com', 'groww.in', 'upstox.com', 'angelone.in', 'npci.org.in', 'incometax.gov.in',
  // stores where a click spends money or changes the browser
  'chromewebstore.google.com',
];

// Everything the previous release shipped, so an untouched saved list can be upgraded on update.
export const DEFAULT_BLOCKED_V1 = [
  'accounts.google.com', 'myaccount.google.com', 'mail.google.com', 'pay.google.com', 'passwords.google.com',
  'outlook.live.com', 'outlook.office.com', 'login.microsoftonline.com', 'account.microsoft.com',
  'appleid.apple.com', 'icloud.com',
  'paypal.com', 'stripe.com', 'wise.com', 'revolut.com',
  '1password.com', 'lastpass.com', 'bitwarden.com', 'dashlane.com',
  'chromewebstore.google.com',
];

// Words that mark banking / payment / secrets hosts. The old rule only matched a whole label
// ("bank.com"), which let through every real bank: hdfcbank.com, icicibank.com, bancomer.com.
// A label now matches when it STARTS or ENDS with one of these words — that covers the real names
// without catching words that merely contain one ("urbankitchen.com" is not a bank).
const MONEY_WORDS = 'bank|banking|banca|banco|banque|netbanking|passbook|creditunion|wallet|vault|brokerage';
const SENSITIVE_WORDS = new RegExp(
  `(^|[.-])(?:[a-z0-9-]*(?:${MONEY_WORDS})|(?:${MONEY_WORDS})[a-z0-9-]*)([.-]|$)`, 'i');

// Whole labels that only ever mean money.
const SENSITIVE_LABELS = /(^|\.)(pay|payment|payments|upi|ifsc|billing|invoice|invoices|card|cards|netbank|ebank)\./i;

// …except these, which match a word above but are not finance.
const SENSITIVE_EXCEPTIONS = /(^|\.)(worldbank\.org|foodbank[a-z0-9-]*\.[a-z.]+|imagebank[a-z0-9-]*\.[a-z.]+|bankrate\.com|vaultproject\.io|hashicorp\.com)$/i;

// A hostname with no dot ("intranet", "jenkins", "nas") only resolves through a local DNS search
// suffix, so it is a local-network address too — not just localhost and *.local/*.internal.
const PRIVATE_HOST = /^(localhost|[^.]+|.*\.(local|internal|localhost|lan|home|corp|intranet))$/i;

function isPrivateIp(host) {
  // IPv6 literals only ("fdic.gov" is a normal hostname); WHATWG URL normalises IPv4 forms.
  if (/^\[.*\]$/.test(host)) {
    const h = host.slice(1, -1).toLowerCase();
    if (/^(::1?|fe[89ab][0-9a-f]?:|f[cd][0-9a-f]{0,2}:)/.test(h)) return true;
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (!mapped) return false;
    if (mapped.length === 2) return isPrivateIp(mapped[1]);
    const n = (parseInt(mapped[1], 16) << 16 >>> 0) + parseInt(mapped[2], 16);
    return isPrivateIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  const h = host;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

const matchesHost = (host, rule) => {
  rule = String(rule || '').trim().toLowerCase().replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return !!rule && (host === rule || host.endsWith(`.${rule}`));
};

// Returns a reason string if Claude may not touch this URL, else ''.
export function blockedReason(url, { blocked = DEFAULT_BLOCKED, allowPrivate = false } = {}) {
  let u;
  try { u = new URL(url); } catch { return 'invalid URL'; }
  if (!/^https?:$/.test(u.protocol)) return `${u.protocol.replace(':', '')} pages are off-limits`;
  const host = u.hostname.toLowerCase().replace(/\.+$/, ''); // "mail.google.com." is the same host
  if (!allowPrivate && (PRIVATE_HOST.test(host) || isPrivateIp(host))) return 'local-network addresses are blocked';
  if (blocked.some((r) => matchesHost(host, r))) return `${host} is on the blocked-sites list`;
  if (!SENSITIVE_EXCEPTIONS.test(host) && (SENSITIVE_WORDS.test(host) || SENSITIVE_LABELS.test(`${host}.`))) {
    return `${host} looks like a banking, payment or wallet site`;
  }
  return '';
}

export function assertAllowed(url, opts) {
  const why = blockedReason(url, opts);
  if (why) throw new Error(`Blocked by PullRows safety settings: ${why}. The user can change this in PullRows → Settings → Claude connector.`);
}
