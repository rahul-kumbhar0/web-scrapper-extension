// RECIPES — saved tool setups that re-run in one click; export/import to share them.
import { h, fill, toast, confirmDialog, formDialog } from '../ui.js';
import { getRecipes, deleteRecipe, saveRecipe, importRecipes } from '../../lib/storage.js';
import { download } from '../../lib/export.js';

const TOOL_NAMES = { list: 'List Extractor', page: 'Page Extractor', email: 'Email Extractor', social: 'Social Link Extractor', images: 'Image Downloader', shopify: 'Shopify Extractor', sitemap: 'Sitemap Explorer', text: 'Page Text Extractor', quick: 'Quick Scan', ai: 'AI Extract' };

export default {
  id: 'recipes',
  title: 'Recipes',
  icon: '★',
  render(ctx) {
    const list = h('ul', { class: 'item-list' });
    const file = h('input', { type: 'file', accept: '.json', hidden: true, onchange: async () => {
      try {
        const data = JSON.parse(await file.files[0].text());
        await importRecipes(Array.isArray(data) ? data : [data]);
        toast('Recipes imported.', 'ok');
        render();
      } catch (e) { toast(`Could not import: ${e.message}`, 'error'); }
      file.value = '';
    } });

    async function render() {
      const recipes = await getRecipes();
      if (!recipes.length) {
        fill(list, h('li', { class: 'empty' }, 'No recipes yet. In any tool, set it up and click “Save recipe” to run it again later in one click.'));
        return;
      }
      fill(list, ...recipes.map((r) => h('li', {},
        h('div', { class: 'title' }, r.name),
        h('div', { class: 'meta' }, `${TOOL_NAMES[r.tool] || r.tool}${r.url ? ' · ' + r.url : ''}`),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn tiny primary', onclick: () => ctx.runRecipe(r) }, '▶ Run'),
          h('button', { type: 'button', class: 'link-btn', onclick: () => ctx.go(r.tool, { preset: r.config }) }, 'Open'),
          h('button', { type: 'button', class: 'link-btn', onclick: async () => {
            const res = await formDialog({ title: 'Rename recipe', fields: [{ name: 'name', label: 'Name', value: r.name }, { name: 'url', label: 'Start page', value: r.url || '' }] });
            if (res) { await saveRecipe({ ...r, name: res.name, url: res.url }); render(); }
          } }, 'Edit'),
          h('button', { type: 'button', class: 'link-btn', onclick: () => download(JSON.stringify(r, null, 2), `${r.name.replace(/[^\w-]+/g, '-')}.recipe.json`, 'application/json') }, 'Export'),
          h('button', { type: 'button', class: 'link-btn danger', onclick: async () => { if (await confirmDialog('Delete recipe?', r.name)) { await deleteRecipe(r.id); render(); } } }, 'Delete')))));
    }

    render();
    return h('div', { class: 'stack' },
      h('div', { class: 'row' },
        h('p', { class: 'hint grow' }, 'Saved setups for any tool. Share them as .json files.'),
        h('button', { type: 'button', class: 'btn tiny', onclick: () => file.click() }, 'Import'),
        h('button', { type: 'button', class: 'btn tiny', onclick: async () => download(JSON.stringify(await getRecipes(), null, 2), 'recipes.json', 'application/json') }, 'Export all')),
      list, file);
  },
};
