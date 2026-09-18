import { registerBackground } from '../../../registry'
import { WEBGPU_ENGINE } from '../../../constants'
import type { BackgroundContext, BackgroundHandle, BackgroundParam } from '../../../types'

// Reduced motion: settle the reprojection, then show one static frame.
const SETTLE_FRAMES = 16

/**
 * Render-resolution presets. The scene is expensive (a 400-step terrain march
 * into 9-octave fbm plus tree and cloud marches), so it renders into a smaller
 * offscreen target and is upscaled; higher detail means more scene pixels.
 */
type RainforestDetail = 'low' | 'medium' | 'high' | 'ultra' | 'native'

/** Scene render budget, in megapixels (`Infinity` = the full canvas backing). */
const RAINFOREST_DETAIL_BUDGETS: Record<RainforestDetail, number> = {
  low: 0.4,
  medium: 1.0,
  high: 2.5,
  ultra: 5.0,
  native: Number.POSITIVE_INFINITY,
}

/** User-facing parameters for the Rainforest background. */
const RAINFOREST_PARAMS: readonly BackgroundParam[] = [
  {
    kind: 'number',
    key: 'speed',
    label: 'Animation speed',
    hint: 'Scales the slow camera drift. 0 freezes the scene.',
    default: 1,
    min: 0,
    max: 3,
    step: 0.05,
    format: (value) => `${value.toFixed(2)}×`,
  },
  {
    kind: 'select',
    key: 'detail',
    label: 'Detail',
    hint: 'Higher detail renders more scene pixels — sharper, but heavier.',
    default: 'high',
    options: [
      { value: 'low', label: 'Low (0.4 MP)' },
      { value: 'medium', label: 'Medium (1 MP)' },
      { value: 'high', label: 'High (2.5 MP)' },
      { value: 'ultra', label: 'Ultra (5 MP)' },
      { value: 'native', label: 'Native (canvas)' },
    ],
  },
]

interface RainforestParams {
  /** Multiplier on the animation clock; 1 is the original speed, 0 freezes it. */
  speed: number
  /** Offscreen render budget / sharpness. */
  detail: RainforestDetail
}

function isDetail(value: unknown): value is RainforestDetail {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'ultra' ||
    value === 'native'
  )
}

/** Read the typed Rainforest params out of the opaque subsystem params bag. */
function resolveRainforestParams(params?: Record<string, unknown>): RainforestParams {
  const speed = params?.speed
  const detail = params?.detail
  return {
    speed: typeof speed === 'number' && Number.isFinite(speed) ? speed : 1,
    detail: isDetail(detail) ? detail : 'high',
  }
}

/**
 * Rainforest (GPU only) — a raymarched forest landscape ported from the
 * Shadertoy demo by Inigo Quilez (https://www.shadertoy.com/view/4ttSWf), used
 * with the author's permission.
 *
 * The original's Buffer A + Image passes become a ping-pong accumulation target
 * (the demo's temporal reprojection reads the previous frame and the camera
 * matrix it stores in the first three texels) plus a vignette blit to the
 * canvas. The original carries a restrictive license that forbids use in any
 * product; it is included here with express permission from the author. Keep
 * that permission on file and cite the author if this is redistributed.
 *
 * The engine and the WGSL are imported lazily so the metadata below can be
 * registered eagerly without pulling them into the initial bundle.
 */
async function start(
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle> {
  const { speed, detail } = resolveRainforestParams(params)
  const megapixels = RAINFOREST_DETAIL_BUDGETS[detail]
  const [
    { fragmentScene, startGpuBackground },
    { default: rainforestShader },
    { default: displayShader },
  ] = await Promise.all([
    import('../../webgpu-render-engine'),
    import('./shaders/rainforest.wgsl'),
    import('./shaders/display.wgsl'),
  ])

  return startGpuBackground(
    'rainforest',
    fragmentScene({
      label: 'rainforest',
      targets: {
        accum: {
          kind: 'pingPong',
          format: 'rgba16float',
          clearColor: [0, 0, 0, 1],
          budget: megapixels,
        },
      },
      reducedMotionSettle: SETTLE_FRAMES,
      passes: [
        {
          shader: rainforestShader,
          target: 'accum',
          bindings: ({ size, time, frame, pingPong, sampler }) => ({
            params: { resolution: size, time: time * speed, frame },
            prev_tex: pingPong.accum.read,
            prev_samp: sampler,
          }),
        },
        {
          shader: displayShader,
          target: 'canvas',
          bindings: ({ pingPong, sampler }) => ({ src: pingPong.accum.write, samp: sampler }),
        },
      ],
    }),
    ctx,
    params,
    { clearColor: [0, 0, 0, 1] },
  )
}

registerBackground({
  id: 'rainforest',
  label: 'Rainforest',
  engine: WEBGPU_ENGINE,
  credit: {
    author: 'Inigo Quilez (iq)',
    url: 'https://www.shadertoy.com/view/4ttSWf',
    license: 'used with permission',
  },
  params: RAINFOREST_PARAMS,
  gpu: async () => ({ start }),
})
