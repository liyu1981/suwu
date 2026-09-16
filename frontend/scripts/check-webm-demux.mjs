// Regression check for the WebM/Matroska demuxer.
//
// Runs the browser-side parser in Node against a synthetic in-memory WebM so a
// change to the EBML reader can't silently break clip playback. It covers the
// streaming layouts that real encoders emit: unknown-size Segment and Cluster.
//
// Run with: node scripts/check-webm-demux.mjs (wired into `pnpm check`).
import { parseWebm } from '../src/components/background/video/video-cpu/webm.ts'

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function idBytes(id) {
  const bytes = []
  let value = id
  while (value > 0) {
    bytes.unshift(value & 0xff)
    value = Math.floor(value / 256)
  }
  return new Uint8Array(bytes)
}

function sizeBytes(size) {
  for (let length = 1; length <= 8; length++) {
    if (size < 2 ** (7 * length) - 1) {
      const bytes = new Uint8Array(length)
      let value = size
      for (let i = length - 1; i >= 0; i--) {
        bytes[i] = value & 0xff
        value = Math.floor(value / 256)
      }
      bytes[0] |= 1 << (8 - length)
      return bytes
    }
  }
  throw new Error('element too large')
}

const UNKNOWN_SIZE = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])

function el(id, data, unknownSize = false) {
  return concat(idBytes(id), unknownSize ? UNKNOWN_SIZE : sizeBytes(data.length), data)
}

function uint(value) {
  const bytes = []
  let rest = value
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest = Math.floor(rest / 256)
  }
  return new Uint8Array(bytes.length > 0 ? bytes : [0])
}

function f64(value) {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, value)
  return bytes
}

function str(value) {
  return new TextEncoder().encode(value)
}

function simpleBlock(track, relative, key, payload) {
  const header = new Uint8Array([0x80 | track, (relative >> 8) & 0xff, relative & 0xff, key ? 0x80 : 0])
  return el(0xa3, concat(header, payload))
}

function buildWebm({ unknownSegment = false, unknownCluster = false } = {}) {
  const ebml = el(0x1a45dfa3, concat(el(0x4282, str('webm')), el(0x4287, uint(2))))
  const info = el(0x1549a966, concat(el(0x2ad7b1, uint(1_000_000)), el(0x4489, f64(2000))))
  const trackEntry = el(
    0xae,
    concat(
      el(0xd7, uint(1)),
      el(0x83, uint(1)),
      el(0x86, str('V_VP9')),
      el(0x63a2, new Uint8Array([0x01, 0x00, 0x0a, 0x08])),
      el(0xe0, concat(el(0xb0, uint(1920)), el(0xba, uint(1080)))),
    ),
  )
  const tracks = el(0x1654ae6b, trackEntry)
  const cluster1 = el(
    0x1f43b675,
    concat(el(0xe7, uint(0)), simpleBlock(1, 0, true, new Uint8Array([1, 2, 3, 4]))),
    unknownCluster,
  )
  const cluster2 = el(
    0x1f43b675,
    concat(el(0xe7, uint(33)), simpleBlock(1, 0, false, new Uint8Array([5, 6, 7, 8]))),
    unknownCluster,
  )
  const segment = el(0x18538067, concat(info, tracks, cluster1, cluster2), unknownSegment)
  return concat(ebml, segment).buffer
}

function assert(condition, message) {
  if (!condition) throw new Error(`WebM demux check failed: ${message}`)
}

const variants = [
  { label: 'known sizes', options: {} },
  { label: 'unknown-size cluster', options: { unknownCluster: true } },
  { label: 'unknown-size segment', options: { unknownSegment: true } },
]

for (const { label, options } of variants) {
  const parsed = parseWebm(buildWebm(options))
  assert(parsed.track.codec === 'vp09.00.10.08', `${label}: codec`)
  assert(parsed.track.width === 1920 && parsed.track.height === 1080, `${label}: dimensions`)
  assert(parsed.samples.length === 2, `${label}: sample count`)
  assert(parsed.samples[0].key && !parsed.samples[1].key, `${label}: keyframe flags`)
  assert(parsed.samples[0].timestamp === 0 && parsed.samples[1].timestamp === 33000, `${label}: timestamps`)
  assert(parsed.samples[0].duration === 33000, `${label}: sample duration`)
  assert(parsed.samples[0].data.length === 4 && parsed.samples[0].data[0] === 1, `${label}: sample data`)
  assert(Math.abs(parsed.track.durationSeconds - 2) < 1e-9, `${label}: duration seconds`)
}

console.log(`WebM demux check passed (${variants.length} container layouts).`)
