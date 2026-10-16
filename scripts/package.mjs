#!/usr/bin/env node
// Builds the Chrome Web Store upload: dist/pullrows-<version>.zip containing ONLY the files the
// extension needs, then verifies the zip against an allow-list.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHIP = ['manifest.json', 'background.js', 'content', 'lib', 'sidepanel', 'offscreen', 'onboarding', 'icons'];
const ALLOWED = /^(manifest\.json|background\.js|(content|lib|sidepanel|offscreen|onboarding|icons)\/.+\.(js|html|css|png|svg))$/;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`manifest.json ${manifest.version} ≠ package.json ${pkg.version}`);

// No remote code, ever (Chrome Web Store policy).
for (const dir of SHIP.filter((f) => !f.includes('.'))) {
  for (const f of fs.readdirSync(path.join(ROOT, dir), { recursive: true })) {
    if (!/\.(js|html)$/.test(f)) continue;
    const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
    if (/\beval\s*\(|new Function\s*\(|<script[^>]+src=["']https?:/.test(src)) throw new Error(`Remote/dynamic code in ${dir}/${f}`);
  }
}

const out = path.join(ROOT, 'dist', `pullrows-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', '-9', '-q', out, ...SHIP, '-x', '*.DS_Store', '*/.*'], { cwd: ROOT });

const files = execFileSync('unzip', ['-Z1', out]).toString().trim().split('\n').filter((f) => !f.endsWith('/'));
const bad = files.filter((f) => !ALLOWED.test(f));
if (bad.length) throw new Error(`Unexpected files in the package:\n${bad.join('\n')}`);
console.log(`${path.relative(ROOT, out)} · ${files.length} files · ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
