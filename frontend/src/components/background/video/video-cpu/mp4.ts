import { createFile, DataStream, MP4BoxBuffer, type ISOFile, type Sample, type Track } from 'mp4box'
import type { ParsedVideo, VideoSample } from './types'

interface SampleEntryBox {
  avcC?: { write(stream: DataStream): void }
  hvcC?: { write(stream: DataStream): void }
  av1C?: { write(stream: DataStream): void }
  vpcC?: { write(stream: DataStream): void }
}

interface TrakShape {
  mdia?: { minf?: { stbl?: { stsd?: { entries?: SampleEntryBox[] } } } }
}

/** Serialise the codec-private box, dropping the 8-byte box header. */
function buildDescription(file: ISOFile, trackId: number): Uint8Array | undefined {
  const trak = file.getTrackById(trackId) as unknown as TrakShape
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries
  if (!entries) return undefined
  for (const entry of entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.av1C ?? entry.vpcC
    if (box) {
      const stream = new DataStream(undefined, 0)
      box.write(stream)
      return new Uint8Array(stream.buffer, 8)
    }
  }
  return undefined
}

/**
 * Demux a complete MP4 file (already in memory) into a video-track description
 * and its samples, in decode order. Short background clips make a full-file
 * buffer the simplest path; streaming/`Range` demuxing can be added later.
 */
export function parseMp4(buffer: ArrayBuffer): ParsedVideo {
  const file = createFile()
  const samples: Sample[] = []
  // Callback results live in holders: TS cannot see assignments made inside the
  // mp4box callbacks, so a plain `let` would be narrowed to `undefined`.
  const trackRef: { value?: Track } = {}
  const errorRef: { value?: Error } = {}

  file.onError = (module, message) => {
    errorRef.value = new Error(`${module}: ${message}`)
  }
  file.onReady = (info) => {
    if (info.videoTracks.length === 0) {
      errorRef.value = new Error('The file has no video track.')
      return
    }
    const video = info.videoTracks[0]
    trackRef.value = video
    file.setExtractionOptions(video.id, null, { nbSamples: Math.max(1, video.nb_samples) })
    file.start()
  }
  file.onSamples = (_id, _user, batch) => {
    samples.push(...batch)
  }

  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0), true)
  file.flush()

  const track = trackRef.value
  if (errorRef.value) throw errorRef.value
  if (!track || samples.length === 0) {
    throw new Error('Could not read a video track from the MP4.')
  }

  const timescale = track.timescale || 1
  const mapped: VideoSample[] = samples.map((sample) => {
    const scale = sample.timescale || timescale
    return {
      data: sample.data ?? new Uint8Array(),
      timestamp: Math.round((sample.cts / scale) * 1e6),
      duration: Math.round((sample.duration / scale) * 1e6),
      key: sample.is_sync,
    }
  })

  let baseTimestamp = mapped[0].timestamp
  for (const sample of mapped) {
    if (sample.timestamp < baseTimestamp) baseTimestamp = sample.timestamp
  }

  return {
    track: {
      id: track.id,
      codec: track.codec,
      width: track.video?.width ?? track.track_width,
      height: track.video?.height ?? track.track_height,
      timescale,
      durationSeconds: track.duration / timescale,
      frameCount: track.nb_samples,
      description: buildDescription(file, track.id),
    },
    samples: mapped,
    baseTimestamp,
  }
}
