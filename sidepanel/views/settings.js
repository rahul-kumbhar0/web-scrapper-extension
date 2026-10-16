// SETTINGS — Claude connector (MCP) with safety controls, Claude API key + model, crawl
// politeness, plan, and about.
import { h, fill, toast, confirmDialog, formDialog } from '../ui.js';
import { MODELS, saveSettings, newToken, clearHistory } from '../../lib/storage.js';
import { DEFAULT_BLOCKED } from '../../lib/guard.js';
import { DEFAULT_RELAY, LINKS, SUPPORT_EMAIL } from '../../lib/config.js';
import { card } from '../widgets.js';
import { icon } from '../icons.js';
import { plan } from '../plan.js';

const STATE_LABEL = {
  off: ['Off', ''],
  connecting: ['Connecting…', ''],
  connected: ['Connected — Claude can use PullRows in this browser', 'ok'],
  error: ['Not connected', 'error'],
};

// The MCP link carries a hash of the secret, never the secret itself (the relay derives the
// same id from the secret the extension polls with — see server/mcp-relay.mjs).
export async function connectorId(token) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
}

const isLocal = (u) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(u);
const open = (url) => chrome.tabs.create({ url });

const CONSENT_TEXT = `When the Claude connector is on, Claude (through your Claude account) can:
• open pages in new tabs and read them — including sites where you are logged in
• take screenshots of tabs and run PullRows tools on them
• read the PullRows Data Table and your saved recipes

Tool calls and their results (page content, tab titles and URLs, screenshots) pass through the PullRows relay server, which does not store them, and are sent to Anthropic as part of your Claude conversation.

Email, banking, password-manager and local-network pages are blocked. Clicking, typing and downloads stay off until you allow them below. You can turn the connector off at any time.`;

const sw = (label, input, hint) => h('label', { class: 'switch' }, input, h('span', { class: 'grow' }, h('strong', {}, label), hint ? h('span', { class: 'muted small block' }, hint) : null));

export default {
  id: 'settings',
  title: 'Settings',
  icon: '⚙',
  render(ctx) {
    const s = ctx.settings;
    const mcp = { ...s.mcp };

    // ---------- Claude connector ----------
    const enabled = h('input', { id: 'mcp-enabled', type: 'checkbox', checked: !!(mcp.enabled && mcp.consentAt), role: 'switch' });
    const server = h('input', { id: 'mcp-server', value: mcp.server, placeholder: DEFAULT_RELAY, spellcheck: false });
    const link = h('input', { id: 'mcp-link', readOnly: true, spellcheck: false });
    const actions = h('input', { id: 'mcp-actions', type: 'checkbox', checked: !!mcp.allowActions, role: 'switch' });
    const downloads = h('input', { id: 'mcp-downloads', type: 'checkbox', checked: !!mcp.allowDownloads, role: 'switch' });
    const local = h('input', { id: 'mcp-local', type: 'checkbox', checked: !!mcp.allowLocal, role: 'switch' });
    const blocked = h('textarea', { id: 'mcp-blocked', rows: 4, spellcheck: false, value: (mcp.blocked || DEFAULT_BLOCKED).join('\n') });
    const statusEl = h('p', { id: 'mcp-status', class: 'hint' });
    const logEl = h('ul', { class: 'mini-log' });

    const serverUrl = () => (server.value.trim() || DEFAULT_RELAY).replace(/\/+$/, '');
    let linkValue = '';
    async function updateLink() {
      linkValue = mcp.token ? `${serverUrl()}/mcp/${await connectorId(mcp.token)}` : '';
      link.value = linkValue || '—';
      syncGuide?.();
    }

    async function saveMcp(patch = {}) {
      Object.assign(mcp, patch, {
        server: serverUrl(),
        allowActions: actions.checked,
        allowDownloads: downloads.checked,
        allowLocal: local.checked,
        blocked: blocked.value.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean),
      });
      if (!/^https:\/\/\S+$/.test(mcp.server) && !isLocal(mcp.server)) {
        toast('The relay server must be an https:// address.', 'error');
        mcp.enabled = false;
        enabled.checked = false;
      }
      await saveSettings({ mcp: { ...mcp } });
      await ctx.reloadSettings();
      await updateLink();
    }

    enabled.addEventListener('change', async () => {
      if (enabled.checked && !mcp.consentAt) {
        const ok = await formDialog({ title: 'Let Claude use PullRows in this browser?', text: CONSENT_TEXT, submit: 'Turn on' });
        if (!ok) { enabled.checked = false; return; }
        mcp.consentAt = Date.now();
      }
      mcp.enabled = enabled.checked;
      await saveMcp();
      toast(mcp.enabled ? 'Claude connector on — follow the steps below to add it to Claude.' : 'Claude connector off.', 'ok');
      renderStatus();
      syncGuide();
    });
    for (const el of [server, actions, downloads, local, blocked]) el.addEventListener('change', () => saveMcp());

    async function renderStatus() {
      const { mcpStatus, mcpLog = [] } = await chrome.storage.local.get(['mcpStatus', 'mcpLog']);
      const st = mcp.enabled && mcp.consentAt ? (mcpStatus?.state || 'connecting') : 'off';
      const [label, cls] = STATE_LABEL[st] || [st, ''];
      statusEl.className = `hint ${cls}`;
      fill(statusEl, h('span', { class: `status-dot ${st === 'connected' ? 'on' : ''}` }), `${label}${st === 'error' && mcpStatus?.error ? ` — ${mcpStatus.error}` : ''}`);
      fill(logEl, mcpLog.slice(0, 10).map((e) => h('li', { class: e.ok ? '' : 'error', title: e.args || '' },
        h('span', { class: 'muted' }, new Date(e.at).toLocaleTimeString()), ` ${e.ok ? '✓' : '✗'} ${e.tool} `, h('span', { class: 'muted' }, `${(e.ms / 1000).toFixed(1)}s`))));
    }
    renderStatus();
    const onStorage = (changes, area) => { if (area === 'local' && (changes.mcpStatus || changes.mcpLog)) renderStatus(); };
    chrome.storage.onChanged.addListener(onStorage);

    // First run: make sure a secret exists.
    if (!mcp.token) saveMcp({ token: newToken() }); else updateLink();

    // Step-by-step: how to add this browser's link to Claude.
    const cmd = () => `claude mcp add --transport http pullrows ${linkValue}`;
    const copy = async (text, msg) => { await navigator.clipboard.writeText(text); toast(msg, 'ok'); };
    const guide = h('ol', { class: 'connect-steps', id: 'connect-steps' },
      h('li', {}, h('strong', {}, 'Copy your link'), h('span', { class: 'muted small block' }, 'The Copy button above.')),
      h('li', {}, h('strong', {}, 'Add it in Claude'),
        h('span', { class: 'muted small block' }, 'claude.ai or Claude Desktop → Settings → Connectors → Add custom connector → paste → Add. Then switch PullRows on in a chat’s tools menu.'),
        h('div', { class: 'row wrap' },
          h('button', { type: 'button', class: 'btn tiny primary', onclick: () => { if (linkValue) copy(linkValue, 'Link copied — paste it in Claude.'); open('https://claude.ai/settings/connectors'); } }, 'Copy link & open Claude'))),
      h('li', {}, h('strong', {}, 'Using Claude Code?'),
        h('span', { class: 'muted small block' }, 'Run this once in your terminal:'),
        h('div', { class: 'row' }, h('code', { class: 'selector grow', id: 'connect-cmd' }, 'claude mcp add --transport http pullrows <your link>'),
          h('button', { type: 'button', class: 'btn tiny', onclick: () => linkValue && copy(cmd(), 'Command copied.') }, 'Copy'))),
      h('li', {}, h('strong', {}, 'Try it'), h('span', { class: 'muted small block' }, 'Ask Claude: “Use PullRows to list my open tabs.” The call shows up under Recent Claude activity below.')));
    const syncGuide = () => {
      guide.hidden = !(mcp.enabled && mcp.consentAt);
      const c = guide.querySelector('#connect-cmd');
      if (c && linkValue) c.textContent = cmd();
    };

    const connector = card('Claude connector',
      h('p', { class: 'hint' }, 'Let Claude run PullRows for you: it opens pages, extracts lists, finds emails… in this Chrome, and results land in your Data Table. Works with claude.ai, Claude Desktop and Claude Code.'),
      sw('Allow Claude to use this browser', enabled),
      statusEl,
      h('label', { class: 'field' }, 'Your private connector link',
        h('div', { class: 'row' }, link,
          h('button', { type: 'button', class: 'btn secondary', onclick: async () => {
            if (!linkValue) return;
            await navigator.clipboard.writeText(linkValue);
            toast('Connector link copied — paste it in Claude → Settings → Connectors → Add custom connector.', 'ok');
          } }, 'Copy'))),
      h('div', { class: 'notice' }, icon('lock', { size: 15 }), h('span', {}, 'Treat this link like a password: anyone who has it can use PullRows in this browser while the connector is on. ', h('button', { type: 'button', class: 'link-btn', onclick: () => open(LINKS.connectorDocs) }, 'Setup guide'))),
      guide,
      h('div', { class: 'section-label' }, 'Safety'),
      sw('Allow actions', actions, 'Claude may click buttons and type into forms. Off: read-only.'),
      sw('Allow downloads', downloads, 'Claude may save images to Downloads/pullrows.'),
      h('label', { class: 'field' }, 'Blocked sites (Claude can never open or read these)', blocked),
      h('p', { class: 'hint' }, 'Banking/wallet sites and local-network addresses are always blocked.'),
      h('details', {},
        h('summary', { class: 'muted small' }, 'Advanced'),
        h('div', { class: 'stack', style: 'margin-top:8px' },
          sw('Allow local network', local, 'For developers testing on localhost.'),
          h('div', { class: 'row wrap' },
            h('button', { type: 'button', class: 'btn tiny', onclick: async () => {
              if (!(await confirmDialog('New connector link?', 'The old link stops working immediately; update the connector in Claude with the new one.', 'Generate new link'))) return;
              await saveMcp({ token: newToken() });
              toast('New link generated — update it in Claude.', 'ok');
            } }, 'Generate new link'),
            h('button', { type: 'button', class: 'btn tiny', onclick: async () => { mcp.consentAt = 0; mcp.enabled = false; enabled.checked = false; await saveMcp(); renderStatus(); toast('Connector off and permission withdrawn.', 'ok'); } }, 'Withdraw permission')))),
      h('label', { class: 'field' }, 'Relay server', server),
      h('div', { class: 'section-label' }, 'Recent Claude activity'),
      logEl);

    // ---------- Claude API (in-extension AI features) ----------
    const key = h('input', { id: 'api-key', type: 'password', value: s.apiKey, placeholder: 'sk-ant-…', autocomplete: 'off', spellcheck: false });
    const model = h('select', { id: 'model' }, MODELS.map((m) => h('option', { value: m.id, selected: m.id === s.model }, m.label)));
    const delay = h('input', { id: 'delay', type: 'number', min: 0, max: 60000, step: 250, value: s.delayMs });
    const conc = h('input', { id: 'concurrency', type: 'number', min: 1, max: 12, value: s.concurrency });

    async function save() {
      await saveSettings({ apiKey: key.value.trim(), model: model.value, delayMs: Math.max(0, Number(delay.value) || 0), concurrency: Math.min(12, Math.max(1, Number(conc.value) || 3)) });
      await ctx.reloadSettings();
      toast('Settings saved.', 'ok');
    }

    const v = chrome.runtime.getManifest().version;
    return {
      el: h('div', { class: 'stack' },
        h('button', { type: 'button', class: 'connector-card', onclick: () => ctx.go('upgrade') },
          h('span', { class: 'icon', style: 'background:var(--accent-soft);color:var(--accent-ink)' }, icon('crown', { size: 18 })),
          h('span', { class: 'grow' }, h('strong', {}, plan.license.trial ? 'Pro trial' : plan.pro ? 'PullRows Pro' : 'Free plan'), h('span', { class: 'muted small block' }, plan.license.trial ? 'Buy Pro to keep it after the trial' : plan.pro ? 'Manage your licence' : 'Try Pro free, upgrade or activate a key')),
          icon('chevron', { size: 16 })),
        connector,
        card('AI features in the side panel',
          h('label', { class: 'field' }, 'Anthropic API key',
            h('div', { class: 'row' }, key, h('button', { type: 'button', class: 'btn secondary', onclick: (e) => { key.type = key.type === 'password' ? 'text' : 'password'; e.target.textContent = key.type === 'password' ? 'Show' : 'Hide'; } }, 'Show'))),
          h('p', { class: 'hint' }, 'For AI Extract, AI columns and Ask Claude (not needed for the Claude connector). Stored only in this browser and sent only to Anthropic.'),
          h('label', { class: 'field' }, 'Model', model)),
        card('Crawling',
          h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Delay between pages (ms)', delay), h('label', { class: 'field grow' }, 'Parallel requests', conc)),
          h('p', { class: 'hint' }, 'Be polite: keep a delay and a low parallel count on small sites.')),
        h('button', { id: 'save-settings', type: 'button', class: 'btn primary', onclick: save }, 'Save settings'),
        card('Privacy & data',
          h('p', { class: 'hint' }, 'Scraped data, history and recipes stay in this browser. PullRows has no analytics and no account.'),
          h('div', { class: 'row wrap' },
            h('button', { type: 'button', class: 'btn tiny', onclick: async () => { if (await confirmDialog('Clear history?', 'Removes the last 30 saved results from this browser.', 'Clear history')) { await clearHistory(); toast('History cleared.', 'ok'); } } }, 'Clear history'),
            h('button', { type: 'button', class: 'btn tiny', onclick: () => open(LINKS.privacy) }, 'Privacy policy'),
            h('button', { type: 'button', class: 'btn tiny', onclick: () => open(LINKS.terms) }, 'Terms'))),
        card('About',
          h('p', { class: 'hint' }, `PullRows v${v} · `, h('button', { type: 'button', class: 'link-btn', onclick: () => open(LINKS.changelog) }, 'What’s new'), ' · ', h('button', { type: 'button', class: 'link-btn', onclick: () => open(LINKS.docs) }, 'Docs'), ' · ', h('button', { type: 'button', class: 'link-btn', onclick: () => open(`mailto:${SUPPORT_EMAIL}`) }, 'Support')),
          h('p', { class: 'hint' }, 'Use PullRows responsibly: respect each website’s terms and privacy laws (GDPR, CAN-SPAM…) when collecting contact details.'))),
      cleanup: () => chrome.storage.onChanged.removeListener(onStorage),
    };
  },
};
