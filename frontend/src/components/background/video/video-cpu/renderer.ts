import {
  BlobSource,
  Input,
  MATROSKA,
  MP4,
  QTFF,
  WEBM,
  VideoSampleSink,
  type InputVideoTrack,
  type VideoSample,
} from 'mediabunny'
import { clamp } from '../../../../lib/utils'
import { resolveVideoParams, VIDEO_MAX_DURATION_SECONDS, type VideoParams } from '../params'
import { coverSourceRect } from './fit'
import { canCrossfade, fadeProgress } from './loop'
import { readVideoBlob } from './storage'
import type { BackgroundContext, BackgroundHandle } from '../../types'

/** Containers a background clip may use; keeps the mediabunny bundle small. */
const INPUT_FORMATS = [MP4, QTFF, MATROSKA, WEBM]

/** Never hold more than this many decoded frames per stream. */
const MAX_PENDING_FRAMES = 3

/** Shared drawing surface + config, read live so resizes are picked up. */
interface RenderCtx {
  context: CanvasRenderingContext2D
  config: VideoParams
  width: () => number
  height: () => number
}

/** The running playback. */
interface Playback {
  tick(now: number): void
  /** Redraw the current frame (e.g. after the canvas was resized). */
  redraw(): void
  setPaused(paused: boolean): void
  dispose(): void
}

/** Draw one decoded frame with the configured fit at the given opacity. */
function drawFrame(render: RenderCtx, sample: VideoSample, alpha: number): void {
  const width = render.width()
  const height = render.height()
  const sourceWidth = sample.displayWidth
  const sourceHeight = sample.displayHeight
  if (width <= 0 || height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return

  const context = render.context
  context.save()
  context.globalAlpha = alpha
  if (render.config.fit === 'stretch') {
    sample.draw(context, 0, 0, width, height)
  } else {
    const rect = coverSourceRect(sourceWidth, sourceHeight, width, height)
    sample.draw(context, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, width, height)
  }
  context.restore()
}

/** Draw the configured colour mask over the whole surface. */
function drawMask(render: RenderCtx): void {
  const { maskColor, maskOpacity } = render.config
  if (maskOpacity <= 0) return
  const context = render.context
  context.save()
  context.globalAlpha = maskOpacity
  context.fillStyle = maskColor
  context.fillRect(0, 0, render.width(), render.height())
  context.restore()
}

/** One independent decode of the clip, advancing in lock-step with the others. */
interface Stream {
  /** Media time the stream has reached, in seconds. */
  readonly time: number
  /** Whether the underlying sample iterator is exhausted. */
  readonly ended: boolean
  hasFrame(): boolean
  advance(seconds: number): void
  draw(render: RenderCtx, alpha: number): void
  dispose(): void
}

/**
 * A lazily-decoded stream over a clip. mediabunny's `VideoSampleSink` gives
 * natural backpressure, so only a few frames are ever held at once.
 */
function createStream(
  sink: VideoSampleSink,
  firstTimestamp: number,
  onError: (error: unknown) => void,
): Stream {
  const iterator = sink.samples()[Symbol.asyncIterator]()
  let pending: VideoSample[] = []
  let current: VideoSample | null = null
  let pumping = false
  let ended = false
  let stopped = false
  let playhead = firstTimestamp

  const closePending = (): void => {
    for (const sample of pending) sample.close()
    pending = []
  }

  const pump = (): void => {
    if (stopped || pumping || ended) return
    pumping = true
    void (async () => {
      try {
        while (!stopped && !ended && pending.length < MAX_PENDING_FRAMES) {
          const result = await iterator.next()
          if (stopped) {
            if (!result.done) result.value.close()
            return
          }
          if (result.done) {
            ended = true
            break
          }
          pending.push(result.value)
        }
      } catch (error) {
        if (!stopped) onError(error)
      } finally {
        pumping = false
      }
    })()
  }

  pump()

  return {
    get time() {
      return playhead
    },
    get ended() {
      return ended
    },
    hasFrame() {
      return current !== null
    },
    advance(seconds) {
      if (stopped) return
      playhead += seconds
      let due: VideoSample | null = null
      while (pending.length > 0 && pending[0].timestamp <= playhead) {
        if (due) due.close()
        due = pending.shift() as VideoSample
      }
      if (due) {
        current?.close()
        current = due
      }
      pump()
    },
    draw(render, alpha) {
      if (current) drawFrame(render, current, alpha)
    },
    dispose() {
      stopped = true
      closePending()
      current?.close()
      current = null
      void iterator.return?.()
    },
  }
}

/**
 * Streaming playback that restarts at EOF, with an optional crossfade between
 * the end of one pass and the start of the next.
 *
 * At most two streams exist: the outgoing one plays to the end while a second
 * copy starts at the beginning. The outgoing frame is drawn opaque and the
 * incoming one is drawn over it at `fadeProgress` alpha, which (source-over)
 * yields the exact per-pixel mix `outgoing * (1 - p) + incoming * p`.
 */
function createLoopPlayback(
  sink: VideoSampleSink,
  firstTimestamp: number,
  duration: number,
  render: RenderCtx,
  crossfade: boolean,
  onError: (error: unknown) => void,
): Playback {
  const useCrossfade = crossfade && canCrossfade(duration)
  let streams: Stream[] = []
  let stopped = false
  let paused = false
  let lastNow = performance.now()

  const restart = (): void => {
    for (const stream of streams) stream.dispose()
    streams = [createStream(sink, firstTimestamp, onError)]
    lastNow = performance.now()
  }

  const blend = (): number => {
    if (streams.length < 2 || !streams[1].hasFrame()) return 0
    return fadeProgress(streams[0].time, firstTimestamp, duration)
  }

  const draw = (): void => {
    if (streams.length === 0) return
    const progress = blend()
    streams[0].draw(render, 1)
    if (progress > 0) streams[1].draw(render, progress)
    drawMask(render)
  }

  restart()

  return {
    tick(now) {
      if (stopped || paused || streams.length === 0) return
      const delta = (Math.min(now - lastNow, 100) / 1000) * render.config.speed
      lastNow = now
      for (const stream of streams) stream.advance(delta)

      const end = firstTimestamp + duration
      const outgoing = streams[0]

      // Open the blend window: start a fresh copy while the outgoing one ends.
      if (
        useCrossfade &&
        streams.length < 2 &&
        outgoing.time < end &&
        fadeProgress(outgoing.time, firstTimestamp, duration) > 0
      ) {
        streams.push(createStream(sink, firstTimestamp, onError))
      }

      if (outgoing.time >= end) {
        if (streams.length >= 2) {
          outgoing.dispose()
          streams.shift()
        } else {
          restart()
          return
        }
      }

      draw()
    },
    redraw: draw,
    setPaused(value) {
      paused = value
      lastNow = performance.now()
    },
    dispose() {
      stopped = true
      for (const stream of streams) stream.dispose()
      streams = []
    },
  }
}

/** A single frozen frame, used when the user prefers reduced motion. */
function createStaticPlayback(sample: VideoSample | null, render: RenderCtx): Playback {
  return {
    tick() {},
    redraw() {
      if (sample) drawFrame(render, sample, 1)
      drawMask(render)
    },
    setPaused() {},
    dispose() {
      sample?.close()
    },
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Video background (canvas-2D + WebCodecs). Reads the clip the user picked
 * from OPFS, demuxes and decodes it with mediabunny (`VideoSampleSink`) and
 * draws the frames to the ambient canvas in a loop. No `<video>` element, no
 * network fetch and no audio.
 */
export async function startVideo(
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle> {
  const config = resolveVideoParams(params)
  const { canvas, dpr: dprRange, fps, reducedMotion } = ctx
  const context = canvas.getContext('2d')
  if (!context) throw new Error('video-cpu: 2D context unavailable')

  const dpr = clamp(window.devicePixelRatio || 1, dprRange[0], dprRange[1])
  const frameInterval = fps > 0 ? 1000 / fps : 0

  let width = 0
  let height = 0
  let raf = 0
  let running = false
  let lastTick = 0
  let disposed = false
  let playback: Playback | null = null
  let input: Input | null = null
  let warning: string | null = null
  let warningUntil = 0

  const render: RenderCtx = {
    context,
    config,
    width: () => width,
    height: () => height,
  }

  const applyTransform = (): void => context.setTransform(dpr, 0, 0, dpr, 0, 0)

  const fillBackdrop = (): void => {
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.fillStyle = '#05060a'
    context.fillRect(0, 0, canvas.width, canvas.height)
    applyTransform()
  }

  const showMessage = (lines: string[]): void => {
    fillBackdrop()
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.fillStyle = 'rgba(255, 255, 255, 0.78)'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    const size = 13 * dpr
    context.font = `${size}px system-ui, sans-serif`
    const step = size * 1.6
    lines.forEach((line, i) => {
      context.fillText(line, canvas.width / 2, canvas.height / 2 + (i - (lines.length - 1) / 2) * step)
    })
    applyTransform()
  }

  const drawWarning = (): void => {
    if (!warning) return
    context.setTransform(1, 0, 0, 1, 0, 0)
    const size = 12 * dpr
    context.font = `${size}px system-ui, sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'bottom'
    const pad = size * 0.7
    const metrics = context.measureText(warning)
    context.fillStyle = 'rgba(0, 0, 0, 0.55)'
    context.fillRect(
      canvas.width / 2 - metrics.width / 2 - pad,
      canvas.height - size - pad * 3,
      metrics.width + pad * 2,
      size + pad * 2,
    )
    context.fillStyle = 'rgba(255, 235, 190, 0.92)'
    context.fillText(warning, canvas.width / 2, canvas.height - pad * 2)
    applyTransform()
  }

  const resize = (): void => {
    width = window.innerWidth
    height = window.innerHeight
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    applyTransform()
    playback?.redraw()
  }

  const tick = (now: number): void => {
    if (!running) return
    if (now - lastTick >= frameInterval) {
      lastTick = now
      playback?.tick(now)
      if (warning && now < warningUntil) drawWarning()
    }
    raf = requestAnimationFrame(tick)
  }

  const start = (): void => {
    if (running || reducedMotion) return
    running = true
    lastTick = performance.now()
    playback?.setPaused(false)
    raf = requestAnimationFrame(tick)
  }

  const stop = (): void => {
    running = false
    cancelAnimationFrame(raf)
    playback?.setPaused(true)
  }

  // The clip is ambient: it keeps looping regardless of where focus lands.
  // Only a hidden tab pauses it (rAF stops there anyway).
  const onVisibility = (): void => {
    if (document.hidden) stop()
    else start()
  }

  window.addEventListener('resize', resize)
  document.addEventListener('visibilitychange', onVisibility)

  resize()

  const run = async (): Promise<void> => {
    if (!config.source) {
      showMessage(['Video background', 'Choose a video file in System Settings.'])
      return
    }
    if (typeof VideoDecoder === 'undefined') {
      showMessage(['WebCodecs is not supported', 'This browser cannot decode video.'])
      return
    }

    showMessage(['Loading video…'])

    const file = await readVideoBlob(config.source)
    if (disposed) return
    if (!file) {
      showMessage(['Video file not found', 'Choose it again in System Settings.'])
      return
    }

    let track: InputVideoTrack | null
    try {
      input = new Input({ formats: INPUT_FORMATS, source: new BlobSource(file) })
      track = await input.getPrimaryVideoTrack()
    } catch (error) {
      showMessage(['Could not read the video', describeError(error)])
      return
    }
    if (disposed) return
    if (!track) {
      showMessage(['No video track', 'The file has no video stream.'])
      return
    }

    let decodable = false
    try {
      decodable = await track.canDecode()
    } catch {
      decodable = false
    }
    if (!decodable) {
      const codec = await track.getCodecParameterString().catch(() => null)
      showMessage(['Video codec not supported', codec ?? 'unknown'])
      return
    }
    if (disposed) return

    const [duration, baseTimestamp] = await Promise.all([
      track.computeDuration().catch(() => 0),
      track.getFirstTimestamp().catch(() => 0),
    ])
    if (disposed) return

    if (duration > VIDEO_MAX_DURATION_SECONDS) {
      warning = `Long clip (${duration.toFixed(0)}s) — backgrounds are meant for short loops.`
      warningUntil = performance.now() + 8000
      console.info('[video]', warning)
    }

    const sink = new VideoSampleSink(track)
    if (reducedMotion) {
      const sample = await sink.getSample(baseTimestamp).catch(() => null)
      if (disposed) {
        sample?.close()
        return
      }
      playback = createStaticPlayback(sample, render)
    } else {
      playback = createLoopPlayback(sink, baseTimestamp, duration, render, config.crossfade, (error) => {
        console.warn('[video] playback error', error)
      })
      start()
    }
  }

  void run()

  return {
    backend: 'cpu',
    dispose() {
      disposed = true
      stop()
      playback?.dispose()
      playback = null
      input?.dispose()
      input = null
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
