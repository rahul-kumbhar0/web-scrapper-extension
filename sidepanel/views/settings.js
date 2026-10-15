// SETTINGS — Claude API key + model, crawl politeness, Google Sheets status.
import { h, toast } from '../ui.js';
import { MODELS, saveSettings } from '../../lib/storage.js';
import { sheetsConfigured } from '../../lib/sheets.js';
import { card } from '../widgets.js';

export default {
  id: 'settings',
  title: 'Settings',
  icon: '⚙',
  render(ctx) {
    const s = ctx.settings;
    const key = h('input', { id: 'api-key', type: 'password', value: s.apiKey, placeholder: 'sk-ant-…', autocomplete: 'off', spellcheck: false });
    const model = h('select', { id: 'model' }, MODELS.map((m) => h('option', { value: m.id, selected: m.id === s.model }, m.label)));
    const delay = h('input', { id: 'delay', type: 'number', min: 0, max: 60000, step: 250, value: s.delayMs });
    const conc = h('input', { id: 'concurrency', type: 'number', min: 1, max: 12, value: s.concurrency });

    async function save() {
      await saveSettings({ apiKey: key.value.trim(), model: model.value, delayMs: Math.max(0, Number(delay.value) || 0), concurrency: Math.max(1, Number(conc.value) || 3) });
      await ctx.reloadSettings();
      toast('Settings saved.', 'ok');
    }

    return h('div', { class: 'stack' },
      card('Claude AI',
        h('label', { class: 'field' }, 'Anthropic API key',
          h('div', { class: 'row' }, key, h('button', { type: 'button', class: 'btn secondary', onclick: (e) => { key.type = key.type === 'password' ? 'text' : 'password'; e.target.textContent = key.type === 'password' ? 'Show' : 'Hide'; } }, 'Show'))),
        h('p', { class: 'hint' }, 'Create one at console.anthropic.com → API keys. It is stored only in this browser and sent only to api.anthropic.com.'),
        h('label', { class: 'field' }, 'Model', model),
        h('p', { class: 'hint' }, 'Used by AI Extract, AI columns and Ask Claude.')),
      card('Crawling',
        h('label', { class: 'field' }, 'Delay between pages (ms)', delay),
        h('label', { class: 'field' }, 'Parallel requests', conc),
        h('p', { class: 'hint' }, 'Be polite: keep a delay and a low parallel count on small sites.')),
      card('Google Sheets', h('p', { class: 'hint' }, sheetsConfigured()
        ? '✓ Ready — you will be asked to sign in with Google on first export.'
        : 'Not set up: add your Google OAuth client ID to manifest.json (see README). CSV, Excel and JSON work without it.')),
      h('button', { id: 'save-settings', type: 'button', class: 'btn primary', onclick: save }, 'Save settings'));
  },
};
