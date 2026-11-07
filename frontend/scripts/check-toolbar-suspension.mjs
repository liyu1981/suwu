#!/usr/bin/env node
/**
 * Tile-toolbar hiding check; run with Node 22+ type stripping.
 *
 * The hover toolbar covers each tile's top-right corner, which is also where an
 * extension may put controls. An extension tile therefore shows a hide button
 * next to its close button; clicking it hides the toolbar for a configurable
 * number of seconds. This pins the pure contract: how long that is, whether a
 * suspension is still running, which tiles offer the button, and the class lists
 * that must change together.
 */
import assert from 'node:assert/strict'
import {
  cornerClasses,
  isSuspended,
  showsHideControl,
  suspensionMs,
} from '../src/wm/toolbarSuspension.ts'

// ── the setting ───────────────────────────────────────────────────────────
assert.equal(suspensionMs(5), 5000, 'the default is five seconds')
assert.equal(suspensionMs(30), 30000, 'the slider ceiling is honoured')
assert.equal(suspensionMs(1.5), 1500, 'fractional seconds are honoured')
assert.equal(suspensionMs(0), 0, '0 disables the button')
assert.equal(suspensionMs(-3), 0, 'a negative value cannot shorten the window')
assert.equal(suspensionMs(Number.NaN), 0, 'a corrupt stored value disables it')

// ── the suspension itself ─────────────────────────────────────────────────
const until = 10_000
assert.equal(isSuspended(until, 9_999), true, 'still hidden just before the deadline')
assert.equal(isSuspended(until, 10_000), false, 'expires exactly on the deadline')
assert.equal(isSuspended(until, 10_001), false, 'stays expired afterwards')
assert.equal(isSuspended(0, 1), false, 'no suspension recorded means not hidden')

// ── which tiles get the button ────────────────────────────────────────────
assert.equal(showsHideControl('extension'), true, 'extension tiles own their corner')
assert.equal(showsHideControl('term'), false, 'built-in tiles keep their chrome untouched')
assert.equal(showsHideControl('code'), false, 'only extensions opt in')
assert.equal(showsHideControl(undefined), false, 'an empty pane has no toolbar to hide')

// ── the classes ───────────────────────────────────────────────────────────
const normal = cornerClasses(false)
assert.equal(normal.zone, '', 'the zone must keep receiving pointer events to reveal the toolbar')
assert.match(normal.toolbar, /group-hover\/corner:pointer-events-auto/, 'normal mode reveals on hover')
assert.match(normal.toolbar, /group-hover\/corner:opacity-100/, 'normal mode fades the toolbar in')

const hidden = cornerClasses(true)
assert.equal(hidden.zone, 'pointer-events-none', 'a hidden toolbar hands the corner to the extension')
assert.equal(hidden.toolbar, '', 'hiding must not reintroduce any hover reveal')

console.log('toolbar-suspension: all assertions passed')
