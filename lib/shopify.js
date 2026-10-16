// Shopify store export via the public /products.json endpoint (no API key needed).
// Paging: ?limit=250&page=N until an empty page; stores reject page*limit > 25,000.
import { fetchJson, normalizeUrl } from './net.js';

const LIMIT = 250;
const MAX_PAGES = 100;

const stripHtml = (html) => {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
};

export function storeOrigin(input) {
  const url = normalizeUrl(input);
  return url ? new URL(url).origin : '';
}

export async function isShopify(origin, { signal } = {}) {
  try {
    const data = await fetchJson(`${origin}/products.json?limit=1`, { signal, timeoutMs: 15000 });
    return Array.isArray(data?.products);
  } catch {
    return false;
  }
}

export async function listCollections(origin, { signal } = {}) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const data = await fetchJson(`${origin}/collections.json?limit=${LIMIT}&page=${page}`, { signal }).catch(() => null);
    if (!data?.collections?.length) break;
    out.push(...data.collections.map((c) => ({ handle: c.handle, title: c.title, products: c.products_count ?? '' })));
  }
  return out;
}

export async function fetchProducts(origin, { collection = '', signal, onProgress, max = Infinity } = {}) {
  const base = collection ? `${origin}/collections/${encodeURIComponent(collection)}/products.json` : `${origin}/products.json`;
  const products = [];
  for (let page = 1; page <= MAX_PAGES && page * LIMIT <= 25000 + LIMIT; page++) {
    if (signal?.aborted) break;
    let data;
    try {
      data = await fetchJson(`${base}?limit=${LIMIT}&page=${page}`, { signal });
    } catch (e) {
      if (!products.length) throw e;
      products.partial = String(e.message || e); // keep what we have
      break;
    }
    if (!data?.products?.length) break;
    products.push(...data.products);
    onProgress?.(products.length, page);
    if (products.length >= max) { products.capped = products.length > max || data.products.length === LIMIT; products.length = Math.min(products.length, max); break; }
    if (data.products.length < LIMIT) break;
  }
  return products;
}

const priceRange = (variants) => {
  const prices = variants.map((v) => parseFloat(v.price)).filter((n) => !Number.isNaN(n));
  if (!prices.length) return '';
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? min.toFixed(2) : `${min.toFixed(2)} - ${max.toFixed(2)}`;
};

// mode: 'variants' (one row per variant) | 'products' (one row per product) | 'shopify-csv' (Shopify import format)
export function productRows(origin, products, mode = 'variants') {
  if (mode === 'products') {
    return products.map((p) => ({
      id: p.id,
      title: p.title,
      url: `${origin}/products/${p.handle}`,
      vendor: p.vendor,
      type: p.product_type,
      tags: [].concat(p.tags || []).join(', '),
      price: priceRange(p.variants || []),
      compare_at_price: p.variants?.find((v) => v.compare_at_price)?.compare_at_price || '',
      available: (p.variants || []).some((v) => v.available) ? 'yes' : 'no',
      variants: p.variants?.length || 0,
      options: (p.options || []).map((o) => `${o.name}: ${(o.values || []).join('/')}`).join('; '),
      image: p.images?.[0]?.src || '',
      images: (p.images || []).map((i) => i.src).join(' | '),
      description: stripHtml(p.body_html).slice(0, 5000),
      published_at: p.published_at,
      updated_at: p.updated_at,
    }));
  }
  if (mode === 'shopify-csv') {
    const rows = [];
    for (const p of products) {
      const opts = p.options || [];
      (p.variants || []).forEach((v, i) => {
        const first = i === 0;
        rows.push({
          Handle: p.handle,
          Title: first ? p.title : '',
          'Body (HTML)': first ? p.body_html || '' : '',
          Vendor: first ? p.vendor : '',
          Type: first ? p.product_type : '',
          Tags: first ? [].concat(p.tags || []).join(', ') : '',
          Published: first ? 'TRUE' : '',
          'Option1 Name': first ? opts[0]?.name || 'Title' : '',
          'Option1 Value': v.option1 || '',
          'Option2 Name': first ? opts[1]?.name || '' : '',
          'Option2 Value': v.option2 || '',
          'Option3 Name': first ? opts[2]?.name || '' : '',
          'Option3 Value': v.option3 || '',
          'Variant SKU': v.sku || '',
          'Variant Grams': v.grams ?? '',
          'Variant Price': v.price,
          'Variant Compare At Price': v.compare_at_price || '',
          'Variant Requires Shipping': v.requires_shipping ? 'TRUE' : 'FALSE',
          'Variant Taxable': v.taxable ? 'TRUE' : 'FALSE',
          'Image Src': (v.featured_image?.src) || (first ? p.images?.[0]?.src || '' : ''),
          'Image Position': first && p.images?.length ? 1 : '',
          Status: 'active',
        });
      });
    }
    return rows;
  }
  const rows = [];
  for (const p of products) {
    for (const v of p.variants || []) {
      rows.push({
        product_id: p.id,
        variant_id: v.id,
        title: p.title,
        variant: v.title === 'Default Title' ? '' : v.title,
        sku: v.sku || '',
        price: v.price,
        compare_at_price: v.compare_at_price || '',
        available: v.available ? 'yes' : 'no',
        vendor: p.vendor,
        type: p.product_type,
        tags: [].concat(p.tags || []).join(', '),
        url: `${origin}/products/${p.handle}${p.variants.length > 1 ? `?variant=${v.id}` : ''}`,
        image: v.featured_image?.src || p.images?.[0]?.src || '',
        grams: v.grams ?? '',
      });
    }
  }
  return rows;
}
