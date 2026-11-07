#!/usr/bin/env node
/**
 * Terminal font-size persistence check; run with Node 22+ type stripping.
 *
 * The toolbar's +/- buttons used to change only that tile's size, so the next
 * terminal came back at the settings preset. Now the choice is also written to
 * the persisted default — but only for tiles that actually have those buttons,
 * and never as an unclamped or NaN value (a corrupt stored number would poison
 * every new terminal).
 */
import assert from 'node:assert/strict'
import {
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  clampFont,
  shouldPersistFontDefault,
} from '../src/store/fonts.ts'

// ── which tiles sync the default ──────────────────────────────────────────
assert.equal(shouldPersistFontDefault('term'), true, 'the terminal toolbar sets the default')
for (const other of ['code', 'fileviewer', 'filebrowser', 'extension', undefined]) {
  assert.equal(shouldPersistFontDefault(other), false, `${other} does not own the terminal default`)
}

// ── the size that gets persisted ──────────────────────────────────────────
assert.equal(clampFont(FONT_MIN - 5), FONT_MIN, 'below the floor clamps up')
assert.equal(clampFont(FONT_MAX + 5), FONT_MAX, 'above the ceiling clamps down')
assert.equal(clampFont(13.6), 14, 'fractional sizes round to whole pixels')
assert.equal(clampFont(Number.NaN), FONT_DEFAULT, 'a corrupt value falls back to the default')
assert.equal(clampFont(Number.POSITIVE_INFINITY), FONT_DEFAULT, 'infinity is not a font size')

console.log('term-font-persistence: all assertions passed')
