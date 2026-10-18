// Turning scraped text into clean values: "₹1,299" → 1299, "1.2M views" → 1200000,
// "4.5 out of 5" → 4.5, and links without tracking parameters.

const SUFFIX = { k: 1e3, m: 1e6, b: 1e9, t: 1e12, mn: 1e6, bn: 1e9, mio: 1e6, mrd: 1e9, lakh: 1e5, lac: 1e5, l: 1e5, cr: 1e7, crore: 1e7, '万': 1e4, '萬': 1e4, '亿': 1e8, '億': 1e8, '천': 1e3, '만': 1e4, 'тыс': 1e3, 'млн': 1e6, 'mil': 1e3, 'mi': 1e6 };

// Normalise "1,234.56", "1.234,56", "1 234,56", "1'234.56" to a JS number string.
function normaliseDigits(s) {
  s = s.replace(/[\s  ']/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Whichever comes last is the decimal separator.
    return lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  }
  if (lastComma > -1) {
    const groups = s.split(',');
    // One comma followed by 1–2 digits is a decimal comma ("25,00"); otherwise thousands.
    return groups.length === 2 && groups[1].length !== 3 ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  if ((s.match(/\./g) || []).length > 1) return s.replace(/\./g, ''); // 1.234.567
  return s;
}

/** The number in a scraped value, or null when there isn't exactly one sensible number. */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value ?? '').trim();
  if (!s) return null;
  // Ratings: "4.5 out of 5", "4,5/5", "Rated 4.2 stars".
  const rating = s.match(/(\d+(?:[.,]\d+)?)\s*(?:out of|von|sur|de|\/)\s*(?:5|10)\b/i);
  if (rating) return Number(rating[1].replace(',', '.'));
  const negative = /^\s*[-−–]|^\(.*\)$/.test(s);
  const m = s.match(/(\d[\d\s  .,']*)(?:\s*(k|m|b|t|mn|bn|mio|mrd|lakh|lac|l|cr|crore|万|萬|亿|億|천|만|тыс|млн|mil|mi)\b\.?|\s*(万|萬|亿|億|천|만))?/i);
  if (!m) return null;
  let digits = m[1].replace(/[\s  .,']+$/, '');
  // "12.3K" style values use a decimal point before a suffix.
  const suffix = (m[2] || m[3] || '').toLowerCase();
  const n = Number(normaliseDigits(digits));
  if (!Number.isFinite(n)) return null;
  const mult = SUFFIX[suffix] || 1;
  const out = n * mult;
  return Math.round((negative ? -out : out) * 1e6) / 1e6;
}

/** Share of non-empty values in `values` that contain a number. */
export function numericShare(values) {
  const v = values.filter((x) => String(x ?? '').trim());
  if (!v.length) return 0;
  return v.filter((x) => toNumber(x) !== null).length / v.length;
}

const TRACKING = /^(utm_\w+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|mc_cid|mc_eid|igshid|igsh|si|ref|ref_|ref_src|refsrc|_hsenc|_hsmi|hsCtaTracking|yclid|twclid|ttclid|li_fat_id|spm|scm|trk|trackingId|refId|_branch_match_id|share_id|is_from_webapp|sender_device|web_id)$/i;
const AMAZON_TRACKING = /^(pd_rd_\w+|pf_rd_\w+|qid|sr|keywords|crid|sprefix|psc|smid|ascsubtag|tag|linkCode|linkId|content-id|dib|dib_tag|th)$/i;

/** A link without tracking parameters (utm_*, fbclid, Amazon ref/qid…) and without the #fragment. */
export function cleanUrl(value) {
  let u;
  try { u = new URL(String(value).trim()); } catch { return value; }
  if (!/^https?:$/.test(u.protocol)) return value;
  const amazon = /(^|\.)amazon\./.test(u.hostname);
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k) || (amazon && AMAZON_TRACKING.test(k))) u.searchParams.delete(k);
  // Amazon: /Product-Name/dp/ASIN/ref=… → /dp/ASIN
  const dp = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
  if (dp && amazon) u.pathname = `/dp/${dp[1]}`;
  if (!/^#!?\//.test(u.hash)) u.hash = ''; // keep hash routes (#/page, #!/page)
  return u.href.replace(/\?$/, '');
}
