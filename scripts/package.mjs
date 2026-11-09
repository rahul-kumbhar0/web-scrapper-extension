#!/usr/bin/env node
// Builds the Chrome Web Store upload: dist/pullrows-<version>.zip containing ONLY the files the
// extension needs, then verifies the zip against an allow-list.
//
// The archive is written here rather than shelled out to `zip`, which does not exist on a stock
// Windows machine; this keeps `npm run package` working on every platform the extension is
// developed on, and makes the bytes reproducible (fixed timestamps, sorted entries).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// _locales must ship: manifest.json sets "default_locale", so Chrome refuses to load the
// extension if the messages file named by every __MSG_*__ placeholder is not in the package.
const SHIP = ['manifest.json', 'background.js', '_locales', 'content', 'lib', 'sidepanel', 'offscreen', 'onboarding', 'icons'];
const ALLOWED = /^(manifest\.json|background\.js|_locales\/[a-z]{2}(_[A-Z]{2})?\/messages\.json|(content|lib|sidepanel|offscreen|onboarding|icons)\/.+\.(js|html|css|png|svg))$/;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`manifest.json ${manifest.version} ≠ package.json ${pkg.version}`);

// Collect the files to ship, as forward-slash paths relative to ROOT.
const entries = [];
const add = (rel) => {
  const abs = path.join(ROOT, rel);
  if (fs.statSync(abs).isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) add(`${rel}/${name}`);
  } else if (!path.basename(rel).startsWith('.') && path.basename(rel) !== '.DS_Store') {
    entries.push(rel);
  }
};
for (const top of SHIP) add(top);
entries.sort();

// No remote code, ever (Chrome Web Store policy).
for (const rel of entries) {
  if (!/\.(js|html)$/.test(rel)) continue;
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (/\beval\s*\(|new Function\s*\(|<script[^>]+src=["']https?:/.test(src)) throw new Error(`Remote/dynamic code in ${rel}`);
}

// Every file must be one the allow-list expects, checked before anything is written.
const bad = entries.filter((f) => !ALLOWED.test(f));
if (bad.length) throw new Error(`Unexpected files in the package:\n${bad.join('\n')}`);

// Every __MSG_name__ the manifest uses must exist in the default locale, or Chrome rejects the
// upload with a message that does not name the key.
if (manifest.default_locale) {
  const msgPath = `_locales/${manifest.default_locale}/messages.json`;
  if (!entries.includes(msgPath)) throw new Error(`default_locale is "${manifest.default_locale}" but ${msgPath} is not in the package`);
  const messages = JSON.parse(fs.readFileSync(path.join(ROOT, msgPath), 'utf8'));
  for (const [, key] of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
    if (!messages[key]) throw new Error(`manifest.json uses __MSG_${key}__ but ${msgPath} has no such message`);
  }
}

// ---- minimal zip writer (deflate, no external tools) ----
const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
// A fixed DOS timestamp (1 Jan 2020, 00:00) so rebuilding the same sources gives the same bytes.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

const locals = [];
const central = [];
let offset = 0;
for (const rel of entries) {
  const name = Buffer.from(rel, 'utf8');
  const raw = fs.readFileSync(path.join(ROOT, rel));
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  // Store the file uncompressed when deflating made it bigger (tiny icons, short JSON).
  const useDeflate = deflated.length < raw.length;
  const body = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, body);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4); // version made by
  cen.writeUInt16LE(20, 6); // version needed
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(method, 10);
  cen.writeUInt16LE(DOS_TIME, 12);
  cen.writeUInt16LE(DOS_DATE, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(body.length, 20);
  cen.writeUInt32LE(raw.length, 24);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(0, 38); // external attributes
  cen.writeUInt32LE(offset, 42);
  central.push(cen, name);

  offset += local.length + name.length + body.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);

const out = path.join(ROOT, 'dist', `pullrows-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([...locals, centralBuf, eocd]));

console.log(`${path.relative(ROOT, out)} · ${entries.length} files · ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
