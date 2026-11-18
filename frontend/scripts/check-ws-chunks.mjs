// WebSocket input-chunking checks; run with Node 22+ type stripping.
//
// The property that matters is a round trip: whatever the user pastes, the
// server receives the same string, split into frames a server or proxy will not
// refuse, and never with a surrogate pair cut in half (which would arrive as
// invalid UTF-8 and mangle CJK or emoji).
import assert from 'node:assert/strict'
import { INPUT_CHUNK, chunkInput } from '../src/lib/wsChunks.ts'

/** Reassemble and check the invariants every chunk list must satisfy. */
function check(input, size) {
  const chunks = chunkInput(input, size)
  assert.equal(chunks.join(''), input, 'chunks reassemble to the input')
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0, 'no empty chunks')
    assert.ok(chunk.length <= Math.max(2, size), `chunk of ${chunk.length} exceeds ${size}`)
    assert.doesNotThrow(() => encodeURIComponent(chunk), 'each chunk is valid on its own')
  }
  return chunks
}

// ── the basics ────────────────────────────────────────────────────────────
assert.deepEqual(chunkInput(''), [], 'nothing to send for empty input')
assert.deepEqual(chunkInput('a'), ['a'])
assert.deepEqual(chunkInput('\r'), ['\r'], 'a single Enter is one frame')
assert.equal(INPUT_CHUNK <= 32768, true, 'the default chunk stays under the old 32 KiB limit')

// A payload the size of the log paste that broke the session (92,535 bytes).
const paste = '11:31:22 AM INFO  walking /video/tv/BBC.纪录片.第三季/[BD高清分辩率bd-film.co]纪录片II.三集纪录片.Planet.Earth.II.03.J\r\n'.repeat(1000)
assert.ok(paste.length > 90000, 'fixture is paste-sized')
const chunks = check(paste, INPUT_CHUNK)
assert.ok(chunks.length > 1, 'a paste-sized payload is split')
assert.ok(chunks.every((c) => c.length <= INPUT_CHUNK))

// ── boundaries ────────────────────────────────────────────────────────────
check('x'.repeat(INPUT_CHUNK), INPUT_CHUNK) // exactly one chunk
assert.equal(chunkInput('x'.repeat(INPUT_CHUNK), INPUT_CHUNK).length, 1)
assert.equal(chunkInput('x'.repeat(INPUT_CHUNK + 1), INPUT_CHUNK).length, 2)

// ── surrogate pairs are never split ───────────────────────────────────────
// One emoji (2 code units) per 2-unit limit, and an odd offset that would cut a
// pair if the splitter counted code units blindly.
const emoji = '😀'.repeat(10)
for (const size of [2, 3, 4, 5, INPUT_CHUNK]) {
  const parts = check(emoji, size)
  for (const part of parts) {
    assert.equal(part.isWellFormed(), true, `chunk ${JSON.stringify(part)} is a well-formed string`)
  }
}
// CJK (BMP, one unit each) still splits without corruption.
check('纪录片'.repeat(1000), 7)
// A pair straddling the boundary must move wholly into the next chunk.
const straddle = 'ab😀cd'
const straddleChunks = check(straddle, 3)
assert.deepEqual(straddleChunks, ['ab', '😀c', 'd'], 'the pair starts the next chunk')

// ── degenerate limits ─────────────────────────────────────────────────────
assert.deepEqual(chunkInput('abcd', 0), ['ab', 'cd'], 'a limit below 2 is raised to 2')
assert.deepEqual(chunkInput('abc', 1), ['ab', 'c'])

console.log('check-ws-chunks: ok')
