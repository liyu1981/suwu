import { clamp } from '../../../../lib/utils'
import { resolveVideoParams, VIDEO_MAX_DURATION_SECONDS, type VideoParams } from '../params'
import { coverSourceRect } from './fit'
import { parseMp4, type Mp4Sample, type Mp4VideoTrack, type ParsedMp4 } from './mp4'
import { readVideoFile } from './storage'
import type { BackgroundContext, BackgroundHandle } from '../../types'

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

function decoderConfig(track: Mp4VideoTrack): VideoDecoderConfig {
  const config: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.width,
    codedHeight: track.height,
    optimizeForLatency: true,
  }
  if (track.description && track.description.byteLength > 0) {
    config.description = track.description.slice()
  }
  return config
}

function toChunk(sample: Mp4Sample): EncodedVideoChunk {
  return new EncodedVideoChunk({
    type: sample.key ? 'key' : 'delta',
    timestamp: sample.timestamp,
    duration: sample.duration,
    data: sample.data,
  })
}

/** Draw one decoded frame with the configured fit, then the colour mask. */
function renderSource(render: RenderCtx, frame: VideoFrame): void {
  const width = render.width()
  const height = render.height()
  const sourceWidth = frame.displayWidth
  const sourceHeight = frame.displayHeight
  if (width <= 0 || height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return

  const context = render.context
  if (render.config.fit === 'stretch') {
    context.drawImage(frame, 0, 0, width, height)
  } else {
    const rect = coverSourceRect(sourceWidth, sourceHeight, width, height)
    context.drawImage(frame, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, width, height)
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

/** Streaming forward playback that restarts at EOF. */
function createPlayback(
  parsed: ParsedMp4,
  render: RenderCtx,
  reducedMotion: boolean,
  onError: (error: unknown) => void,
): Playback {
  const samples = parsed.samples
  const base = parsed.baseTimestamp
  let decoder: VideoDecoder | null = null
  let pending: VideoFrame[] = []
  let current: VideoFrame | null = null
  let playheadUs = 0
  let lastNow = performance.now()
  let next = 0
  let flushing = false
  let paused = false
  let stopped = false
  let drewStatic = false

  const closePending = (): void => {
    for (const frame of pending) frame.close()
    pending = []
  }

  const onOutput = (frame: VideoFrame): void => {
    if (reducedMotion) {
      if (!drewStatic) {
        drewStatic = true
        current?.close()
        current = frame
        renderSource(render, frame)
      } else {
        frame.close()
      }
      return
    }
    pending.push(frame)
  }

  const pump = (): void => {
    const active = decoder
    if (!active || stopped || paused || flushing) return
    while (next < samples.length && active.decodeQueueSize < 16) {
      active.decode(toChunk(samples[next++]))
    }
    if (next >= samples.length) {
      flushing = true
      active.flush().then(
        () => {
          if (!stopped && !reducedMotion && active === decoder) restart()
        },
        () => undefined,
      )
    }
  }

  const restart = (): void => {
    if (stopped) return
    closePending()
    current?.close()
    current = null
    decoder?.close()
    next = 0
    flushing = false
    playheadUs = 0
    lastNow = performance.now()
    decoder = new VideoDecoder({ output: onOutput, error: onError })
    decoder.ondequeue = () => pump()
    decoder.configure(decoderConfig(parsed.track))
    pump()
  }

  restart()

  return {
    tick(now) {
      if (stopped || paused) return
      playheadUs += Math.min(now - lastNow, 100) * 1000 * render.config.speed
      lastNow = now

      let due: VideoFrame | null = null
      while (pending.length > 0 && pending[0].timestamp - base <= playheadUs) {
        const frame = pending.shift() as VideoFrame
        if (due) due.close()
        due = frame
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
      decoder?.close()
      decoder = null
    },
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Video background (canvas-2D + WebCodecs). Reads the clip the user picked from
 * OPFS, demuxes it with mp4box.js, decodes it with `VideoDecoder` and draws the
 * frames to the ambient canvas in a loop. No `<video>` element, no network
 * fetch and no audio.
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

  const onVisibility = (): void => {
    if (document.hidden) stop()
    else start()
  }
  const onBlur = (): void => stop()
  const onFocus = (): void => start()

  window.addEventListener('resize', resize)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('blur', onBlur)
  window.addEventListener('focus', onFocus)

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

    const buffer = await readVideoFile()
    if (disposed) return
    if (!buffer) {
      showMessage(['Video file not found', 'Choose it again in System Settings.'])
      return
    }

    let parsed: ParsedMp4
    try {
      parsed = parseMp4(buffer)
    } catch (error) {
      showMessage(['Could not read the video', describeError(error)])
      return
    }
    if (disposed) return

    try {
      const support = await VideoDecoder.isConfigSupported(decoderConfig(parsed.track))
      if (!support.supported) throw new Error(parsed.track.codec)
    } catch {
      showMessage(['Video codec not supported', parsed.track.codec])
      return
    }
    if (disposed) return

    if (parsed.track.durationSeconds > VIDEO_MAX_DURATION_SECONDS) {
      warning = `Long clip (${parsed.track.durationSeconds.toFixed(0)}s) — backgrounds are meant for short loops.`
      warningUntil = performance.now() + 8000
      console.info('[video]', warning)
    }

    playback = createPlayback(parsed, render, reducedMotion, (error) => {
      console.warn('[video] decoder error', error)
    })

    if (reducedMotion) {
      playback.tick(performance.now())
    } else {
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
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    },
  }
}
