// Seascape (GPU only) — a raymarched ocean ported from the Shadertoy demo by
// Alexander Alekseev aka TDM (https://www.shadertoy.com/view/Ms2SD1).
//
// One fragment pass traces the sea into a capped offscreen target, a second
// blits it to the canvas. The user's animation-speed setting scales the clock.
//
// Ships embedded in the suwu binary (backgrounds/embed.go); the scene and the
// engine arrive through the create(api) ABI, identical to external backgrounds.

import seascapeShader from './shaders/seascape.shader.js';
import blitShader from './shaders/blit.shader.js';

// Cap the traced resolution. The sea is cheap for a raymarcher, but the canvas
// can be many megapixels at DPR 2; the blit pass upscales the capped target.
const MAX_MEGAPIXELS = 1.3;

// Time-scale that a UI speed of 1.0× maps to. The Shadertoy original is brisk
// for an always-on backdrop, so Suwu runs it at a quarter speed.
const SPEED_BASE = 0.25;

export default function create({ fragmentScene, startGpuBackground }) {
  function start(ctx, params) {
    const speed =
      typeof params?.speed === 'number' && Number.isFinite(params.speed) ? params.speed : 1;

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
    );
  }

  return { start };
}
