#!/usr/bin/env node
/**
 * Guards the backup key registry (src/lib/backup/registry.ts).
 *
 * Backup is an allowlist, so a setting that nobody added to the registry is
 * simply not backed up — safe by default, but easy to forget. This check scans
 * frontend/src for every `suwu*` / `tiling*` localStorage key and fails when
 * one is neither listed in the registry nor explicitly denied, so a new setting
 * is a conscious decision rather than a silent omission.
 *
 *   node --experimental-strip-types scripts/check-backup-registry.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGISTRY, DENY, categoryForKey } from '../src/lib/backup/registry.ts';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const srcDir = join(root, 'src');

/** Collect every source file under src/ (recursively). */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// Patterns that name a localStorage key. They cover atomWithStorage('…'),
// localStorage.getItem/setItem(('…'), and a bare KEY = '…' constant.
const KEY_PATTERNS = [
  /atomWithStorage(?:<[^>]*>)?\(\s*['"]([^'"]+)['"]/g,
  /localStorage\.(?:getItem|setItem|removeItem)\(\s*['"]([^'"]+)['"]/g,
  /(?:^|\s)(?:const|let)\s+[A-Z0-9_]*KEY[A-Z0-9_]*\s*[:=]\s*['"]([^'"]+)['"]/gm,
];

// Keys that are structurally not per-user settings: the backup module's own
// bookkeeping and the Cloudflare markers, which live in sessionStorage. The
// extension-store prefix is a constant the registry declares, not a key.
const SKIP = new Set([
  'suwu:backup-mtimes',
  'suwu:backup-config',
  'suwu:cf-authorization-seen',
  'suwu:cf-reauth-at',
  'suwu:ext/',
]);

const found = new Map(); // key -> first file that mentions it
for (const file of sourceFiles(srcDir)) {
  const text = readFileSync(file, 'utf8');
  for (const pattern of KEY_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const key = m[1];
      if (!key.startsWith('suwu') && !key.startsWith('tiling')) continue;
      if (SKIP.has(key)) continue;
      if (!found.has(key)) found.set(key, relative(root, file));
    }
  }
}

// Keys the registry knows via a prefix rule (e.g. 'suwu.' zoom keys) are fine.
const unlisted = [];
for (const [key, file] of found) {
  if (categoryForKey(key) !== null) continue;
  if (DENY.includes(key)) continue;
  // A prefix rule may legitimately cover dynamic keys (per-pane, per-zoom).
  const coveredByPrefix = REGISTRY.some((e) => e.prefix && key.startsWith(e.prefix));
  if (coveredByPrefix) continue;
  unlisted.push(`${key}  (${file})`);
}

if (unlisted.length) {
  console.error('check-backup-registry: these localStorage keys are not in the backup registry.');
  console.error('Add each to REGISTRY (with a category) or to DENY in src/lib/backup/registry.ts:\n');
  for (const line of unlisted) console.error('  ' + line);
  process.exit(1);
}

// Sanity: the deny list must not contain anything the registry also backs up.
for (const key of DENY) {
  if (REGISTRY.some((e) => e.key === key)) {
    console.error(`check-backup-registry: "${key}" is both denied and registered.`);
    process.exit(1);
  }
}

console.log(`check-backup-registry: ${found.size} key(s) scanned, all registered or denied.`);