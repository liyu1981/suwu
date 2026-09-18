// Regression check for the System Settings background preview fit math.
//
// The preview component is browser-bound, but the box sizing is pure and lives
// in preview-size.ts. This exercises it in Node so `pnpm check` catches an
// aspect-ratio or rounding regression without a browser.
import { fitPreviewBox } from '../src/components/background/preview-size.ts'

function assert(condition, message) {
  if (!condition) throw new Error(`Preview size check failed: ${message}`)
}

// 16:9 window, container wide enough that the height is the binding limit.
let box = fitPreviewBox(400, 180, 9 / 16)
assert(box.width === 320 && box.height === 180, `wide window -> ${box.width}x${box.height}`)

// Tall window: the max height is the binding limit.
box = fitPreviewBox(400, 180, 1)
assert(box.width === 180 && box.height === 180, `tall window -> ${box.width}x${box.height}`)

// Exactly fits: no clamp, no rounding drift.
box = fitPreviewBox(320, 180, 9 / 16)
assert(box.width === 320 && box.height === 180, `exact fit -> ${box.width}x${box.height}`)

// Integer px only.
box = fitPreviewBox(333, 180, 0.5)
assert(Number.isInteger(box.width) && Number.isInteger(box.height), 'box is integer px')

// Degenerate inputs never produce a non-positive box.
assert(fitPreviewBox(0, 180, 0.5).width === 0, 'zero width yields an empty box')
assert(fitPreviewBox(400, 0, 0.5).width === 0, 'zero max height yields an empty box')
box = fitPreviewBox(400, 180, Number.NaN)
assert(box.width > 0 && box.height > 0, 'invalid aspect falls back to 16:9')

console.log('Preview size check passed.')
