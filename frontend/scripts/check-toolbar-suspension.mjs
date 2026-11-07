#!/usr/bin/env node
/**
 * Tile-toolbar suspension check; run with Node 22+ type stripping.
 *
 * The hover toolbar covers each tile's top-right corner, which is also where an
 * extension may put controls. Double-tapping Shift while a corner is hovered
 * hides the toolbar for a configurable number of seconds. This pins the pure
 * parts of that contract: the double-tap window, the seconds→ms setting, and the
 * class lists that must change together.
 */
import assert from 'node:assert/strict'
import {
  DOUBLE_TAP_MS,
  cornerClasses,
  isDoubleShift,
  suspensionMs,
} from '../src/wm/toolbarSuspension.ts'

// ── the gesture ───────────────────────────────────────────────────────────
assert.equal(isDoubleShift(0, 1000), false, 'the first press never counts as a double-tap')
assert.equal(isDoubleShift(1000, 1100), true, 'a quick second press is a double-tap')
assert.equal(isDoubleShift(1000, 1000 + DOUBLE_TAP_MS), true, 'the window is inclusive')
assert.equal(isDoubleShift(1000, 1001 + DOUBLE_TAP_MS), false, 'a slow press is a new gesture')
assert.equal(isDoubleShift(1000, 900), false, 'a non-monotonic clock must not trigger')

// ── the setting ───────────────────────────────────────────────────────────
assert.equal(suspensionMs(5), 5000, 'the default is five seconds')
assert.equal(suspensionMs(0), 0, '0 disables the gesture')
assert.equal(suspensionMs(-3), 0, 'a negative value cannot shorten the window')
assert.equal(suspensionMs(Number.NaN), 0, 'a corrupt stored value disables it')
assert.equal(suspensionMs(1.5), 1500, 'fractional seconds are honoured')

// ── the classes ───────────────────────────────────────────────────────────
const normal = cornerClasses(false)
assert.equal(normal.zone, '', 'the zone must keep receiving pointer events to reveal the toolbar')
assert.match(normal.toolbar, /group-hover\/corner:pointer-events-auto/, 'normal mode reveals on hover')
assert.match(normal.toolbar, /group-hover\/corner:opacity-100/, 'normal mode fades the toolbar in')

const suspended = cornerClasses(true)
assert.equal(suspended.zone, 'pointer-events-none', 'a suspended toolbar hands the corner to the tile')
assert.equal(suspended.toolbar, '', 'suspension must not reintroduce any hover reveal')

console.log('toolbar-suspension: all assertions passed')
