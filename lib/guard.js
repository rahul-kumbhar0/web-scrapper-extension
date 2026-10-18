// Safety rules for the Claude connector: pages Claude may never open, read or screenshot.
// Applies only to tool calls coming from Claude; the user's own scrapes are unaffected.

// Sensitive by default (editable in Settings → Claude connector → Blocked sites).
export const DEFAULT_BLOCKED = [
  'accounts.google.com', 'myaccount.google.com', 'mail.google.com', 'pay.google.com', 'passwords.google.com',
  'outlook.live.com', 'outlook.office.com', 'login.microsoftonline.com', 'account.microsoft.com',
  'appleid.apple.com', 'icloud.com',
  'paypal.com', 'stripe.com', 'wise.com', 'revolut.com',
  '1password.com', 'lastpass.com', 'bitwarden.com', 'dashlane.com',
  'chromewebstore.google.com',
];

// Words that mark banking / payment / secrets hosts (matched against host labels).
const SENSITIVE_WORDS = /(^|[.-])(bank|banking|netbanking|onlinebanking|wallet|vault)([.-]|$)/i;

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;

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
  if (SENSITIVE_WORDS.test(host)) return `${host} looks like a banking or wallet site`;
  return '';
}

export function assertAllowed(url, opts) {
  const why = blockedReason(url, opts);
  if (why) throw new Error(`Blocked by PullRows safety settings: ${why}. The user can change this in PullRows → Settings → Claude connector.`);
}
