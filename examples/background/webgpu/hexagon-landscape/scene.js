// Hexagon Landscape (GPU only) — a raymarched landscape of extruded offset
// hexagons, ported from the Shadertoy demo by Shane
// (https://www.shadertoy.com/view/tdtyDs).
//
// The original bakes its expensive distance field and height map into a
// cube-map buffer once, then raymarches against them. This scene keeps that
// shape as a hand-written GpuScene: two one-off 1024² passes fill the tiles on
// the first frame, the march renders into a capped offscreen target, and a
// blit upscales it onto the canvas. The user's animation-speed setting scales
// the clock the camera and the water run on.
//
// Unlike the declarative fragmentScene() backgrounds, the precalculation has
// to happen exactly once, so the passes are encoded by hand.

import fieldShader from './shaders/field.shader.js';
import heightShader from './shaders/height.shader.js';
import sceneShader from './shaders/scene.shader.js';
import blitShader from './shaders/blit.shader.js';

// The baked tiles: one tile of world space, at the original's 1024² buffer
// resolution. They are screen-independent, so a resize never rebuilds them.
const FIELD_TILES = [1024, 1024];

// Time-scale that a UI speed of 1.0× maps to. The original's camera is brisk
// for an always-on backdrop, so Suwu runs it at half speed.
const SPEED_BASE = 0.5;

/** Scene render budget per detail level, in megapixels. */
const DETAIL_BUDGETS = {
  low: 0.4,
  medium: 1.0,
  high: 2.0,
  ultra: 4.0,
  native: Number.POSITIVE_INFINITY,
};

export default function create({ startGpuBackground, cappedSize, elapsedSeconds, vgpu }) {
  const { effect, frame, sampler, target } = vgpu;

  function start(ctx, params) {
    const speed =
      typeof params?.speed === 'number' && Number.isFinite(params.speed) ? params.speed : 1;
    const megapixels = DETAIL_BUDGETS[params?.detail] ?? DETAIL_BUDGETS.high;

    return startGpuBackground(
      'hexagon-landscape',
      (init) => {
        const { gpu, surface } = init;

        const field = target(gpu, {
          size: FIELD_TILES,
          format: 'rgba16float',
          clearColor: [0, 0, 0, 1],
          label: 'hexagon-landscape-field',
        });
        const heights = target(gpu, {
          size: FIELD_TILES,
          format: 'r16float',
          clearColor: [0, 0, 0, 1],
          label: 'hexagon-landscape-height',
        });
        const scene = target(gpu, {
          size: cappedSize(surface.size[0], surface.size[1], megapixels),
          format: 'rgba16float',
          clearColor: [0, 0, 0, 1],
          label: 'hexagon-landscape-scene',
        });

        const fieldFx = effect(gpu, fieldShader, { label: 'hexagon-landscape-field' });
        const heightFx = effect(gpu, heightShader, { label: 'hexagon-landscape-height' });
        const sceneFx = effect(gpu, sceneShader, { label: 'hexagon-landscape-scene' });
        const blitFx = effect(gpu, blitShader, { label: 'hexagon-landscape-blit' });
        const samp = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' });

        // Both baking passes run in the frame that first renders the scene —
        // ahead of the march, on the same queue, so the tiles are filled before
        // anything reads them — and never again.
        let baked = false;

        const render = (current, time) => {
          if (!baked) {
            current.pass(field, fieldFx);
            current.pass(heights, heightFx);
            baked = true;
          }
          sceneFx.set({
            params: { resolution: scene.size, time: time * speed * SPEED_BASE, _pad: 0 },
            field_tex: field,
            height_tex: heights,
          });
          current.pass(scene, sceneFx);
          blitFx.set({ src: scene, samp });
          current.pass(surface, blitFx);
        };

        return {
          async prepare() {
            // Compile every pipeline before the first frame, so the bake does
            // not hitch. The canvas pass compiles against its format signature:
            // a Surface cannot be compiled outside a frame.
            await Promise.all([
              fieldFx.compile(field),
              heightFx.compile(heights),
              sceneFx.compile(scene),
              blitFx.compile({ colors: [surface.format] }),
            ]);
          },
          resize(size) {
            scene.resize(cappedSize(size[0], size[1], megapixels));
          },
          render,
          settle() {
            frame(gpu, (current) => render(current, elapsedSeconds()));
          },
          // Targets and effects belong to the device; gpu.dispose() releases
          // them with it.
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
