// GOOGLE SHEETS — rows go to the user's own Google Sheet through a tiny Apps Script web app they
// deploy once (Extensions → Apps Script in the sheet). No Google sign-in or OAuth scopes in the
// extension; the script URL is the only thing stored. Each push appends to a tab named after the
// source (created on first use, header row kept in sync with new columns).
import { neutralise } from './export.js';

export const APPS_SCRIPT = `// PullRows → Google Sheets. Paste into Extensions → Apps Script, then Deploy → New deployment →
// Web app, Execute as: Me, Who has access: Anyone. Copy the /exec URL into PullRows Settings.
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var rows = body.rows || [];
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var name = String(body.sheet || 'PullRows').replace(/[\\[\\]\\*\\?\\/\\\\:]/g, ' ').slice(0, 90);
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var head = sh.getLastRow() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
    rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (head.indexOf(k) < 0) head.push(k); }); });
    if (head.length) sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    if (rows.length) {
      var stamp = new Date();
      var values = rows.map(function (r) { return head.map(function (k) { return k === 'synced_at' ? stamp : (r[k] == null ? '' : r[k]); }); });
      sh.getRange(sh.getLastRow() + 1, 1, values.length, head.length).setValues(values);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, rows: rows.length, sheet: name, url: ss.getUrl() })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) })).setMimeType(ContentService.MimeType.JSON);
  }
}`;

export const isSheetUrl = (u) => /^https:\/\/script\.google\.com\/macros\/s\/[\w-]{20,}\/exec\/?$/.test(String(u || '').trim());

// Cells Google Sheets accepts: strings/numbers/booleans; long text trimmed to the 50k cell limit.
export function sheetRows(rows, cols) {
  const keys = cols || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return rows.map((r) => Object.fromEntries([...keys.map((k) => {
    let v = r[k];
    if (v != null && typeof v === 'object') v = JSON.stringify(v);
    if (typeof v === 'string') v = neutralise(v.length > 49000 ? v.slice(0, 49000) : v); // scraped "=IMPORTXML(…)" must not run
    return [k, v ?? ''];
  }), ['synced_at', '']]));
}
