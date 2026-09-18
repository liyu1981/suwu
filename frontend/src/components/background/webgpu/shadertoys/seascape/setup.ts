import { registerBackground } from '../../../registry'
import { WEBGPU_ENGINE } from '../../../constants'
import type { BackgroundContext, BackgroundHandle, BackgroundParam } from '../../../types'

// Cap the traced resolution. The sea is cheap for a raymarcher, but the canvas
// can be many megapixels at DPR 2; the blit pass upscales the capped target.
const MAX_MEGAPIXELS = 1.3

// Time-scale that a UI speed of 1.0× maps to. The Shadertoy original is brisk
// for an always-on backdrop, so Suwu runs it at a quarter speed.
const SPEED_BASE = 0.25

/** User-facing parameters for the Seascape background. */
const SEASCAPE_PARAMS: readonly BackgroundParam[] = [
  {
    kind: 'number',
    key: 'speed',
    label: 'Animation speed',
    hint: 'Scales the drift of the camera and the waves. 0 freezes the scene.',
    default: 1,
    min: 0,
    max: 3,
    step: 0.05,
    format: (value) => `${value.toFixed(2)}×`,
  },
]

interface SeascapeParams {
  /** UI multiplier on the base animation clock; 1 is the default, 0 freezes it. */
  speed: number
}

/** Read the typed Seascape params out of the opaque subsystem params bag. */
function resolveSeascapeParams(params?: Record<string, unknown>): SeascapeParams {
  const speed = params?.speed
  return { speed: typeof speed === 'number' && Number.isFinite(speed) ? speed : 1 }
}

/**
 * Seascape (GPU only) — a raymarched ocean ported from the Shadertoy demo by
 * Alexander Alekseev aka TDM (https://www.shadertoy.com/view/Ms2SD1).
 *
 * One fragment pass traces the sea into a capped offscreen target, a second
 * blits it to the canvas. The user's animation-speed setting scales the clock.
 *
 * The engine and the WGSL are imported lazily so the metadata below can be
 * registered eagerly without pulling them into the initial bundle.
 */
async function start(
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle> {
  const { speed } = resolveSeascapeParams(params)
  const [
    { fragmentScene, startGpuBackground },
    { default: seascapeShader },
    { default: blitShader },
  ] = await Promise.all([
    import('../../webgpu-render-engine'),
    import('./shaders/seascape.wgsl'),
    import('./shaders/blit.wgsl'),
  ])

  return startGpuBackground(
    'seascape',
    fragmentScene({
      label: 'seascape',
      targets: {
        scene: { format: 'rgba16float', clearColor: [0, 0, 0, 1], budget: MAX_MEGAPIXELS },
      },
      reducedMotionSettle: 1,
      passes: [
        {
          shader: seascapeShader,
          target: 'scene',
          bindings: ({ size, time }) => ({
            params: { resolution: size, time: time * speed * SPEED_BASE, _pad: 0 },
          }),
        },
        {
          shader: blitShader,
          target: 'canvas',
          bindings: ({ targets, sampler }) => ({ src: targets.scene, samp: sampler }),
        },
      ],
    }),
    ctx,
    params,
    { clearColor: [0, 0, 0, 1] },
  )
}

registerBackground({
  id: 'seascape',
  label: 'Seascape',
  engine: WEBGPU_ENGINE,
  credit: {
    author: 'Alexander Alekseev aka TDM',
    url: 'https://www.shadertoy.com/view/Ms2SD1',
    license: 'CC BY-NC-SA 3.0',
  },
  params: SEASCAPE_PARAMS,
  gpu: async () => ({ start }),
})
