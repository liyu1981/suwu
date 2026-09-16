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
import { readVideoBlob } from './storage'
import type { BackgroundContext, BackgroundHandle } from '../../types'

/** Containers a background clip may use; keeps the mediabunny bundle small. */
const INPUT_FORMATS = [MP4, QTFF, MATROSKA, WEBM]

/** Never hold more than this many decoded frames; mediabunny pre-decodes ahead. */
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

/** Draw one decoded frame with the configured fit, then the colour mask. */
function renderSource(render: RenderCtx, sample: VideoSample): void {
  const width = render.width()
  const height = render.height()
  const sourceWidth = sample.displayWidth
  const sourceHeight = sample.displayHeight
  if (width <= 0 || height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return

  const context = render.context
  if (render.config.fit === 'stretch') {
    sample.draw(context, 0, 0, width, height)
  } else {
    const rect = coverSourceRect(sourceWidth, sourceHeight, width, height)
    sample.draw(context, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, width, height)
  }

  const { maskColor, maskOpacity } = render.config
  if (maskOpacity > 0) {
    context.save()
    context.globalAlpha = maskOpacity
    context.fillStyle = maskColor
    context.fillRect(0, 0, width, height)
    context.restore()
  }
}

/**
 * Streaming forward playback that restarts at EOF. Frames come from a
 * mediabunny `VideoSampleSink`, which demuxes and decodes lazily and yields
 * them in presentation order, so memory stays bounded no matter the clip
 * length.
 */
function createPlayback(
  sink: VideoSampleSink,
  baseTimestamp: number,
  render: RenderCtx,
  onError: (error: unknown) => void,
): Playback {
  let iterator = sink.samples()[Symbol.asyncIterator]()
  let pending: VideoSample[] = []
  let current: VideoSample | null = null
  let pumping = false
  let ended = false
  let stopped = false
  let paused = false
  let playheadUs = 0
  let lastNow = performance.now()

  const closePending = (): void => {
    for (const sample of pending) sample.close()
    pending = []
  }

  // Pull only enough frames to keep the pipeline fed; the async iterator gives
  // natural backpressure, so decoding never runs away on a long clip.
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

  const restart = (): void => {
    if (stopped) return
    closePending()
    current?.close()
    current = null
    ended = false
    playheadUs = 0
    lastNow = performance.now()
    iterator = sink.samples()[Symbol.asyncIterator]()
    pump()
  }

  restart()

  return {
    tick(now) {
      if (stopped || paused) return
      if (ended && pending.length === 0) {
        restart()
        return
      }

      playheadUs += Math.min(now - lastNow, 100) * 1000 * render.config.speed
      lastNow = now
      const playheadSeconds = baseTimestamp + playheadUs / 1e6

      let due: VideoSample | null = null
      while (pending.length > 0 && pending[0].timestamp <= playheadSeconds) {
        if (due) due.close()
        due = pending.shift() as VideoSample
      }
      if (due) {
        current?.close()
        current = due
        renderSource(render, due)
      }
      pump()
    },
    redraw() {
      if (current) renderSource(render, current)
    },
    setPaused(value) {
      paused = value
      lastNow = performance.now()
      if (!value) pump()
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

/** A single frozen frame, used when the user prefers reduced motion. */
function createStaticPlayback(sample: VideoSample | null, render: RenderCtx): Playback {
  return {
    tick() {},
    redraw() {
      if (sample) renderSource(render, sample)
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

    const file = await readVideoBlob()
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
      playback = createPlayback(sink, baseTimestamp, render, (error) => {
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
