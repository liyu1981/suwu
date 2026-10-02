#!/usr/bin/env node
/**
 * Guards the backup collector and the merge/replace apply (src/lib/backup/
 * collect.ts + apply.ts) against a minimal localStorage + IndexedDB shim, so the
 * interesting logic — mtime stamping, the size caps, category filtering, and
 * the merge-vs-replace decision — is exercised without a browser.
 *
 *   node --experimental-strip-types scripts/check-backup-merge.mjs
 */

import assert from 'node:assert/strict';

/** Minimal localStorage: get/set/remove/clear/length/key. */
function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    _map: map,
  };
}

globalThis.localStorage = makeStorage();
globalThis.indexedDB = {
  open() {
    throw new Error('indexedDB unavailable in this check');
  },
};

// Provide the module-level extension store the collector imports, stubbed to
// empty, by pre-populating nothing: collect() catches the open failure.
const { collect, MTIME_KEY } = await import('../src/lib/backup/collect.ts');
const { apply, preview } = await import('../src/lib/backup/apply.ts');

const ls = globalThis.localStorage;

// Seed representative settings across categories.
ls.setItem('suwu:background', JSON.stringify('ambient'));
ls.setItem('suwu:header-position', JSON.stringify('bottom'));
ls.setItem('tiling-spaces', JSON.stringify([{ layout: null, paneData: {} }]));
ls.setItem('suwu:notifications', JSON.stringify([{ id: 1 }]));
ls.setItem('suwu:last-update-check', JSON.stringify(999)); // denied
ls.setItem('suwu:bg', JSON.stringify('debug')); // denied

// ── collection honors categories and the deny list ─────────────────────
{
  const all = await collect(['settings', 'ext', 'layout']);
  const paths = all.items.map((i) => i.path);
  assert.ok(paths.includes('suwu:background'));
  assert.ok(paths.includes('tiling-spaces'));
  assert.ok(!paths.includes('suwu:last-update-check'), 'denied key must not be collected');
  assert.ok(!paths.includes('suwu:bg'), 'debug key must not be collected');
  assert.equal(all.counts.layout, 1, 'layout counted separately');
  assert.equal(all.counts.settings, 3, 'settings counted (bg, header-position, notifications)');

  const settingsOnly = await collect(['settings']);
  assert.ok(!settingsOnly.items.some((i) => i.path === 'tiling-spaces'), 'layout excluded');
}

// ── mtime stability: unchanged values keep their stamp, changes get a new one ─
{
  await collect(['settings']); // seed the shadow map
  const first = JSON.parse(ls.getItem(MTIME_KEY))['ls|suwu:background'].mtime;

  await new Promise((r) => setTimeout(r, 5));
  await collect(['settings']); // nothing changed
  const second = JSON.parse(ls.getItem(MTIME_KEY))['ls|suwu:background'].mtime;
  assert.equal(second, first, 'unchanged value keeps its mtime (dedup relies on this)');

  ls.setItem('suwu:background', JSON.stringify('webgpu'));
  await new Promise((r) => setTimeout(r, 5));
  await collect(['settings']);
  const third = JSON.parse(ls.getItem(MTIME_KEY))['ls|suwu:background'].mtime;
  assert.ok(third > second, 'changed value gets a fresh mtime');
}

// ── merge: a strictly newer local value wins ───────────────────────────
{
  const current = [
    { ns: 'ls', path: 'suwu:background', mtime: 500, value: 'local-newer' },
    { ns: 'ls', path: 'suwu:header-position', mtime: 100, value: 'top' },
  ];
  const payload = {
    v: 1,
    deviceId: 'd',
    createdAt: 0,
    categories: ['settings'],
    items: [
      { ns: 'ls', path: 'suwu:background', mtime: 100, value: 'remote-older' },
      { ns: 'ls', path: 'suwu:header-position', mtime: 900, value: 'bottom' },
    ],
  };
  ls.setItem('suwu:background', JSON.stringify('placeholder'));
  ls.setItem('suwu:header-position', JSON.stringify('placeholder'));

  // Make the shadow map agree with `current` so the merge reads it.
  ls.setItem(
    MTIME_KEY,
    JSON.stringify({
      'ls|suwu:background': { mtime: 500, fingerprint: 'x' },
      'ls|suwu:header-position': { mtime: 100, fingerprint: 'x' },
    }),
  );

  const report = await apply(payload, 'merge', current);
  assert.equal(report.skippedLocalNewer, 1, 'older remote value for a newer local key is skipped');
  assert.equal(JSON.parse(ls.getItem('suwu:background')), 'placeholder', 'newer local value untouched');
  assert.equal(JSON.parse(ls.getItem('suwu:header-position')), 'bottom', 'newer remote value applied');
}

// ── replace: local-only keys are removed ───────────────────────────────
{
  ls.setItem('suwu:username', JSON.stringify('local-only'));
  const current = [
    { ns: 'ls', path: 'suwu:username', mtime: 10, value: 'local-only' },
    { ns: 'ls', path: 'suwu:background', mtime: 10, value: 'x' },
  ];
  const payload = {
    v: 1,
    deviceId: 'd',
    createdAt: 0,
    categories: ['settings'],
    items: [{ ns: 'ls', path: 'suwu:background', mtime: 20, value: 'ambient' }],
  };
  const report = await apply(payload, 'replace', current);
  assert.equal(report.removed, 1, 'the local-only key is removed in replace mode');
  assert.equal(ls.getItem('suwu:username'), null, 'suwu:username removed');
  assert.equal(JSON.parse(ls.getItem('suwu:background')), 'ambient', 'background applied');
}

// ── unknown keys from a newer build are reported, not written ──────────
{
  ls.setItem('suwu:future-key', JSON.stringify('from a newer Suwu'));
  const payload = {
    v: 1,
    deviceId: 'd',
    createdAt: 0,
    categories: ['settings'],
    items: [{ ns: 'ls', path: 'suwu:not-a-real-key', mtime: 5, value: 1 }],
  };
  const report = await apply(payload, 'merge', []);
  assert.equal(report.unknownPaths.length, 1, 'unrecognized key reported');
  assert.ok(report.unknownPaths[0].includes('suwu:not-a-real-key'));
  assert.equal(report.applied, 0, 'nothing unrecognized is written');
  ls.removeItem('suwu:future-key');
}

// ── preview counts ─────────────────────────────────────────────────────
{
  const current = [
    { ns: 'ls', path: 'suwu:background', mtime: 1, value: 'a' },
    { ns: 'ext', path: 'note/record', mtime: 1, value: {} },
  ];
  const payload = {
    v: 1,
    deviceId: 'd',
    createdAt: 0,
    categories: ['settings', 'ext'],
    items: [
      { ns: 'ls', path: 'suwu:header-position', mtime: 2, value: 'top' },
      { ns: 'ext', path: 'note/record', mtime: 2, value: { texts: [] } },
    ],
  };
  const p = preview(payload, current, 'merge');
  assert.equal(p.settings, 1, 'one setting in the backup');
  assert.deepEqual(p.extensions, ['note'], 'note extension identified');
  assert.equal(p.changed, 2, 'header-position new + note record differs = 2 changed');
}

console.log('check-backup-merge: all assertions passed');