// Monomino Domino (GPU only) — a random 1×1/2×1 tiling extruded into a
// raymarched relief, ported from the Shadertoy demo by Shane
// (https://www.shadertoy.com/view/l3sBzM).
//
// The original evolves its tiling in a back-buffer: every frame each empty
// cell rolls a random direction and links into a domino when two empty
// neighbours point at one another. Here the same 32×32 pass ping-pongs
// against the previous frame's state every frame, the raymarch reads the
// settled cells, and a blit upscales the capped render onto the canvas. The
// tiling settles on its own, so the pattern assembles once, in view, then the
// geometry holds still while the camera and heights keep moving.
//
// Unlike the declarative fragmentScene() backgrounds, the buffer has to be
// stepped and swapped under the march, and reduced motion has to show a
// *finished* pattern from a single still, so the passes are encoded by hand.

import tilingShader from './shaders/tiling.shader.js';
import sceneShader from './shaders/scene.shader.js';
import blitShader from './shaders/blit.shader.js';

// The back-buffer grid: one fragment per cell, constant for the scene's life.
const GRID = 32;

// Time-scale that a UI speed of 1.0× maps to. The original's camera is a
// little brisk for an always-on backdrop, so Suwu runs it at half speed.
const SPEED_BASE = 0.5;

// Forced back-buffer steps under reduced motion: without the original's
// time-gated flicker the pairing settles within a couple of hundred updates,
// so a single still shows the finished tiling instead of an empty grid.
const SETTLE_STEPS = 240;

/** Scene render budget per detail level, in megapixels. */
const DETAIL_BUDGETS = {
  low: 0.4,
  medium: 1.0,
  high: 2.0,
  ultra: 4.0,
  native: Number.POSITIVE_INFINITY,
};

export default function create({ startGpuBackground, cappedSize, elapsedSeconds, vgpu }) {
  const { effect, frame, pingPong, sampler, target } = vgpu;

  function start(ctx, params) {
    const speed =
      typeof params?.speed === 'number' && Number.isFinite(params.speed) ? params.speed : 1;
    const megapixels = DETAIL_BUDGETS[params?.detail] ?? DETAIL_BUDGETS.high;

    return startGpuBackground(
      'monomino-domino',
      (init) => {
        const { gpu, surface } = init;

        const cells = pingPong(gpu, GRID, GRID, {
          format: 'rgba32float',
          clearColor: [0, 0, 0, 1],
          label: 'monomino-domino-cells',
        });
        const scene = target(gpu, {
          size: cappedSize(surface.size[0], surface.size[1], megapixels),
          format: 'rgba16float',
          clearColor: [0, 0, 0, 1],
          label: 'monomino-domino-scene',
        });

        const tilingFx = effect(gpu, tilingShader, { label: 'monomino-domino-tiling' });
        const sceneFx = effect(gpu, sceneShader, { label: 'monomino-domino-scene' });
        const blitFx = effect(gpu, blitShader, { label: 'monomino-domino-blit' });
        const samp = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' });

        // Steps since the scene started; step 0 initializes the grid (the
        // original's iFrame==0). A settings change restarts the scene, so it
        // also draws a fresh random pattern — the back-buffer cannot outlive
        // the GPU resources it lives in.
        let steps = -1;

        // One back-buffer step: roll the cells from `read` into `write`, then
        // swap so the march reads the fresh state. `gate` is the original's
        // deliberate time delay (1 = hold, 0 = update); the host computes it
        // because the shader clock is the scaled one.
        const step = (current, gate) => {
          steps += 1;
          tilingFx.set({
            info: { frame: steps, gate, _pad: [0, 0] },
            buf_in: cells.read,
          });
          current.pass(cells.write, tilingFx);
          cells.swap();
        };

        // The original's delay flicker: update 1 time in 8 of its 160 Hz
        // clock, so the assembly is watchable — and paced by the speed
        // setting with it. At t = 0 (speed 0) the gate is always open, so the
        // pattern completes while the rest of the scene stands still.
        const gateFor = (t) => (Math.floor(t * 160) % 8 === 0 ? 0 : 1);

        const render = (current, time) => {
          const t = time * speed * SPEED_BASE;
          step(current, gateFor(t));
          sceneFx.set({
            params: { resolution: scene.size, time: t, _pad: 0 },
            buf_in: cells.read,
          });
          current.pass(scene, sceneFx);
          blitFx.set({ src: scene, samp });
          current.pass(surface, blitFx);
        };

        return {
          async prepare() {
            // Compile every pipeline before the first frame. The canvas pass
            // compiles against its format signature: a Surface cannot be
            // compiled outside a frame.
            await Promise.all([
              tilingFx.compile({ colors: ['rgba32float'] }),
              sceneFx.compile(scene),
              blitFx.compile({ colors: [surface.format] }),
            ]);
          },
          resize(size) {
            scene.resize(cappedSize(size[0], size[1], megapixels));
          },
          render,
          settle() {
            // One still: run the tiling to completion without the time gate,
            // then paint it. One frame per step — an effect's uniforms are
            // shared by every pass of a frame, so batching the steps would
            // hash the last step's frame counter every time.
            for (let i = 0; i < SETTLE_STEPS; i++) {
              frame(gpu, (current) => step(current, 0));
            }
            frame(gpu, (current) => render(current, elapsedSeconds()));
          },
          // Targets, ping-pong halves and effects belong to the device;
          // gpu.dispose() releases them with it.
          destroy() {},
        };
      },
      ctx,
      params,
      { clearColor: [0, 0, 0, 1] },
    );
  }

  return { start };
}
