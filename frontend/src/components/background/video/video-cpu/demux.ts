import { parseMp4 } from './mp4'
import { parseWebm } from './webm'
import type { ParsedVideo } from './types'

const EBML_MAGIC = 0x1a45dfa3

/**
 * Demux an in-memory clip, choosing the parser from the container signature:
 * EBML for WebM/Matroska, otherwise ISO-BMFF (MP4/MOV). Falling back to MP4
 * keeps `moov`-first MOV files working, which have no `ftyp` box.
 */
export function parseVideo(buffer: ArrayBuffer): ParsedVideo {
  if (buffer.byteLength >= 4 && new DataView(buffer).getUint32(0) === EBML_MAGIC) return parseWebm(buffer)
  return parseMp4(buffer)
}

export type { ParsedVideo, VideoSample, VideoTrack } from './types'
