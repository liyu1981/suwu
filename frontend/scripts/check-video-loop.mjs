// Regression check for the crossfade loop timing.
//
// The scheduler in video-cpu/renderer.ts is browser-bound, but its blend math
// lives in loop.ts. This runs that math in Node so an off-by-one in the
// window/edge handling is caught by `pnpm check`.
import {
  canCrossfade,
  fadeProgress,
  VIDEO_CROSSFADE_SECONDS,
} from '../src/components/background/video/video-cpu/loop.ts'

function assert(condition, message) {
  if (!condition) throw new Error(`Video loop check failed: ${message}`)
}

function close(a, b) {
  return Math.abs(a - b) < 1e-9
}

assert(VIDEO_CROSSFADE_SECONDS === 2, 'fade length is fixed at 2s')
assert(canCrossfade(10), 'long clips can crossfade')
assert(!canCrossfade(4), 'clips exactly 2x the fade are not blended')
assert(!canCrossfade(3.5), 'short clips are not blended')
assert(!canCrossfade(0), 'zero-duration clips are not blended')

// Window is [first + duration - 2, first + duration].
const first = 0
const duration = 10
assert(fadeProgress(7, first, duration) === 0, 'before the window stays fully outgoing')
assert(fadeProgress(8, first, duration) === 0, 'window start is fully outgoing')
assert(close(fadeProgress(9, first, duration), 0.5), 'midpoint is a 50/50 mix')
assert(fadeProgress(10, first, duration) === 1, 'window end is fully incoming')
assert(fadeProgress(12, first, duration) === 1, 'past the window clamps to incoming')

// Negative start timestamps (common for trimmed clips) shift the whole window.
assert(close(fadeProgress(7.5, -1, 10), 0.25), 'negative first timestamp shifts the window')

console.log('Video loop check passed.')
