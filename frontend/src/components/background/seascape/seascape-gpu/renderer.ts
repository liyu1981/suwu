import { fragmentScene, startGpuBackground } from '../../webgpu-render-engine'
import { resolveSeascapeParams, SEASCAPE_SPEED_BASE } from '../params'
import blitShader from './shaders/blit.wgsl'
import seascapeShader from './shaders/seascape.wgsl'
import type { BackgroundContext, BackgroundHandle } from '../../types'

// Cap the traced resolution. The sea is cheap for a raymarcher, but the canvas
// can be many megapixels at DPR 2; the blit pass upscales the capped target.
const MAX_MEGAPIXELS = 1.3

/**
 * Seascape (GPU only) — a raymarched ocean ported from the Shadertoy demo by
 * Alexander Alekseev aka TDM (https://www.shadertoy.com/view/Ms2SD1).
 *
 * One fragment pass traces the sea into a capped offscreen target, a second
 * blits it to the canvas. The user's animation-speed setting scales the clock.
 * On a browser without WebGPU the selector renders nothing.
 */
export function startSeascape(
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle> {
  const { speed } = resolveSeascapeParams(params)
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
            params: { resolution: size, time: time * speed * SEASCAPE_SPEED_BASE, _pad: 0 },
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
