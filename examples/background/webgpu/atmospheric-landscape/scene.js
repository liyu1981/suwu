// Atmospheric Landscape (GPU only) — a volumetric terrain fly-over ported from
// the Shadertoy demo by TekF (https://www.shadertoy.com/view/slVfD1).
//
// Two fragment passes per frame: the ray-march renders into a ping-pong
// accumulation target (temporal antialiasing), then the tone pass samples it
// onto the canvas. The noise volume the scene samples is rebuilt at startup
// from a seeded PRNG instead of shipping an asset.

import sceneShader from './shaders/scene.shader.js';
import displayShader from './shaders/display.shader.js';

const MAX_MEGAPIXELS = 0.3;
const BLEND = 0.3;
const TIME_SCALE = 0.1;
const SETTLE_FRAMES = 12;
const NOISE_VOLUME_SIZE = 64;

/** Deterministic white-noise PRNG (mulberry32). */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds the padded RGBA8 noise volume (only `.r` is read by the shader). */
function buildNoiseVolume() {
  const size = NOISE_VOLUME_SIZE;
  const bytes = new Uint8Array(size * size * size * 4);
  const random = mulberry32(0x9e3779b9);
  for (let i = 0; i < bytes.length; i += 4) {
    bytes[i] = Math.floor(random() * 256); // red — the noise value
    bytes[i + 3] = 255; // opaque; green/blue stay zero
  }
  return bytes;
}

export default function create({ fragmentScene, startGpuBackground, texture3dAsset }) {
  function start(ctx, params) {
    const speed =
      typeof params?.speed === 'number' && Number.isFinite(params.speed) ? params.speed : 1;

    return startGpuBackground(
      'atmospheric-landscape',
      fragmentScene({
        label: 'atmospheric-landscape',
        targets: {
          accum: {
            kind: 'pingPong',
            format: 'rgba16float',
            clearColor: [0, 0, 0, 1],
            budget: MAX_MEGAPIXELS,
          },
        },
        assets: {
          noise: texture3dAsset({
            size: NOISE_VOLUME_SIZE,
            format: 'rgba8unorm',
            build: buildNoiseVolume,
            label: 'atmospheric-landscape-noise',
          }),
        },
        samplers: {
          noise: {
            minFilter: 'linear',
            magFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat',
            addressModeW: 'repeat',
          },
        },
        reducedMotionSettle: SETTLE_FRAMES,
        passes: [
          {
            shader: sceneShader,
            target: 'accum',
            bindings: ({ size, time, frame, pingPong, assets, sampler, samplers }) => ({
              params: {
                resolution: size,
                time: time * TIME_SCALE * speed,
                // Wrap so the f32 jitter coordinate keeps fractional precision.
                frame: frame % 1024,
                blend: BLEND,
                _pad: 0,
              },
              prev_frame: pingPong.accum.read,
              prev_sampler: sampler,
              noise_volume: assets.noise,
              noise_sampler: samplers.noise,
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
