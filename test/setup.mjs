// Shared test setup: give the test browser a Pro licence (no plan limits) and the settings the
// fixture server needs (it runs on 127.0.0.1, which the Claude connector blocks by default).
// Runs in a throwaway extension page (service-worker handles don't always expose chrome.* APIs).
export async function prepareExtension(ctx, sw, { pro = true, mcp = {}, settings = {} } = {}) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/onboarding/welcome.html`);
  await page.evaluate(async ({ pro, mcp, settings }) => {
    // Wait for onInstalled to create the connector secret, so we don't race it.
    for (let i = 0; i < 50; i++) {
      const { settings: s } = await chrome.storage.local.get('settings');
      if (s?.mcp?.token) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const { settings: s = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...s, aiConsentAt: Date.now(), ...settings, mcp: { ...(s.mcp || {}), ...mcp } },
      license: pro ? { plan: 'pro', key: 'TEST-LICENSE-KEY', instanceId: 'lki_test', activatedAt: Date.now(), validatedAt: Date.now(), status: 'active' } : { plan: 'free' },
    });
  }, { pro, mcp, settings });
  await page.close();
}

// Turn the Claude connector on in Settings (accepting the consent dialog) and return the MCP link.
export async function enableConnector(sp, relay) {
  await sp.getByRole('button', { name: /Settings/ }).click();
  await sp.fill('#mcp-server', relay);
  await sp.locator('#mcp-server').dispatchEvent('change');
  await sp.locator('#mcp-enabled').click();
  await sp.locator('dialog[open]').getByRole('button', { name: 'Turn on' }).click();
  await sp.waitForFunction(() => /Connected/.test(document.getElementById('mcp-status').textContent), null, { timeout: 20000 });
  await sp.waitForFunction(() => /\/mcp\/[\w-]{32}$/.test(document.getElementById('mcp-link').value), null, { timeout: 5000 });
  return sp.inputValue('#mcp-link');
}
