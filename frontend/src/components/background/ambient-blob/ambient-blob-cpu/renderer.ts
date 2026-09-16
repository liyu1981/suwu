import { clamp } from '../../../../lib/utils'
import {
  BLOB_CORE_STOP,
  computeBlobFrame,
  makeBlobs,
  prefersReducedTransparency,
  resolveParams,
} from '../params'
import type { BlobSeed } from '../types'
import type { BackgroundContext, BackgroundHandle } from '../../types'

/**
 * Canvas-2D ambient blob renderer — the fallback used when WebGPU is
 * unavailable (or when the GPU device is lost).
 *
 * Unlike the original implementation it is throttled to `ctx.fps`, paused
 * while the tab is hidden or the window is blurred, and renders a single
 * static frame under `prefers-reduced-motion`.
 */
export async function startAmbientBlobCpu(
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle> {
  const { canvas, dpr: dprRange, fps, reducedMotion } = ctx
  const config = resolveParams(params)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('ambient-blob-cpu: 2D context unavailable')

  const dpr = clamp(window.devicePixelRatio || 1, dprRange[0], dprRange[1])
  const frameInterval = fps > 0 ? 1000 / fps : 0
  let blobs: BlobSeed[] = makeBlobs(config.palette, prefersReducedTransparency())
  let width = 0
  let height = 0
  let raf = 0
  let running = false
  let lastFrame = 0

  const render = (seconds: number): void => {
    context.clearRect(0, 0, width, height)
    context.globalCompositeOperation = 'lighter'
    for (const blob of computeBlobFrame(blobs, seconds, width, height)) {
      const [r, g, b] = blob.color
      const red = Math.round(r * 255)
      const green = Math.round(g * 255)
      const blue = Math.round(b * 255)
      const solid = `rgba(${red}, ${green}, ${blue}, ${blob.alpha})`
      const fade = `rgba(${red}, ${green}, ${blue}, 0)`
      const gradient = context.createRadialGradient(blob.x, blob.y, 0, blob.x, blob.y, blob.radius)
      gradient.addColorStop(0, solid)
      gradient.addColorStop(BLOB_CORE_STOP, solid)
      gradient.addColorStop(1, fade)
      context.fillStyle = gradient
      context.beginPath()
      context.arc(blob.x, blob.y, blob.radius, 0, Math.PI * 2)
      context.fill()
    }
    context.globalCompositeOperation = 'source-over'
  }

  const resize = (): void => {
    width = window.innerWidth
    height = window.innerHeight
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (!running) render(performance.now() / 1000)
  }

  const tick = (now: number): void => {
    if (!running) return
    if (now - lastFrame >= frameInterval) {
      lastFrame = now
      render(now / 1000)
    }
    raf = requestAnimationFrame(tick)
  }

  const start = (): void => {
    if (running || reducedMotion) return
    running = true
    lastFrame = performance.now()
    raf = requestAnimationFrame(tick)
  }

  const stop = (): void => {
    running = false
    cancelAnimationFrame(raf)
  }

  const onVisibility = (): void => {
    if (document.hidden) stop()
    else start()
  }

  const themeObserver = new MutationObserver(() => {
    blobs = makeBlobs(config.palette, prefersReducedTransparency())
    if (!running) render(performance.now() / 1000)
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

  window.addEventListener('resize', resize)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('blur', stop)
  window.addEventListener('focus', start)

  resize()
  if (reducedMotion) {
    render(performance.now() / 1000)
  } else {
    start()
  }

  return {
    backend: 'cpu',
    dispose() {
      stop()
      themeObserver.disconnect()
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', stop)
      window.removeEventListener('focus', start)
    },
  }
}
