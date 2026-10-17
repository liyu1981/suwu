// Regression check for the live-wallpaper provider helpers.
//
// The network and OPFS parts of 2d-lives/providers.ts are browser-bound, but
// the filename parsing is pure — this runs it in Node so `pnpm check` catches a
// regression in Content-Disposition handling without a browser.
import {
  fallbackWallpaperFilename,
  filenameFromContentDisposition,
} from '../src/components/background/2d-lives/filename.ts'

function assert(condition, message) {
  if (!condition) throw new Error(`Lives2D check failed: ${message}`)
}

// Plain filename="…" form.
assert(
  filenameFromContentDisposition('attachment; filename="naruto-blue-sky-moewalls-com.mp4"') ===
    'naruto-blue-sky-moewalls-com.mp4',
  'plain filename is parsed',
)
// RFC 5987 filename*=UTF-8''… form wins, and percent-decodes.
assert(
  filenameFromContentDisposition("attachment; filename=\"fallback.mp4\"; filename*=UTF-8''naruto%20blue%20sky.mp4") ===
    'naruto blue sky.mp4',
  'extended filename is preferred and decoded',
)
// No filename at all.
assert(filenameFromContentDisposition(null) === null, 'null header yields null')
assert(filenameFromContentDisposition('attachment') === null, 'missing filename yields null')

// Fallback names strip path-hostile characters and always end in .mp4.
assert(
  fallbackWallpaperFilename({ title: 'A/B: "C"?' }) === 'A B C.mp4',
  'fallback filename is sanitized',
)
assert(fallbackWallpaperFilename({ title: '   ' }) === 'wallpaper.mp4', 'blank title falls back')

console.log('Lives2D check passed.')
