import { fragmentScene, startGpuBackground } from '../../webgpu-render-engine'
import { resolveRainforestParams, RAINFOREST_DETAIL_BUDGETS } from '../params'
import displayShader from './shaders/display.wgsl'
import rainforestShader from './shaders/rainforest.wgsl'
import type { BackgroundContext, BackgroundHandle } from '../../types'

// Reduced motion: settle the reprojection, then show one static frame.
const SETTLE_FRAMES = 16

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
export function startRainforest(
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle> {
  const { speed, detail } = resolveRainforestParams(params)
  const megapixels = RAINFOREST_DETAIL_BUDGETS[detail]
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
