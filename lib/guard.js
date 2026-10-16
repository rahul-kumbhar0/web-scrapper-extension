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
  const h = host.replace(/^\[|\]$/g, '');
  if (/^(::1|::|fe80:|fc|fd)/i.test(h)) return true;
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
  const host = u.hostname.toLowerCase();
  if (!allowPrivate && (PRIVATE_HOST.test(host) || isPrivateIp(host))) return 'local-network addresses are blocked';
  if (blocked.some((r) => matchesHost(host, r))) return `${host} is on the blocked-sites list`;
  if (SENSITIVE_WORDS.test(host)) return `${host} looks like a banking or wallet site`;
  return '';
}

export function assertAllowed(url, opts) {
  const why = blockedReason(url, opts);
  if (why) throw new Error(`Blocked by PullRows safety settings: ${why}. The user can change this in PullRows → Settings → Claude connector.`);
}
