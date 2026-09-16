import { effect, frame, frameLoop, init, pingPong, sampler, surface } from 'vgpu'
import type { Effect, Frame, FrameLoopHandle, PingPongTargets, Surface, Target } from 'vgpu'
import { resolveRainforestParams, RAINFOREST_DETAIL_BUDGETS } from '../params'
import displayShader from './shaders/display.wgsl'
import rainforestShader from './shaders/rainforest.wgsl'
import type { BackgroundContext, BackgroundHandle } from '../../types'

// Reduced motion: settle the reprojection, then show one static frame.
const SETTLE_FRAMES = 16

/**
 * Time base shared across backend restarts: changing a setting starts a new GPU
 * device, and reading `performance.now()` against a module-level epoch keeps the
 * camera drift from snapping back to t = 0.
 */
const TIME_EPOCH = typeof performance !== 'undefined' ? performance.now() : 0

/** Canvas size clamped to the detail budget, preserving aspect ratio. */
function internalSize(width: number, height: number, budget: number): [number, number] {
  const pixels = width * height
  if (!(pixels > budget) || !Number.isFinite(budget)) {
    return [Math.max(2, width), Math.max(2, height)]
  }
  const scale = Math.sqrt(pixels / budget)
  return [Math.max(2, Math.round(width / scale)), Math.max(2, Math.round(height / scale))]
}

/**
 * Rainforest (GPU only) — a raymarched forest landscape ported from the
 * Shadertoy demo by Inigo Quilez (https://www.shadertoy.com/view/4ttSWf), used
 * with the author's permission.
 *
 * The original's Buffer A + Image passes become a ping-pong accumulation target
 * (the demo's temporal reprojection reads the previous frame and the camera
 * matrix it stores in the first three texels) plus a vignette blit to the
 * canvas. On a browser without WebGPU the selector renders nothing.
 */
export async function startRainforest(
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle> {
  const { speed, detail } = resolveRainforestParams(params)
  const megapixels = RAINFOREST_DETAIL_BUDGETS[detail]
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
    // gpu.dispose() releases the owned surface and ping-pong targets.
    gpu.dispose()
  }

  try {
    const canvasSurface: Surface = surface(gpu, ctx.canvas, {
      dpr: ctx.dpr,
      clearColor: [0, 0, 0, 1],
      label: 'rainforest',
    })

    const [initialWidth, initialHeight] = internalSize(
      canvasSurface.size[0],
      canvasSurface.size[1],
      megapixels * 1_000_000,
    )
    const accum: PingPongTargets = pingPong(gpu, initialWidth, initialHeight, {
      format: 'rgba16float',
      clearColor: [0, 0, 0, 1],
      label: 'rainforest-accum',
    })

    const accumSampler = sampler(gpu, {
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })

    const scene: Effect = effect(gpu, rainforestShader, {
      label: 'rainforest',
      set: {
        params: { resolution: [initialWidth, initialHeight], time: 0, frame: 0 },
        prev_tex: accum.read,
        prev_samp: accumSampler,
      },
    })

    const display: Effect = effect(gpu, displayShader, {
      label: 'rainforest-display',
      set: {
        src: accum.read,
        samp: accumSampler,
      },
    })

    let frameIndex = 0

    const encode = (current: Frame): void => {
      const elapsed = (performance.now() - TIME_EPOCH) / 1000
      scene.set({
        params: { time: elapsed * speed, frame: frameIndex },
        prev_tex: accum.read,
      })
      display.set({ src: accum.write })
      current.pass(accum.write, scene)
      current.pass({ target: canvasSurface, clear: [0, 0, 0, 1] }, display)
      accum.swap()
      frameIndex = frameIndex + 1
    }

    const settle = (): void => {
      for (let i = 0; i < SETTLE_FRAMES; i++) {
        frame(gpu, encode)
      }
    }

    unsubscribeResize = canvasSurface.onResize(({ width, height }) => {
      if (disposed) return
      const [w, h] = internalSize(width, height, megapixels * 1_000_000)
      resizeTargets(accum, [w, h])
      scene.set({ params: { resolution: [w, h] } })
      // frame() must not run inside the resize callback, so defer the redraw.
      if (ctx.reducedMotion) {
        cancelAnimationFrame(pendingRedraw)
        pendingRedraw = requestAnimationFrame(() => {
          if (!disposed) settle()
        })
      }
    })

    if (ctx.reducedMotion) {
      settle()
    } else {
      loop = frameLoop(gpu, encode, { fps: ctx.fps })
    }

    return { backend: 'gpu', dispose: teardown }
  } catch (error) {
    teardown()
    throw error
  }
}

function resizeTargets(accum: PingPongTargets, size: [number, number]): void {
  for (const target of [accum.read, accum.write] as Target[]) {
    target.resize(size)
  }
}
