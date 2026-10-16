import { LINKS, SITE_URL } from '../lib/config.js';

document.getElementById('docs').href = LINKS.docs;
document.getElementById('privacy').href = LINKS.privacy;
document.getElementById('pricing').href = LINKS.pricing;
document.getElementById('try').href = 'https://books.toscrape.com/';

document.getElementById('open-panel').addEventListener('click', async () => {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch {
    window.open(SITE_URL + '/docs', '_blank');
  }
});
