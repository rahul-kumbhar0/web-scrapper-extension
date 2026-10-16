// Point-and-click picker: start it in the active tab and await the element the user clicks.
import { toast } from './ui.js';
import { getActiveTab, callInTab } from '../lib/tab.js';

const waiters = new Set();

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'PICKER_RESULT' || sender.id !== chrome.runtime.id || !sender.tab) return;
  for (const w of [...waiters]) w(msg, sender.tab.id);
});

// Switching tabs while picking cancels the pick (and leaves the old page usable).
chrome.tabs.onActivated.addListener(() => { for (const w of [...waiters]) w({ cancelled: true, any: true }); });

const HINTS = {
  list: 'Click one item of the list on the page…',
  field: 'Click the element on the page to extract…',
  element: 'Click the button on the page…',
  selector: 'Click an element on the page…',
};

// Resolves with the picker result, or null if cancelled/failed.
export async function pick(mode) {
  const tab = await getActiveTab();
  const result = new Promise((resolve) => {
    const w = (msg, fromTab) => {
      if (msg.any || (msg.mode === mode && fromTab === tab.id)) { waiters.delete(w); resolve(msg); }
    };
    waiters.add(w);
  });
  await callInTab(tab.id, 'startPicker', mode);
  toast(`${HINTS[mode]} (Esc to cancel)`, '', true);
  const msg = await result;
  toast('');
  if (msg.any) callInTab(tab.id, 'stopPicker').catch(() => {});
  if (msg.cancelled) return null;
  if (msg.error) { toast(msg.error, 'error'); return null; }
  return msg;
}
