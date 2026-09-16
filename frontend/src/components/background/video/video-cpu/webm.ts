import type { ParsedVideo, VideoSample, VideoTrack } from './types'

// ── EBML element IDs (stored form: marker bits are part of the ID) ──────────

const ID_EBML = 0x1a45dfa3
const ID_SEGMENT = 0x18538067

const ID_INFO = 0x1549a966
const ID_TIMESTAMP_SCALE = 0x2ad7b1
const ID_DURATION = 0x4489

const ID_TRACKS = 0x1654ae6b
const ID_TRACK_ENTRY = 0xae
const ID_TRACK_NUMBER = 0xd7
const ID_TRACK_TYPE = 0x83
const ID_CODEC_ID = 0x86
const ID_CODEC_PRIVATE = 0x63a2
const ID_DEFAULT_DURATION = 0x23e383
const ID_VIDEO = 0xe0
const ID_PIXEL_WIDTH = 0xb0
const ID_PIXEL_HEIGHT = 0xba

const ID_CLUSTER = 0x1f43b675
const ID_CLUSTER_TIMESTAMP = 0xe7
const ID_SIMPLE_BLOCK = 0xa3
const ID_BLOCK_GROUP = 0xa0
const ID_BLOCK = 0xa1
const ID_REFERENCE_BLOCK = 0xfb
const ID_SILENT_TRACKS = 0x5854
const ID_POSITION = 0xa7
const ID_PREV_SIZE = 0xab
const ID_ENCRYPTED_BLOCK = 0xaf

const DEFAULT_TIMESTAMP_SCALE = 1_000_000 // nanoseconds per tick (= 1 ms)

/** Number of leading bytes in an EBML variable-length integer. */
function vintLength(first: number): number {
  if (first === 0) return 0
  let length = 1
  for (let mask = 0x80; mask > 0; mask >>= 1, length++) {
    if (first & mask) return length
  }
  return 0
}

/** Sequential reader over an EBML byte stream. */
class EbmlReader {
  view: DataView
  pos: number

  constructor(view: DataView, pos = 0) {
    this.view = view
    this.pos = pos
  }

  get end(): number {
    return this.view.byteLength
  }

  /** Read an element ID (keeps the marker bits, e.g. `0x1a45dfa3`). */
  readId(): number {
    if (this.pos >= this.end) throw new Error('WebM: unexpected end of file reading an element ID.')
    const length = vintLength(this.view.getUint8(this.pos))
    if (length === 0 || length > 4) throw new Error(`WebM: invalid element ID at byte ${this.pos}.`)
    let id = 0
    for (let i = 0; i < length; i++) id = id * 256 + this.view.getUint8(this.pos + i)
    this.pos += length
    return id
  }

  /** Read an element size; `null` means "unknown size" (all value bits set). */
  readSize(): number | null {
    if (this.pos >= this.end) throw new Error('WebM: unexpected end of file reading an element size.')
    const first = this.view.getUint8(this.pos)
    const length = vintLength(first)
    if (length === 0) throw new Error(`WebM: invalid element size at byte ${this.pos}.`)
    const mask = 0xff >> length
    let value = first & mask
    let allOnes = value === mask
    for (let i = 1; i < length; i++) {
      const byte = this.view.getUint8(this.pos + i)
      value = value * 256 + byte
      if (byte !== 0xff) allOnes = false
    }
    this.pos += length
    return allOnes ? null : value
  }

  readUint(length: number): number {
    let value = 0
    for (let i = 0; i < length; i++) value = value * 256 + this.view.getUint8(this.pos + i)
    this.pos += length
    return value
  }

  readInt16(): number {
    const value = this.view.getInt16(this.pos)
    this.pos += 2
    return value
  }

  readFloat(length: number): number {
    const value = length === 4 ? this.view.getFloat32(this.pos) : this.view.getFloat64(this.pos)
    this.pos += length
    return value
  }

  readString(length: number): string {
    let value = ''
    for (let i = 0; i < length; i++) value += String.fromCharCode(this.view.getUint8(this.pos + i))
    this.pos += length
    return value
  }

  readBytes(length: number): Uint8Array {
    const start = this.pos
    this.pos += length
    return new Uint8Array(this.view.buffer, this.view.byteOffset + start, length)
  }
}

interface ElementHeader {
  id: number
  /** `null` when the element uses EBML "unknown size". */
  size: number | null
}

function readHeader(reader: EbmlReader): ElementHeader {
  const id = reader.readId()
  const size = reader.readSize()
  return { id, size }
}

/** End offset of an element, falling back to the parent end when size is unknown. */
function dataEndFor(reader: EbmlReader, header: ElementHeader, parentEnd: number): number {
  if (header.size === null) return parentEnd
  return Math.min(reader.pos + header.size, parentEnd)
}

interface WebmTrackInfo {
  number: number
  codec: string
  width: number
  height: number
  codecPrivate?: Uint8Array
  defaultDurationNs: number
}

interface RawSample {
  timestampTicks: number
  key: boolean
  data: Uint8Array
}

interface WebmState {
  /** Nanoseconds per cluster/block timestamp tick. */
  timestampScale: number
  /** Segment duration, in ticks (0 when the Info element omits it). */
  durationTicks: number
  track?: WebmTrackInfo
  samples: RawSample[]
}

/**
 * Demux a complete WebM/Matroska file (already in memory) into the video track
 * and its samples.
 *
 * Only the elements a background clip needs are parsed: `Info`,
 * `Tracks`/`TrackEntry` and `Cluster` blocks. Streaming layouts (unknown-size
 * Segment/Cluster) are supported because the whole file is available; other
 * top-level elements (`SeekHead`, `Cues`, `Tags`, …) are skipped by size.
 */
export function parseWebm(buffer: ArrayBuffer): ParsedVideo {
  const reader = new EbmlReader(new DataView(buffer))

  const ebmlHeader = readHeader(reader)
  if (ebmlHeader.id !== ID_EBML) throw new Error('WebM: missing EBML header.')
  if (ebmlHeader.size === null) throw new Error('WebM: EBML header has unknown size.')
  reader.pos += ebmlHeader.size

  const segmentHeader = readHeader(reader)
  if (segmentHeader.id !== ID_SEGMENT) throw new Error('WebM: missing Segment.')
  const segmentEnd = segmentHeader.size === null ? reader.end : reader.pos + segmentHeader.size

  const state: WebmState = { timestampScale: DEFAULT_TIMESTAMP_SCALE, durationTicks: 0, samples: [] }

  while (reader.pos < segmentEnd) {
    const header = readHeader(reader)

    // Unknown-size elements (common for the Segment, sometimes Clusters) are
    // parsed directly; the parsers stop at the next sibling instead of a limit.
    if (header.size === null) {
      switch (header.id) {
        case ID_INFO:
          parseInfo(reader, segmentEnd, state)
          break
        case ID_TRACKS:
          parseTracks(reader, segmentEnd, state)
          break
        case ID_CLUSTER:
          parseCluster(reader, segmentEnd, state)
          break
        default:
          reader.pos = segmentEnd
          break
      }
      continue
    }

    const dataEnd = reader.pos + header.size
    switch (header.id) {
      case ID_INFO:
        parseInfo(reader, dataEnd, state)
        break
      case ID_TRACKS:
        parseTracks(reader, dataEnd, state)
        break
      case ID_CLUSTER:
        parseCluster(reader, dataEnd, state)
        break
      default:
        break
    }
    reader.pos = dataEnd
  }

  const info = state.track
  if (!info || state.samples.length === 0) {
    throw new Error('Could not read a video track from the WebM.')
  }
  return buildParsedVideo(state, info)
}

function parseInfo(reader: EbmlReader, end: number, state: WebmState): void {
  while (reader.pos < end) {
    const header = readHeader(reader)
    const dataEnd = dataEndFor(reader, header, end)
    const length = dataEnd - reader.pos
    if (header.id === ID_TIMESTAMP_SCALE) {
      const scale = reader.readUint(length)
      if (scale > 0) state.timestampScale = scale
    } else if (header.id === ID_DURATION) {
      state.durationTicks = reader.readFloat(length)
    }
    reader.pos = dataEnd
  }
}

function parseTracks(reader: EbmlReader, end: number, state: WebmState): void {
  while (reader.pos < end) {
    const header = readHeader(reader)
    const dataEnd = dataEndFor(reader, header, end)
    if (header.id === ID_TRACK_ENTRY) parseTrackEntry(reader, dataEnd, state)
    reader.pos = dataEnd
  }
}

function parseTrackEntry(reader: EbmlReader, end: number, state: WebmState): void {
  let number = 0
  let type = 0
  let codec = ''
  let codecPrivate: Uint8Array | undefined
  let defaultDurationNs = 0
  const size = { width: 0, height: 0 }

  while (reader.pos < end) {
    const header = readHeader(reader)
    const dataEnd = dataEndFor(reader, header, end)
    const length = dataEnd - reader.pos
    switch (header.id) {
      case ID_TRACK_NUMBER:
        number = reader.readUint(length)
        break
      case ID_TRACK_TYPE:
        type = reader.readUint(length)
        break
      case ID_CODEC_ID:
        codec = reader.readString(length)
        break
      case ID_CODEC_PRIVATE:
        codecPrivate = reader.readBytes(length)
        break
      case ID_DEFAULT_DURATION:
        defaultDurationNs = reader.readUint(length)
        break
      case ID_VIDEO:
        parseVideoSettings(reader, dataEnd, size)
        break
      default:
        break
    }
    reader.pos = dataEnd
  }

  // TrackType 1 is video. Keep the first video track; background clips have one.
  if (type === 1 && !state.track) {
    state.track = {
      number,
      codec,
      width: size.width,
      height: size.height,
      codecPrivate,
      defaultDurationNs,
    }
  }
}

function parseVideoSettings(reader: EbmlReader, end: number, out: { width: number; height: number }): void {
  while (reader.pos < end) {
    const header = readHeader(reader)
    const dataEnd = dataEndFor(reader, header, end)
    const length = dataEnd - reader.pos
    if (header.id === ID_PIXEL_WIDTH) out.width = reader.readUint(length)
    else if (header.id === ID_PIXEL_HEIGHT) out.height = reader.readUint(length)
    reader.pos = dataEnd
  }
}

function isClusterChild(id: number): boolean {
  return (
    id === ID_CLUSTER_TIMESTAMP ||
    id === ID_SIMPLE_BLOCK ||
    id === ID_BLOCK_GROUP ||
    id === ID_SILENT_TRACKS ||
    id === ID_POSITION ||
    id === ID_PREV_SIZE ||
    id === ID_ENCRYPTED_BLOCK
  )
}

function parseCluster(reader: EbmlReader, end: number, state: WebmState): void {
  let timecode = 0
  while (reader.pos < end) {
    const saved = reader.pos
    const header = readHeader(reader)
    // An unknown-size Cluster ends where the next sibling element begins.
    if (!isClusterChild(header.id)) {
      reader.pos = saved
      return
    }
    const dataEnd = dataEndFor(reader, header, end)
    switch (header.id) {
      case ID_CLUSTER_TIMESTAMP:
        timecode = reader.readUint(dataEnd - reader.pos)
        break
      case ID_SIMPLE_BLOCK:
        parseBlock(reader.view, reader.pos, dataEnd, timecode, state, null)
        break
      case ID_BLOCK_GROUP:
        parseBlockGroup(reader.view, reader.pos, dataEnd, timecode, state)
        break
      default:
        break
    }
    reader.pos = dataEnd
  }
}

function parseBlockGroup(
  view: DataView,
  start: number,
  end: number,
  timecode: number,
  state: WebmState,
): void {
  const reader = new EbmlReader(view, start)
  let blockStart = -1
  let blockEnd = -1
  let hasReference = false

  while (reader.pos < end) {
    const header = readHeader(reader)
    const dataEnd = dataEndFor(reader, header, end)
    if (header.id === ID_BLOCK) {
      blockStart = reader.pos
      blockEnd = dataEnd
    } else if (header.id === ID_REFERENCE_BLOCK) {
      hasReference = true
    }
    reader.pos = dataEnd
  }

  // A BlockGroup without a ReferenceBlock marks a keyframe.
  if (blockStart >= 0) parseBlock(view, blockStart, blockEnd, timecode, state, !hasReference)
}

function parseBlock(
  view: DataView,
  start: number,
  end: number,
  timecode: number,
  state: WebmState,
  groupKey: boolean | null,
): void {
  const info = state.track
  if (!info) return
  const reader = new EbmlReader(view, start)
  const trackNumber = readVint(reader)
  if (reader.pos + 3 > end) return
  const relative = reader.readInt16()
  const flags = reader.readUint(1)
  if (trackNumber !== info.number) return

  const key = groupKey === null ? (flags & 0x80) !== 0 : groupKey
  for (const frame of splitLacedFrames(view, reader.pos, end, flags)) {
    state.samples.push({
      timestampTicks: timecode + relative,
      key,
      data: new Uint8Array(view.buffer, view.byteOffset + frame[0], frame[1] - frame[0]),
    })
  }
}

/** Read an EBML variable-length integer with its marker bit stripped. */
function readVint(reader: EbmlReader): number {
  const first = reader.view.getUint8(reader.pos)
  const length = vintLength(first)
  if (length === 0) throw new Error('WebM: invalid VINT.')
  const mask = 0xff >> length
  let value = first & mask
  reader.pos += 1
  for (let i = 1; i < length; i++) {
    value = value * 256 + reader.view.getUint8(reader.pos)
    reader.pos += 1
  }
  return value
}

/**
 * Split a Block's payload into frames. WebM video is usually un-laced, but all
 * four Matroska lacing modes are handled so multiplexed files stay correct.
 */
function splitLacedFrames(view: DataView, start: number, end: number, flags: number): Array<[number, number]> {
  const lacing = (flags >> 1) & 0x03
  if (lacing === 0 || start >= end) return [[start, end]]

  const reader = new EbmlReader(view, start)
  const count = view.getUint8(reader.pos) + 1
  reader.pos += 1
  const sizes: number[] = []
  const total = (): number => sizes.reduce((sum, size) => sum + size, 0)

  if (lacing === 2) {
    // Fixed-size lacing: every frame has the same length.
    const each = Math.floor((end - reader.pos) / count)
    for (let i = 0; i < count; i++) sizes.push(each)
    reader.pos += each * count
  } else if (lacing === 1) {
    // Xiph lacing: each size is the sum of bytes until one is < 255.
    for (let i = 0; i < count - 1; i++) {
      let size = 0
      let byte = 255
      while (byte === 255 && reader.pos < end) {
        byte = view.getUint8(reader.pos)
        reader.pos += 1
        size += byte
      }
      sizes.push(size)
    }
    sizes.push(end - reader.pos - total())
  } else {
    // EBML lacing: first size is unsigned, the rest are signed deltas.
    sizes.push(readVint(reader))
    for (let i = 1; i < count - 1; i++) {
      const byte = view.getUint8(reader.pos)
      const length = vintLength(byte)
      let raw = byte & (0xff >> length)
      reader.pos += 1
      for (let j = 1; j < length; j++) {
        raw = raw * 256 + view.getUint8(reader.pos)
        reader.pos += 1
      }
      const bias = Math.pow(2, 7 * length - 1) - 1
      sizes.push(sizes[sizes.length - 1] + raw - bias)
    }
    sizes.push(end - reader.pos - total())
  }

  const frames: Array<[number, number]> = []
  let offset = reader.pos
  for (const size of sizes) {
    if (size < 0 || offset + size > end) return [[start, end]]
    frames.push([offset, offset + size])
    offset += size
  }
  return frames
}

function buildParsedVideo(state: WebmState, info: WebmTrackInfo): ParsedVideo {
  // Timestamps are in `timestampScale` units (nanoseconds); WebCodecs wants µs.
  const ticksToUs = state.timestampScale / 1000
  const defaultDurationUs = info.defaultDurationNs > 0 ? Math.round(info.defaultDurationNs / 1000) : 0
  const raws = state.samples

  let baseTimestamp = Math.round(raws[0].timestampTicks * ticksToUs)
  for (const raw of raws) {
    const timestamp = Math.round(raw.timestampTicks * ticksToUs)
    if (timestamp < baseTimestamp) baseTimestamp = timestamp
  }

  const samples: VideoSample[] = raws.map((raw, index) => {
    const timestamp = Math.round(raw.timestampTicks * ticksToUs)
    let duration = 0
    if (index + 1 < raws.length) duration = Math.round(raws[index + 1].timestampTicks * ticksToUs) - timestamp
    if (duration <= 0 && index > 0) duration = timestamp - Math.round(raws[index - 1].timestampTicks * ticksToUs)
    if (duration <= 0) duration = defaultDurationUs
    return { data: raw.data, timestamp, duration: Math.max(0, duration), key: raw.key }
  })

  const last = samples[samples.length - 1]
  const durationSeconds =
    state.durationTicks > 0
      ? (state.durationTicks * state.timestampScale) / 1e9
      : (last.timestamp + last.duration - baseTimestamp) / 1e6

  const track: VideoTrack = {
    id: info.number,
    codec: webmCodecString(info.codec, info.codecPrivate),
    width: info.width,
    height: info.height,
    timescale: Math.round(1e9 / state.timestampScale),
    durationSeconds,
    frameCount: samples.length,
    description: webmDescription(info.codec, info.codecPrivate),
  }
  return { track, samples, baseTimestamp }
}

// ── Codec mapping ──────────────────────────────────────────────────────────

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function webmCodecString(codecId: string, codecPrivate?: Uint8Array): string {
  switch (codecId) {
    case 'V_VP8':
      return 'vp8'
    case 'V_VP9':
      return vp9CodecString(codecPrivate)
    case 'V_AV1':
      return av1CodecString(codecPrivate)
    case 'V_MPEG4/ISO/AVC':
      return avcCodecString(codecPrivate)
    default:
      throw new Error(`WebM: unsupported codec "${codecId}".`)
  }
}

/** Codec-private data to hand to `VideoDecoder.configure`, when required. */
function webmDescription(codecId: string, codecPrivate?: Uint8Array): Uint8Array | undefined {
  if (!codecPrivate || codecPrivate.byteLength === 0) return undefined
  if (codecId === 'V_AV1' || codecId === 'V_MPEG4/ISO/AVC') return codecPrivate
  return undefined
}

/** Matroska VP9 CodecPrivate: `[0x01, profile, level, bitDepth, …]`. */
function vp9CodecString(codecPrivate?: Uint8Array): string {
  if (!codecPrivate || codecPrivate.byteLength < 4 || codecPrivate[0] !== 0x01) {
    return 'vp09.00.10.08'
  }
  const profile = codecPrivate[1] & 0x07
  const level = codecPrivate[2] || 10
  const bitDepth = 8 + ((codecPrivate[3] >> 4) & 0x0f)
  return `vp09.${pad2(profile)}.${pad2(level)}.${pad2(bitDepth)}`
}

/** AV1CodecConfigurationRecord: marker/version, then profile/level/tier flags. */
function av1CodecString(codecPrivate?: Uint8Array): string {
  if (!codecPrivate || codecPrivate.byteLength < 3 || codecPrivate[0] !== 0x81) {
    return 'av01.0.04M.08'
  }
  const profile = (codecPrivate[1] >> 5) & 0x07
  const level = codecPrivate[1] & 0x1f
  const tier = (codecPrivate[2] >> 7) & 0x01
  const highBitDepth = (codecPrivate[2] >> 6) & 0x01
  const twelveBit = (codecPrivate[2] >> 5) & 0x01
  const bitDepth = twelveBit ? 12 : highBitDepth ? 10 : 8
  return `av01.${profile}.${pad2(level)}${tier ? 'H' : 'M'}.${pad2(bitDepth)}`
}

/** Matroska AVC CodecPrivate is an AVCDecoderConfigurationRecord. */
function avcCodecString(codecPrivate?: Uint8Array): string {
  if (!codecPrivate || codecPrivate.byteLength < 4) {
    throw new Error('WebM: H.264 track is missing its codec private data.')
  }
  const hex = [codecPrivate[1], codecPrivate[2], codecPrivate[3]]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `avc1.${hex}`
}
