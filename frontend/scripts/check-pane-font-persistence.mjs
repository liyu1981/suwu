#!/usr/bin/env node
/**
 * Per-tile font persistence; run with Node 22+ type stripping.
 *
 * A tile's font size lives in its space's `paneData`, and the space is what gets
 * persisted (`localStorage['suwu:spaces']`). Two things had to be true for a
 * toolbar +/- click to survive a reload:
 *
 *   1. the write lands in the space that OWNS the tile, not whichever space
 *      happens to be active at click time — a click can arrive before the pane's
 *      own mousedown has switched spaces;
 *   2. `paneData` actually survives the JSON round trip the storage does.
 *
 * No app settings are involved: the terminal's "default for new terminals" is a
 * separate value and must not be touched by a per-tile change.
 */
import assert from 'node:assert/strict'
import { createLeaf, createSpace, setPaneData, spaceIndexForPane } from '../src/wm/layout.ts'
import { FONT_DEFAULT, clampFont } from '../src/store/fonts.ts'

// ── the owning space is found by pane id ──────────────────────────────────
const a = { ...createSpace('A'), layout: createLeaf('pane-a') }
const b = { ...createSpace('B'), layout: createLeaf('pane-b') }
const spaces = [a, b]

assert.equal(spaceIndexForPane(spaces, 'pane-a'), 0, 'pane-a belongs to the first space')
assert.equal(spaceIndexForPane(spaces, 'pane-b'), 1, 'pane-b belongs to the second space')
assert.equal(spaceIndexForPane(spaces, 'pane-gone'), -1, 'an unknown pane has no space')
assert.equal(spaceIndexForPane([], 'pane-a'), -1, 'no spaces at all is -1, not 0')

// ── the write survives the storage round trip ─────────────────────────────
const idx = spaceIndexForPane(spaces, 'pane-b')
const updated = spaces.map((s, i) => (i === idx ? setPaneData(s, 'pane-b', 'fontSize', 18) : s))
// Exactly what `suwu:spaces` holds: JSON.
const persisted = JSON.parse(JSON.stringify(updated))
assert.equal(persisted[1].paneData['pane-b'].fontSize, 18, 'the size is persisted with its space')
assert.equal(persisted[0].paneData?.['pane-b'], undefined, 'the other space is untouched')

// ── unrelated keys on the same pane survive ───────────────────────────────
const withOther = setPaneData(updated[1], 'pane-b', 'other', 'x')
const withFont = setPaneData(withOther, 'pane-b', 'fontSize', 20)
assert.equal(withFont.paneData['pane-b'].other, 'x', 'setting one key keeps the others')
assert.equal(withFont.paneData['pane-b'].fontSize, 20, 'the font is the latest value')

// ── the persisted value is always renderable ──────────────────────────────
assert.equal(clampFont(Number.NaN), FONT_DEFAULT, 'a corrupt stored size falls back')
assert.equal(clampFont(999), 28, 'the ceiling still applies')

console.log('pane-font-persistence: all assertions passed')
