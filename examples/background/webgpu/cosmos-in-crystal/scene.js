// Cosmos in Crystal (GPU only) — a kaleidoscopic space tunnel ported from the
// Shadertoy by nayk (https://www.shadertoy.com/view/MXccR4).
//
// One fragment pass renders the whole composite into a capped offscreen
// target; a second blits it to the canvas.

import cosmosShader from './shaders/cosmos.shader.js';
import blitShader from './shaders/blit.shader.js';

/** Render budget per detail level, in megapixels. */
const DETAIL_BUDGETS = { low: 0.5, medium: 1, high: 2, ultra: 4, native: Number.POSITIVE_INFINITY };

export default function create({ fragmentScene, startGpuBackground }) {
  function start(ctx, params) {
    const speed =
      typeof params?.speed === 'number' && Number.isFinite(params.speed) ? params.speed : 1;
    const detail = params?.detail;
    const megapixels = DETAIL_BUDGETS[detail] ?? DETAIL_BUDGETS.high;

    return startGpuBackground(
      'cosmos-in-crystal',
      fragmentScene({
        label: 'cosmos-in-crystal',
        targets: {
          scene: { format: 'rgba8unorm', clearColor: [0, 0, 0, 1], budget: megapixels },
        },
        reducedMotionSettle: 1,
        passes: [
          {
            shader: cosmosShader,
            target: 'scene',
            bindings: ({ size, time }) => ({
              params: { resolution: size, time: time * speed, _pad: 0 },
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
    );
  }

  return { start };
}
