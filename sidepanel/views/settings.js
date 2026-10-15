// SETTINGS — Claude connector (MCP), Claude API key + model, crawl politeness, Google Sheets status.
import { h, fill, toast, confirmDialog } from '../ui.js';
import { MODELS, saveSettings, newToken } from '../../lib/storage.js';
import { sheetsConfigured } from '../../lib/sheets.js';
import { card } from '../widgets.js';

const STATE_LABEL = {
  off: ['Off', ''],
  connecting: ['Connecting…', ''],
  connected: ['Connected — Claude can use this browser', 'ok'],
  error: ['Not connected', 'error'],
};

export default {
  id: 'settings',
  title: 'Settings',
  icon: '⚙',
  render(ctx) {
    const s = ctx.settings;
    const mcp = { enabled: false, server: '', token: '', ...s.mcp };

    // ---------- Claude connector ----------
    const enabled = h('input', { id: 'mcp-enabled', type: 'checkbox', checked: mcp.enabled });
    const server = h('input', { id: 'mcp-server', value: mcp.server, placeholder: 'https://your-relay.onrender.com', spellcheck: false });
    const link = h('input', { id: 'mcp-link', readOnly: true, spellcheck: false });
    const statusEl = h('p', { id: 'mcp-status', class: 'hint' });
    const logEl = h('ul', { class: 'mini-log' });

    const linkFor = () => (server.value.trim() ? `${server.value.trim().replace(/\/+$/, '')}/mcp/${mcp.token}` : '');
    const updateLink = () => { link.value = linkFor() || '— enter your relay server address first —'; };
    updateLink();
    server.addEventListener('input', updateLink);

    async function saveMcp(patch = {}) {
      Object.assign(mcp, patch, { server: server.value.trim().replace(/\/+$/, ''), enabled: enabled.checked });
      if (mcp.enabled && !/^https?:\/\/\S+$/.test(mcp.server)) { toast('Enter the relay server address (https://…).', 'error'); enabled.checked = false; mcp.enabled = false; }
      await saveSettings({ mcp: { ...mcp } });
      await ctx.reloadSettings();
      updateLink();
    }
    enabled.addEventListener('change', () => saveMcp().then(() => toast(mcp.enabled ? 'Claude connector on.' : 'Claude connector off.', 'ok')));
    server.addEventListener('change', () => saveMcp());

    async function renderStatus() {
      const { mcpStatus, mcpLog = [] } = await chrome.storage.local.get(['mcpStatus', 'mcpLog']);
      const st = mcp.enabled ? (mcpStatus?.state || 'connecting') : 'off';
      const [label, cls] = STATE_LABEL[st] || [st, ''];
      statusEl.className = `hint ${cls}`;
      statusEl.textContent = `● ${label}${st === 'error' && mcpStatus?.error ? ` — ${mcpStatus.error}` : ''}`;
      fill(logEl, mcpLog.slice(0, 8).map((e) => h('li', { class: e.ok ? '' : 'error' },
        h('span', { class: 'muted' }, new Date(e.at).toLocaleTimeString()), ` ${e.ok ? '✓' : '✗'} ${e.tool} `, h('span', { class: 'muted' }, `${(e.ms / 1000).toFixed(1)}s`))));
    }
    renderStatus();
    const onStorage = (changes, area) => { if (area === 'local' && (changes.mcpStatus || changes.mcpLog)) renderStatus(); };
    chrome.storage.onChanged.addListener(onStorage);

    const connector = card('Claude connector (MCP)',
      h('p', { class: 'hint' }, 'Let Claude control this scraper: Claude calls the tools (open pages, extract lists, find emails…), the work runs here in your Chrome, and results land in the Data Table.'),
      h('label', { class: 'check' }, enabled, h('strong', {}, 'Allow Claude to use this browser')),
      statusEl,
      h('label', { class: 'field' }, 'Relay server', server),
      h('label', { class: 'field' }, 'Your MCP link — add it in Claude → Settings → Connectors → Add custom connector',
        h('div', { class: 'row' }, link,
          h('button', { type: 'button', class: 'btn secondary', onclick: async () => {
            if (!linkFor()) { toast('Enter the relay server address first.', 'error'); return; }
            await navigator.clipboard.writeText(linkFor());
            toast('MCP link copied.', 'ok');
          } }, 'Copy'))),
      h('p', { class: 'hint' }, '⚠ The link contains a secret — anyone who has it can drive this scraper. Don’t share it.'),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'btn tiny', onclick: async () => {
          if (!(await confirmDialog('New secret link?', 'The old MCP link stops working; you will need to update the connector in Claude.', 'Generate new link'))) return;
          await saveMcp({ token: newToken() });
          toast('New link generated — update it in Claude.', 'ok');
        } }, 'Generate new link'),
        h('a', { class: 'link-btn', href: 'https://github.com/rahul-kumbhar0/web-scrapper-extension#claude-connector-mcp', target: '_blank' }, 'Setup guide')),
      h('div', { class: 'muted small' }, 'Recent Claude activity'),
      logEl);

    // ---------- Claude API (in-extension AI features) ----------
    const key = h('input', { id: 'api-key', type: 'password', value: s.apiKey, placeholder: 'sk-ant-…', autocomplete: 'off', spellcheck: false });
    const model = h('select', { id: 'model' }, MODELS.map((m) => h('option', { value: m.id, selected: m.id === s.model }, m.label)));
    const delay = h('input', { id: 'delay', type: 'number', min: 0, max: 60000, step: 250, value: s.delayMs });
    const conc = h('input', { id: 'concurrency', type: 'number', min: 1, max: 12, value: s.concurrency });

    async function save() {
      await saveSettings({ apiKey: key.value.trim(), model: model.value, delayMs: Math.max(0, Number(delay.value) || 0), concurrency: Math.max(1, Number(conc.value) || 3) });
      await ctx.reloadSettings();
      toast('Settings saved.', 'ok');
    }

    // First run: make sure a secret exists.
    if (!mcp.token) saveMcp({ token: newToken() });

    return {
      el: h('div', { class: 'stack' },
        connector,
        card('AI features inside the extension',
          h('label', { class: 'field' }, 'Anthropic API key',
            h('div', { class: 'row' }, key, h('button', { type: 'button', class: 'btn secondary', onclick: (e) => { key.type = key.type === 'password' ? 'text' : 'password'; e.target.textContent = key.type === 'password' ? 'Show' : 'Hide'; } }, 'Show'))),
          h('p', { class: 'hint' }, 'For AI Extract, AI columns and Ask Claude in the side panel (not needed for the Claude connector). Stored only in this browser.'),
          h('label', { class: 'field' }, 'Model', model)),
        card('Crawling',
          h('label', { class: 'field' }, 'Delay between pages (ms)', delay),
          h('label', { class: 'field' }, 'Parallel requests', conc),
          h('p', { class: 'hint' }, 'Be polite: keep a delay and a low parallel count on small sites.')),
        card('Google Sheets', h('p', { class: 'hint' }, sheetsConfigured()
          ? '✓ Ready — you will be asked to sign in with Google on first export.'
          : 'Not set up: add your Google OAuth client ID to manifest.json (see README). CSV, Excel and JSON work without it.')),
        h('button', { id: 'save-settings', type: 'button', class: 'btn primary', onclick: save }, 'Save settings')),
      cleanup: () => chrome.storage.onChanged.removeListener(onStorage),
    };
  },
};
