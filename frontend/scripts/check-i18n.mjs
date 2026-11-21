#!/usr/bin/env node
// Every literal i18n key used in the frontend must exist in both locales.
//
// A missing key does not throw: i18next renders the key itself, so the UI quietly
// shows "plugin.staticBrowse" where a label belongs. That is how the Static Browse
// row in the App Menu settings shipped with a raw key — the tile is hidden by
// default, so nothing else ever rendered its label.
//
// The check is deliberately literal: keys built at runtime (`t(`a.${b}`)`) cannot
// be verified statically and are skipped. Plural bases are accepted when the
// locale carries `<key>_one`/`<key>_other` instead of the bare key.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// scripts/ lives one level below the frontend root.
const root = new URL('..', import.meta.url).pathname;
const LOCALES = 'src/locales';
const en = JSON.parse(readFileSync(join(root, LOCALES, 'en.json'), 'utf8'));
const zh = JSON.parse(readFileSync(join(root, LOCALES, 'zh_CN.json'), 'utf8'));

function resolve(dict, dotted) {
  let node = dict;
  for (const part of dotted.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) return undefined;
    node = node[part];
  }
  return node;
}

/** A key is present if it exists, or exists as an i18next plural family. */
function present(dict, key) {
  if (resolve(dict, key) !== undefined) return true;
  return resolve(dict, `${key}_one`) !== undefined || resolve(dict, `${key}_other`) !== undefined;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

// `t('a.b')` and `i18n.t('a.b')`, single or double quoted, never interpolated.
const CALL = /\b(?:i18n\.)?t\(\s*(['"])([A-Za-z0-9_.-]+)\1/g;

const used = new Map(); // key -> first file that uses it
for (const file of walk(join(root, 'src'))) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(CALL)) {
    const key = match[2];
    if (!key.includes('.')) continue; // not a namespaced key
    if (!used.has(key)) used.set(key, file.replace(root, ''));
  }
}

const problems = [];
for (const [key, file] of [...used].sort(([a], [b]) => a.localeCompare(b))) {
  if (!present(en, key)) problems.push(`missing in en: ${key}  (${file})`);
  if (!present(zh, key)) problems.push(`missing in zh_CN: ${key}  (${file})`);
}

// Locale parity the other way round: a key in en that zh forgot to translate.
function flatten(dict, prefix = '') {
  return Object.entries(dict).flatMap(([key, value]) =>
    value !== null && typeof value === 'object'
      ? flatten(value, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}
const zhKeys = new Set(flatten(zh));
for (const key of flatten(en)) {
  // Plural families are language-specific: zh may legitimately carry only _other.
  if (zhKeys.has(key)) continue;
  const base = key.replace(/_(one|other)$/, '');
  const family = [...zhKeys].some((k) => k.replace(/_(one|other)$/, '') === base);
  if (!family) problems.push(`en has ${key} but zh_CN does not (${base})`);
}

if (problems.length > 0) {
  console.error(`check-i18n: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`check-i18n: ${used.size} literal keys present in en and zh_CN`);
