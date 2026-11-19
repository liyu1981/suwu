#!/usr/bin/env node
// Regenerates the PWA / home-screen icons from public/logo.svg.
//
//   node scripts/gen-icons.mjs
//
// iOS only accepts PNG for `apple-touch-icon` (it ignores the SVG and invents a
// letter tile instead), and the manifest wants 192/512 PNGs, so the icons cannot
// be the SVG itself. There is no image toolchain in this repo, but there is
// always a Chromium (the app is a browser app): each size is the SVG rendered in
// a 512-viewbox page and screenshotted at that size.
//
// Set CHROME_BIN if the binary is not `chromium-browser`, `chromium` or
// `google-chrome`, and `--check` to fail when the committed PNGs are stale.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const publicDir = join(here, '..', 'public');
const svg = readFileSync(join(publicDir, 'logo.svg'), 'utf8');

// Full-bleed gradient: the rounded rect in logo.svg would leave the corners a
// different colour, and the platform masks the icon anyway.
const fullBleed = svg
  .replace('<rect width="512" height="512" rx="112" fill="url(#bgGrad)"/>', '<rect width="512" height="512" fill="url(#bgGrad)"/>')
  .replace(/<svg[^>]*>/, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">');

// Android's maskable icons are cropped to a circle/squircle that may cut 20% off
// each edge, so the artwork shrinks into the safe zone while the background
// still covers the whole square.
const maskable = fullBleed.replace(
  /(<rect width="512" height="512" fill="url\(#bgGrad\)"\/>)/,
  '$1<g transform="translate(256,256) scale(0.78) translate(-256,-256)">',
).replace('</svg>', '</g></svg>');

const page = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;overflow:hidden;background:#0f172a}
svg{display:block;width:100vw;height:100vh}
</style></head><body>${body}</body></html>`;

const chrome = process.env.CHROME_BIN ?? ['chromium-browser', 'chromium', 'google-chrome'].find((bin) => {
  try {
    execFileSync('command', ['-v', bin], { shell: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});

if (!chrome) {
  console.error('gen-icons: no Chromium found; set CHROME_BIN');
  process.exit(1);
}

const dir = join(publicDir, 'icons');
mkdirSync(dir, { recursive: true });

const targets = [
  // iOS asks for a size that matches the device (120/152/167/180) and older
  // versions fall back to a screenshot when none of the offered sizes match, so
  // every size an iPhone or iPad may want is produced here.
  { file: 'icon-120.png', size: 120, html: page(fullBleed) },
  { file: 'icon-152.png', size: 152, html: page(fullBleed) },
  { file: 'icon-167.png', size: 167, html: page(fullBleed) },
  { file: 'icon-180.png', size: 180, html: page(fullBleed) },
  { file: 'icon-192.png', size: 192, html: page(fullBleed) },
  { file: 'icon-512.png', size: 512, html: page(fullBleed) },
  // Apple recommends 512 or 1024 for the manifest (a PWA's launcher icon is
  // scaled by the platform, and a larger source survives any density).
  { file: 'icon-1024.png', size: 1024, html: page(fullBleed) },
  { file: 'icon-maskable-512.png', size: 512, html: page(maskable) },
];

// iOS also looks for the icon at the site root without any <link>, on the theory
// that some Safari versions and some "add to home screen" entry points skip the
// link entirely. Two extra copies are cheap insurance.
const rootCopies = [
  ['icon-180.png', 'apple-touch-icon.png'],
  ['icon-180.png', 'apple-touch-icon-precomposed.png'],
];

for (const { file, size, html } of targets) {
  // The page is written beside the output, not under /tmp: Chromium is a snap on
  // several distros and a snap cannot read /tmp or hidden directories in $HOME.
  const source = join(dir, `work-${size}.html`);
  writeFileSync(source, html);
  const out = join(dir, file);
  try {
    execFileSync(
      chrome,
      [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--hide-scrollbars',
        `--window-size=${size},${size}`,
        `--screenshot=${out}`,
        `file://${source}`,
      ],
      { stdio: 'ignore' },
    );
    console.log(`gen-icons: ${file} (${size}×${size}, ${statSync(out).size} B)`);
  } finally {
    rmSync(source, { force: true });
  }
}

for (const [from, to] of rootCopies) {
  const bytes = readFileSync(join(dir, from));
  writeFileSync(join(publicDir, to), bytes);
  console.log(`gen-icons: ${to} (copy of ${from})`);
}
