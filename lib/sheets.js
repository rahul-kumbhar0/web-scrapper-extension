// Google Sheets export via chrome.identity. Needs a real OAuth client ID in manifest.json
// (see README → "Google Sheets setup").

import { columnsOf } from './export.js';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export function sheetsConfigured() {
  const id = chrome.runtime.getManifest().oauth2?.client_id || '';
  return id && !id.startsWith('YOUR_');
}

async function getToken() {
  const res = await chrome.identity.getAuthToken({ interactive: true });
  const token = typeof res === 'string' ? res : res?.token;
  if (!token) throw new Error('Google sign-in was cancelled.');
  return token;
}

async function api(token, url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Sheets error ${res.status}: ${json?.error?.message || res.statusText}`);
  return json;
}

// sheets: [{ name, rows }] → returns the new spreadsheet URL
export async function exportToSheets(title, sheets) {
  if (!sheetsConfigured()) {
    throw new Error('Google Sheets is not set up yet: add your OAuth client ID to manifest.json (see README).');
  }
  const token = await getToken();
  const doc = await api(token, SHEETS_API, 'POST', {
    properties: { title },
    sheets: sheets.map((s) => ({ properties: { title: s.name.slice(0, 100) } })),
  });
  await api(token, `${SHEETS_API}/${doc.spreadsheetId}/values:batchUpdate`, 'POST', {
    valueInputOption: 'RAW',
    data: sheets.map((s) => {
      const cols = columnsOf(s.rows);
      return {
        range: `'${s.name.slice(0, 100).replace(/'/g, "''")}'!A1`,
        values: [cols, ...s.rows.map((r) => cols.map((c) => String(r[c] ?? '')))],
      };
    }),
  });
  return doc.spreadsheetUrl;
}
