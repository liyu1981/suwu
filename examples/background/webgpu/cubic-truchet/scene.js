// Cubic Truchet (GPU only) — a raymarched lattice of decorated toroidal
// Truchet tiles, ported from the Shadertoy demo by Shane
// (https://www.shadertoy.com/view/4lfcRl).
//
// The original is a single-pass shader with no back-buffer to maintain, so
// this is a plain declarative fragmentScene(): the march renders into a
// budget-capped offscreen target and a blit upscales it onto the canvas. The
// user's animation-speed setting scales the clock the camera flight, the view
// sway, the color drift and the blinking lights all run on.

import truchetShader from './shaders/truchet.shader.js';
import blitShader from './shaders/blit.shader.js';

// Time-scale that a UI speed of 1.0× maps to. The original's camera crosses
// one tile per second — a little brisk for an always-on backdrop, so Suwu
// runs it at half speed.
const SPEED_BASE = 0.5;

/** Scene render budget per detail level, in megapixels. */
const DETAIL_BUDGETS = {
  low: 0.4,
  medium: 1.0,
  high: 2.0,
  ultra: 4.0,
  native: Number.POSITIVE_INFINITY,
};

function megapixels(params) {
  return DETAIL_BUDGETS[params?.detail] ?? DETAIL_BUDGETS.high;
}

export default function create({ fragmentScene, startGpuBackground }) {
  function start(ctx, params) {
    const speed =
      typeof params?.speed === 'number' && Number.isFinite(params.speed) ? params.speed : 1;

    return startGpuBackground(
      'cubic-truchet',
      fragmentScene({
        label: 'cubic-truchet',
        targets: {
          scene: {
            format: 'rgba16float',
            clearColor: [0, 0, 0, 1],
            budget: megapixels,
          },
        },
        reducedMotionSettle: 1,
        passes: [
          {
            shader: truchetShader,
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
    );
  }

  return { start };
}
