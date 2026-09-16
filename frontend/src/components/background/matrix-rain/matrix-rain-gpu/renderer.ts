import { clock, effect, frame, frameLoop, init, sampler, storage, surface, target } from 'vgpu'
import type { Effect, Frame, FrameLoopHandle } from 'vgpu'
import { buildGlyphAtlas } from './glyph-atlas'
import crtShader from './shaders/crt.wgsl'
import matrixShader from './shaders/matrix.wgsl'
import type { BackgroundContext, BackgroundHandle } from '../../types'

// Logical cell size. Aspect must match the glyph atlas (GLYPH_WIDTH:GLYPH_HEIGHT).
const CELL_CSS_WIDTH = 24
const CELL_CSS_HEIGHT = 30

// CRT post-pass tuning. Curvature is intentionally very subtle — just enough to
// read as glass, not enough to visibly warp the desktop behind it.
const CRT = {
  curvature: 0.03,
  scanline: 0.55,
  aberration: 0.0016,
  vignette: 0.7,
  bloom: 0.5,
  flicker: 0.035,
} as const

/**
 * Matrix Rain (GPU only) — falling green glyph columns on black, then a CRT
 * post pass (curvature, bloom, scanlines, aperture grille, aberration,
 * vignette, flicker). Two vgpu passes into one frame: the rain renders into an
 * offscreen target, the CRT effect samples it onto the canvas.
 */
export async function startMatrixRain(ctx: BackgroundContext): Promise<BackgroundHandle> {
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
    // gpu.dispose() releases the owned surface, target, and glyph storage.
    gpu.dispose()
  }

  try {
    const atlas = await buildGlyphAtlas()
    const glyphs = storage(gpu, atlas.words.byteLength, 'read')
    glyphs.write(atlas.words)

    const canvasSurface = surface(gpu, ctx.canvas, { dpr: ctx.dpr, clearColor: [0, 0, 0, 1] })
    const scene = target(gpu, {
      size: [canvasSurface.size[0], canvasSurface.size[1]],
      format: 'rgba8unorm',
      clearColor: [0, 0, 0, 1],
    })

    const cell = (): [number, number] => [
      CELL_CSS_WIDTH * canvasSurface.dpr,
      CELL_CSS_HEIGHT * canvasSurface.dpr,
    ]

    const rain: Effect = effect(gpu, matrixShader, {
      label: 'matrix-rain',
      set: {
        params: {
          resolution: [scene.size[0], scene.size[1]],
          cell: cell(),
          time: 0,
          glyph_count: atlas.glyphCount,
        },
        glyphs,
      },
    })

    const crt: Effect = effect(gpu, crtShader, {
      label: 'matrix-rain-crt',
      set: {
        params: {
          output_size: [canvasSurface.size[0], canvasSurface.size[1]],
          time: 0,
          curvature: CRT.curvature,
          scanline: CRT.scanline,
          aberration: CRT.aberration,
          vignette: CRT.vignette,
          bloom: CRT.bloom,
          flicker: ctx.reducedMotion ? 0 : CRT.flicker,
        },
        src: scene,
        samp: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
      },
    })

    const gpuClock = clock(gpu)
    const encode = (current: Frame): void => {
      const time = gpuClock.time
      rain.set({ params: { time } })
      crt.set({ params: { time } })
      current.pass(scene, rain)
      current.pass({ target: canvasSurface, clear: [0, 0, 0, 1] }, crt)
    }

    unsubscribeResize = canvasSurface.onResize(() => {
      if (disposed) return
      const [width, height] = canvasSurface.size
      scene.resize([width, height])
      rain.set({ params: { resolution: [width, height], cell: cell() } })
      crt.set({ params: { output_size: [width, height] } })
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
