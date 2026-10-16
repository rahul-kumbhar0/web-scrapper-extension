// SHOPIFY EXTRACTOR — whole catalogue (or one collection) from any Shopify store's public JSON.
import { h, fill, toast, runJob, plural } from '../ui.js';
import { plan } from '../plan.js';
import { makeSheet, setDataset } from '../state.js';
import { card, select, actions, primary, secondary } from '../widgets.js';
import { getActiveTab } from '../../lib/tab.js';
import { storeOrigin, isShopify, listCollections, fetchProducts, productRows } from '../../lib/shopify.js';

export default {
  id: 'shopify',
  title: 'Shopify Extractor',
  icon: '🛍',
  desc: 'Every product & variant of a Shopify store: prices, SKUs, stock, images. Import-ready CSV.',
  render(ctx) {
    const preset = ctx.preset || {};
    const store = h('input', { placeholder: 'store.com', value: preset.store || '', spellcheck: false });
    const status = h('p', { class: 'hint' });
    const collection = h('select', {}, h('option', { value: '' }, 'All products'));
    if (preset.collection) collection.append(h('option', { value: preset.collection, selected: true }, preset.collection));
    const format = select('Output', [
      { value: 'variants', label: 'One row per variant (price, SKU, stock)' },
      { value: 'products', label: 'One row per product' },
      { value: 'shopify-csv', label: 'Shopify product import CSV' },
    ], preset.format || 'variants');

    getActiveTab().then((t) => { if (!store.value && /^https?:/.test(t.url)) store.value = new URL(t.url).origin; }).catch(() => {});

    async function check() {
      const origin = storeOrigin(store.value);
      if (!origin) { toast('Enter a store address.', 'error'); return; }
      await runJob('Checking store…', async (signal) => {
        if (!(await isShopify(origin, { signal }))) {
          status.textContent = '✗ This does not look like a Shopify store (no public /products.json).';
          status.className = 'hint error';
          return;
        }
        const cols = await listCollections(origin, { signal });
        fill(collection, h('option', { value: '' }, 'All products'), ...cols.map((c) => h('option', { value: c.handle }, `${c.title}${c.products !== '' ? ` (${c.products})` : ''}`)));
        status.textContent = `✓ Shopify store · ${plural(cols.length, 'collection')}`;
        status.className = 'hint ok';
      });
    }

    const getConfig = () => ({ store: store.value.trim(), collection: collection.value, format: format.get() });

    async function run() {
      const cfg = getConfig();
      const origin = storeOrigin(cfg.store);
      if (!origin) { toast('Enter a store address.', 'error'); return; }
      await runJob('Downloading products…', async (signal, progress) => {
        const products = await fetchProducts(origin, { collection: cfg.collection, signal, max: plan.limits.shopifyProducts, onProgress: (n, page) => progress(`${plural(n, 'product')} (page ${page})`) });
        if (!products.length) throw new Error('No products returned — the store may block its public product feed.');
        const rows = productRows(origin, products, cfg.format);
        const host = new URL(origin).host;
        await setDataset({ title: `${host} — ${cfg.collection || 'all products'}`, url: origin, source: 'Shopify Extractor', sheets: [makeSheet(cfg.format === 'shopify-csv' ? 'Shopify import' : 'Products', rows)] });
        const note = products.capped ? ` Free plan stops at ${plan.limits.shopifyProducts} products — upgrade for the full catalogue.` : products.partial ? ` Stopped early: ${products.partial}.` : '';
        toast(`Exported ${plural(products.length, 'product')} (${plural(rows.length, 'row')}).${note}`, note ? '' : 'ok');
        ctx.go('table');
      });
    }

    if (ctx.autoRun) setTimeout(run, 50);
    return h('div', { class: 'stack' },
      card('Store', h('div', { class: 'row' }, store, h('button', { type: 'button', class: 'btn secondary', onclick: check }, 'Check')), status,
        h('label', { class: 'field' }, 'Collection', collection)),
      card('Format', format.el),
      actions(primary('Export products', run), secondary('Save recipe', () => ctx.saveRecipe(ctx.tool, getConfig()))));
  },
};
