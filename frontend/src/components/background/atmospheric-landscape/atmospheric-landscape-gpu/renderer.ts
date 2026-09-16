import { clock, effect, frame, frameLoop, init, pingPong, sampler, surface, texture } from 'vgpu'
import type { Effect, Frame, FrameLoopHandle, PingPongTargets, Surface, Target } from 'vgpu'
import { buildNoiseVolume, NOISE_VOLUME_SIZE } from './noise-volume'
import sceneShader from './shaders/scene.wgsl'
import displayShader from './shaders/display.wgsl'
import type { BackgroundContext, BackgroundHandle } from '../../types'

// Internal render budget. The scene is expensive (a 200-step volumetric march),
// so it renders into an offscreen target at most this many megapixels and the
// tone pass upscales to the canvas. Mirrors the original's MAX_MEGAPIXELS knob,
// tuned down for an always-on background.
const MAX_MEGAPIXELS = 0.3
// Temporal accumulation weight toward the freshly traced frame. Matches the
// original's `mix(previous, current, .3)`.
const BLEND = 0.3
// Playback speed for the fly-over. The original runs at 1.0; Suwu scales the
// clock down 10× so the drift reads as a near-still, atmospheric backdrop
// rather than a moving shot. Raise toward 1.0 for more motion.
const TIME_SCALE = 0.1
// Reduced motion: settle the accumulation, then show one static frame.
const SETTLE_FRAMES = 12

/** Canvas size clamped to the megapixel budget, preserving aspect ratio. */
function internalSize(width: number, height: number): [number, number] {
  const pixels = width * height
  const budget = MAX_MEGAPIXELS * 1_000_000
  if (pixels <= budget) return [Math.max(2, width), Math.max(2, height)]
  const scale = Math.sqrt(pixels / budget)
  return [Math.max(2, Math.round(width / scale)), Math.max(2, Math.round(height / scale))]
}

/**
 * Atmospheric Landscape (GPU only) — a volumetric terrain fly-over ported from
 * the Shadertoy demo by TekF (https://www.shadertoy.com/view/slVfD1).
 *
 * Two vgpu passes per frame: the ray-march renders into a ping-pong accumulation
 * target (temporal antialiasing), then the tone pass samples it onto the canvas.
 * On a browser without WebGPU the selector renders nothing.
 */
export async function startAtmosphericLandscape(ctx: BackgroundContext): Promise<BackgroundHandle> {
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
    // gpu.dispose() releases the owned surface, noise volume and ping-pong targets.
    gpu.dispose()
  }

  try {
    const volume = buildNoiseVolume()
    const noise = texture(gpu, {
      kind: '3d',
      size: [NOISE_VOLUME_SIZE, NOISE_VOLUME_SIZE, NOISE_VOLUME_SIZE],
      format: 'rgba8unorm',
      usage: ['texture_binding', 'copy_dst'],
      label: 'atmospheric-landscape-noise',
    })
    // 64 texels × 4 bytes = 256 bytes per row, so the upload rows are aligned.
    gpu.gpu.queue.writeTexture(
      { texture: noise.gpu },
      volume,
      { bytesPerRow: NOISE_VOLUME_SIZE * 4, rowsPerImage: NOISE_VOLUME_SIZE },
      { width: NOISE_VOLUME_SIZE, height: NOISE_VOLUME_SIZE, depthOrArrayLayers: NOISE_VOLUME_SIZE },
    )

    const canvasSurface: Surface = surface(gpu, ctx.canvas, {
      dpr: ctx.dpr,
      clearColor: [0, 0, 0, 1],
      label: 'atmospheric-landscape',
    })

    const [initialWidth, initialHeight] = internalSize(canvasSurface.size[0], canvasSurface.size[1])
    const accum: PingPongTargets = pingPong(gpu, initialWidth, initialHeight, {
      format: 'rgba16float',
      clearColor: [0, 0, 0, 1],
      label: 'atmospheric-landscape-accum',
    })

    const sceneSampler = sampler(gpu, {
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    const noiseSampler = sampler(gpu, {
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    })

    const scene: Effect = effect(gpu, sceneShader, {
      label: 'atmospheric-landscape-scene',
      set: {
        params: {
          resolution: [initialWidth, initialHeight],
          time: 0,
          frame: 0,
          blend: BLEND,
          _pad: 0,
        },
        prev_frame: accum.read,
        prev_sampler: sceneSampler,
        noise_volume: noise,
        noise_sampler: noiseSampler,
      },
    })

    const display: Effect = effect(gpu, displayShader, {
      label: 'atmospheric-landscape-display',
      set: {
        src: accum.read,
        samp: sceneSampler,
      },
    })

    const gpuClock = clock(gpu)
    let frameIndex = 0

    const encode = (current: Frame): void => {
      // Wrap so the f32 jitter coordinate keeps its fractional precision.
      frameIndex = (frameIndex + 1) % 1024
      scene.set({
        params: { time: gpuClock.time * TIME_SCALE, frame: frameIndex },
        prev_frame: accum.read,
      })
      // The scene pass writes `accum.write`; the tone pass reads it back in the
      // same command buffer, then we swap for the next frame's feedback.
      const latest = accum.write
      display.set({ src: latest })
      current.pass(accum.write, scene)
      current.pass({ target: canvasSurface, clear: [0, 0, 0, 1] }, display)
      accum.swap()
    }

    const settle = (): void => {
      for (let i = 0; i < SETTLE_FRAMES; i++) {
        frame(gpu, encode)
      }
    }

    unsubscribeResize = canvasSurface.onResize(({ width, height }) => {
      if (disposed) return
      const [w, h] = internalSize(width, height)
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
