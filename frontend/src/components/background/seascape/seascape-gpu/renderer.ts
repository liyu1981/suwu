import { effect, frame, frameLoop, init, sampler, surface, target } from 'vgpu'
import type { Effect, Frame, FrameLoopHandle, Surface, Target } from 'vgpu'
import { resolveSeascapeParams, SEASCAPE_SPEED_BASE } from '../params'
import blitShader from './shaders/blit.wgsl'
import seascapeShader from './shaders/seascape.wgsl'
import type { BackgroundContext, BackgroundHandle } from '../../types'

// Cap the traced resolution. The sea is cheap for a raymarcher, but the canvas
// can be many megapixels at DPR 2; the blit pass upscales the capped target.
const MAX_MEGAPIXELS = 1.3

/**
 * Time base shared across backend restarts: changing a setting tears the
 * renderer down and starts a new GPU device, and reading `performance.now()`
 * against a module-level epoch keeps the waves from snapping back to t = 0.
 */
const TIME_EPOCH = typeof performance !== 'undefined' ? performance.now() : 0

/** Canvas size clamped to the megapixel budget, preserving aspect ratio. */
function internalSize(width: number, height: number): [number, number] {
  const pixels = width * height
  const budget = MAX_MEGAPIXELS * 1_000_000
  if (pixels <= budget) return [Math.max(2, width), Math.max(2, height)]
  const scale = Math.sqrt(pixels / budget)
  return [Math.max(2, Math.round(width / scale)), Math.max(2, Math.round(height / scale))]
}

/**
 * Seascape (GPU only) — a raymarched ocean ported from the Shadertoy demo by
 * Alexander Alekseev aka TDM (https://www.shadertoy.com/view/Ms2SD1).
 *
 * One fragment pass traces the sea into a capped offscreen target, a second
 * blits it to the canvas. The user's animation-speed setting scales the clock.
 * On a browser without WebGPU the selector renders nothing.
 */
export async function startSeascape(
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle> {
  const { speed } = resolveSeascapeParams(params)
  const gpu = await init({ powerPreference: 'low-power' })

  let disposed = false
  let loop: FrameLoopHandle | undefined
  let unsubscribeResize: (() => void) | undefined
  let pendingRedraw = 0

  const teardown = (): void => {
    if (disposed) return
    disposed = true
    if (pendingRedraw) cancelAnimationFrame(pendingRedraw)
    loop?.stop()
    unsubscribeResize?.()
    // gpu.dispose() releases the owned surface and offscreen target.
    gpu.dispose()
  }

  try {
    const canvasSurface: Surface = surface(gpu, ctx.canvas, {
      dpr: ctx.dpr,
      clearColor: [0, 0, 0, 1],
      label: 'seascape',
    })

    const [initialWidth, initialHeight] = internalSize(
      canvasSurface.size[0],
      canvasSurface.size[1],
    )
    const scene: Target = target(gpu, {
      size: [initialWidth, initialHeight],
      format: 'rgba16float',
      clearColor: [0, 0, 0, 1],
      label: 'seascape-scene',
    })

    const seascape: Effect = effect(gpu, seascapeShader, {
      label: 'seascape',
      set: {
        params: { resolution: [initialWidth, initialHeight], time: 0, _pad: 0 },
      },
    })

    const blit: Effect = effect(gpu, blitShader, {
      label: 'seascape-blit',
      set: {
        src: scene,
        samp: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
      },
    })

    // Wall-clock seconds since this module loaded, so restarts stay continuous.
    const elapsed = (): number => (performance.now() - TIME_EPOCH) / 1000

    const encode = (current: Frame): void => {
      seascape.set({ params: { time: elapsed() * speed * SEASCAPE_SPEED_BASE } })
      current.pass(scene, seascape)
      current.pass({ target: canvasSurface, clear: [0, 0, 0, 1] }, blit)
    }

    unsubscribeResize = canvasSurface.onResize(({ width, height }) => {
      if (disposed) return
      const [w, h] = internalSize(width, height)
      scene.resize([w, h])
      seascape.set({ params: { resolution: [w, h] } })
      // frame() must not run inside the resize callback, so defer a redraw.
      if (ctx.reducedMotion) {
        cancelAnimationFrame(pendingRedraw)
        pendingRedraw = requestAnimationFrame(() => {
          if (!disposed) frame(gpu, encode)
        })
      }
    })

    if (ctx.reducedMotion) {
      frame(gpu, encode)
    } else {
      loop = frameLoop(gpu, encode, { fps: ctx.fps })
    }

    return { backend: 'gpu', dispose: teardown }
  } catch (error) {
    teardown()
    throw error
  }
}
