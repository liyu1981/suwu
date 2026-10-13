#!/usr/bin/env node
/**
 * Close-focus rule regression check; run with Node 22+ type stripping.
 *
 * Closing a tile must hand focus to the nearest surviving tile: the one
 * directly above the closed tile, or failing that the one to its left. This
 * pins focusAfterClose() against a 2x2 grid, a single row and a single column,
 * including the no-neighbour case (which returns '' so callers fall back to the
 * first remaining leaf).
 */
import assert from 'node:assert/strict'
import { closeAt, createLeaf, createSplit, focusAfterClose, leaves } from '../src/wm/layout.ts'

const W = 800
const H = 600

// ── 2x2 grid ──────────────────────────────────────────────────────────────
//   A | B
//   --+--
//   C | D
const A = createLeaf('A')
const B = createLeaf('B')
const C = createLeaf('C')
const D = createLeaf('D')
const top = createSplit('horizontal', A, B)
const bottom = createSplit('horizontal', C, D)
const grid = createSplit('vertical', top, bottom)

assert.equal(focusAfterClose(grid, 'D', W, H), 'B', 'D focuses the tile above it')
assert.equal(focusAfterClose(grid, 'C', W, H), 'A', 'C focuses the tile above it')
assert.equal(focusAfterClose(grid, 'B', W, H), 'A', 'B has no tile above, so focus goes left')
assert.equal(focusAfterClose(grid, 'A', W, H), '', 'A has no tile above or left')

// ── single row: only a left neighbour ever exists ─────────────────────────
const row = createSplit('horizontal', createLeaf('L'), createLeaf('R'))
assert.equal(focusAfterClose(row, 'R', W, H), 'L', 'R focuses the tile to its left')
assert.equal(focusAfterClose(row, 'L', W, H), '', 'L has neither an above nor a left tile')

// ── single column: only an above neighbour ever exists ────────────────────
const col = createSplit('vertical', createLeaf('T'), createLeaf('Bm'))
assert.equal(focusAfterClose(col, 'Bm', W, H), 'T', 'bottom focuses the tile above it')
assert.equal(focusAfterClose(col, 'T', W, H), '', 'top has no tile above')

// ── the chosen target always survives the close ───────────────────────────
for (const id of ['A', 'B', 'C', 'D']) {
  const target = focusAfterClose(grid, id, W, H)
  if (target) {
    const remaining = leaves(closeAt(grid, id))
    assert.ok(remaining.includes(target), `${id}: focus target ${target} survives the close`)
  }
}

// ── degenerate inputs ─────────────────────────────────────────────────────
assert.equal(focusAfterClose(grid, 'missing', W, H), '', 'unknown id has no neighbour')
assert.equal(focusAfterClose(null, 'A', W, H), '', 'empty layout has no neighbour')
assert.equal(focusAfterClose(grid, 'A', 0, 0), '', 'unmeasured viewport falls back')

console.log('check-focus-after-close: all assertions passed')
