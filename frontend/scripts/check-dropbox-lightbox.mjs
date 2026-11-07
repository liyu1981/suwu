#!/usr/bin/env node
/**
 * Image-lightbox geometry; run with Node 22+ type stripping.
 *
 * The dropbox preview draws the picture centred and transformed with
 * translate(offset) scale(scale). Two things must hold or the interaction feels
 * broken: the zoom range is bounded, and the image can never be dragged outside
 * the viewport. Zooming also has to keep the point under the cursor still.
 */
import assert from 'node:assert/strict'
import {
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_MIN_SCALE,
  clampPan,
  clampScale,
  fitSize,
  nextScale,
  panLimit,
  zoomAround,
} from '../src/lib/lightbox.ts'

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`)

// ── the zoom range ────────────────────────────────────────────────────────
assert.equal(clampScale(0.2), LIGHTBOX_MIN_SCALE, 'never smaller than fitted')
assert.equal(clampScale(99), LIGHTBOX_MAX_SCALE, 'never beyond the ceiling')
assert.equal(clampScale(Number.NaN), LIGHTBOX_MIN_SCALE, 'a corrupt value falls back to fitted')
near(clampScale(3), 3, 'a value inside the range is untouched')

assert.ok(nextScale(1, 1) > 1, 'zoom in grows')
assert.ok(nextScale(2, -1) < 2, 'zoom out shrinks')
assert.equal(nextScale(LIGHTBOX_MAX_SCALE, 1), LIGHTBOX_MAX_SCALE, 'zoom in saturates')
assert.equal(nextScale(1, -1), 1, 'zoom out cannot go below fitted')

// ── fitting never upscales ────────────────────────────────────────────────
const small = fitSize(100, 50, 800, 600)
near(small.x, 100, 'a small image keeps its pixels')
near(small.y, 50, 'a small image keeps its pixels')
const big = fitSize(1600, 1200, 800, 600)
near(big.x, 800, 'a wide image is fitted to the viewport width')
near(big.y, 600, 'a wide image is fitted to the viewport height')

// ── panning is bounded by what is off-screen ──────────────────────────────
const limitAt1 = panLimit(1, 800, 600, 800, 600)
near(limitAt1.x, 0, 'at fitted size there is nothing to pan')
near(limitAt1.y, 0, 'at fitted size there is nothing to pan')
const limitAt2 = panLimit(2, 800, 600, 800, 600)
near(limitAt2.x, 400, 'at 2x, half the extra width is reachable on each side')
near(limitAt2.y, 300, 'at 2x, half the extra height is reachable on each side')

const pinned = clampPan({ x: 999, y: -999 }, 1, 800, 600, 800, 600)
near(pinned.x, 0, 'a fitted image cannot be dragged')
near(pinned.y, 0, 'a fitted image cannot be dragged')
const clamped = clampPan({ x: 999, y: -999 }, 2, 800, 600, 800, 600)
near(clamped.x, 400, 'a zoomed image stops at the edge')
near(clamped.y, -300, 'a zoomed image stops at the edge')
const inside = clampPan({ x: 120, y: -80 }, 2, 800, 600, 800, 600)
near(inside.x, 120, 'a pan inside the range is untouched')
near(inside.y, -80, 'a pan inside the range is untouched')

// ── zoom keeps the point under the cursor still ───────────────────────────
// image point under the cursor = (cursor - offset) / scale, before and after.
for (const [cursor, offset, from, to] of [
  [{ x: 200, y: -100 }, { x: 0, y: 0 }, 1, 2],
  [{ x: -300, y: 150 }, { x: 40, y: -20 }, 2, 4],
  [{ x: 50, y: 50 }, { x: 10, y: 10 }, 4, 1.5],
]) {
  const next = zoomAround(cursor, offset, from, to)
  near((cursor.x - next.x) / to, (cursor.x - offset.x) / from, 'the anchor x is stable')
  near((cursor.y - next.y) / to, (cursor.y - offset.y) / from, 'the anchor y is stable')
}
const unchanged = zoomAround({ x: 10, y: 10 }, { x: 3, y: 4 }, 2, 2)
near(unchanged.x, 3, 'no zoom change means no offset change')
near(unchanged.y, 4, 'no zoom change means no offset change')

console.log('dropbox-lightbox: all assertions passed')
