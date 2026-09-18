import { storage } from 'vgpu'
import { fragmentScene, startGpuBackground } from '../../webgpu-render-engine'
import { buildGlyphAtlas } from './glyph-atlas'
import crtShader from './shaders/crt.wgsl'
import matrixShader from './shaders/matrix.wgsl'
import type { StorageBuffer } from 'vgpu'
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

interface MatrixAssets {
  readonly glyphs: { readonly glyphs: StorageBuffer; readonly glyphCount: number }
}

/**
 * Matrix Rain (GPU only) — falling green glyph columns on black, then a CRT
 * post pass (curvature, bloom, scanlines, aperture grille, aberration,
 * vignette, flicker). The glyph atlas lives in a read-only storage buffer; the
 * rain renders into an offscreen target the CRT effect samples onto the canvas.
 */
export function startMatrixRain(ctx: BackgroundContext): Promise<BackgroundHandle> {
  return startGpuBackground(
    'matrix-rain',
    fragmentScene<MatrixAssets>({
      label: 'matrix-rain',
      targets: {
        scene: { format: 'rgba8unorm', clearColor: [0, 0, 0, 1] },
      },
      assets: {
        glyphs: async (gpu) => {
          const atlas = await buildGlyphAtlas()
          const glyphs = storage(gpu, atlas.words.byteLength, 'read')
          glyphs.write(atlas.words)
          return { glyphs, glyphCount: atlas.glyphCount }
        },
      },
      reducedMotionSettle: 1,
      passes: [
        {
          shader: matrixShader,
          target: 'scene',
          bindings: ({ size, dpr, time, assets }) => ({
            params: {
              resolution: size,
              cell: [CELL_CSS_WIDTH * dpr, CELL_CSS_HEIGHT * dpr],
              time,
              glyph_count: assets.glyphs.glyphCount,
            },
            glyphs: assets.glyphs.glyphs,
          }),
        },
        {
          shader: crtShader,
          target: 'canvas',
          bindings: ({ size, time, targets, sampler }) => ({
            params: {
              output_size: size,
              time,
              curvature: CRT.curvature,
              scanline: CRT.scanline,
              aberration: CRT.aberration,
              vignette: CRT.vignette,
              bloom: CRT.bloom,
              flicker: ctx.reducedMotion ? 0 : CRT.flicker,
            },
            src: targets.scene,
            samp: sampler,
          }),
        },
      ],
    }),
    ctx,
    undefined,
    { clearColor: [0, 0, 0, 1] },
  )
}
