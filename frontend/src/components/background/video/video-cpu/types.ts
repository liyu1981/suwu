/**
 * Container-agnostic demux output shared by the MP4 and WebM backends.
 *
 * Both demuxers describe the same thing: a single video track plus its samples
 * in decode order, ready to be turned into `EncodedVideoChunk`s.
 */

/** Video-track metadata needed to configure a WebCodecs `VideoDecoder`. */
export interface VideoTrack {
  readonly id: number
  readonly codec: string
  readonly width: number
  readonly height: number
  readonly timescale: number
  readonly durationSeconds: number
  readonly frameCount: number
  /**
   * Codec-private data for `VideoDecoder.configure` (MP4 `avcC`/`hvcC`/`av1C`,
   * WebM `CodecPrivate`). Left undefined for codecs that do not need it (VP8,
   * VP9).
   */
  readonly description?: Uint8Array
}

/** One sample, ready to become an `EncodedVideoChunk`. */
export interface VideoSample {
  readonly data: Uint8Array
  /** Presentation timestamp, in microseconds. */
  readonly timestamp: number
  /** Presentation duration, in microseconds. */
  readonly duration: number
  readonly key: boolean
}

/** A demuxed clip: one video track plus its samples in decode order. */
export interface ParsedVideo {
  readonly track: VideoTrack
  readonly samples: VideoSample[]
  /** Smallest presentation timestamp across samples (microseconds). */
  readonly baseTimestamp: number
}
