// Rainforest (GPU only) — a raymarched forest landscape ported from the
// Shadertoy demo by Inigo Quilez (https://www.shadertoy.com/view/4ttSWf), used
// with the author's permission.
//
// The original's Buffer A + Image passes become a ping-pong accumulation
// target (temporal reprojection reads the previous frame and the camera matrix
// it stores in the first three texels) plus a vignette blit to the canvas.

import rainforestShader from './shaders/rainforest.shader.js';
import displayShader from './shaders/display.shader.js';

// Reduced motion: settle the reprojection, then show one static frame.
const SETTLE_FRAMES = 16;

/** Scene render budget per detail level, in megapixels. */
const DETAIL_BUDGETS = {
  low: 0.4,
  medium: 1.0,
  high: 2.5,
  ultra: 5.0,
  native: Number.POSITIVE_INFINITY,
};

export default function create({ fragmentScene, startGpuBackground }) {
  function start(ctx, params) {
    const speed =
      typeof params?.speed === 'number' && Number.isFinite(params.speed) ? params.speed : 1;
    const detail = params?.detail;
    const megapixels = DETAIL_BUDGETS[detail] ?? DETAIL_BUDGETS.high;

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
    );
  }

  return { start };
}
