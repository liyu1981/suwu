import { registerBackground } from '../../../registry';
import { WEBGPU_ENGINE } from '../../../constants';
import type { BackgroundContext, BackgroundHandle, BackgroundParam } from '../../../types';
import type { Texture } from 'vgpu';

// Internal render budget. The scene is expensive (a 200-step volumetric march),
// so it renders into an offscreen target at most this many megapixels and the
// tone pass upscales to the canvas.
const MAX_MEGAPIXELS = 0.3;
// Temporal accumulation weight toward the freshly traced frame.
const BLEND = 0.3;
// Playback speed for the fly-over, scaled down 10× from the original so the
// drift reads as an atmospheric backdrop; the user's `speed` multiplies this.
const TIME_SCALE = 0.1;
// Reduced motion: settle the accumulation, then show one static frame.
const SETTLE_FRAMES = 12;

const NOISE_VOLUME_SIZE = 64;

/**
 * Deterministic white-noise volume for the scene shader. The original samples a
 * small RGBA noise volume through hardware trilinear filtering
 * (`texture(iChannel1, pos / 32.)`); this rebuilds that input without shipping
 * an asset. 64 texels × 4 bytes = 256 bytes per row, so `writeTexture` rows are
 * already aligned.
 */
function mulberry32(seed: number): () => number {
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
function buildNoiseVolume(): Uint8Array {
  const size = NOISE_VOLUME_SIZE;
  const bytes = new Uint8Array(size * size * size * 4);
  const random = mulberry32(0x9e3779b9);
  for (let i = 0; i < bytes.length; i += 4) {
    bytes[i] = Math.floor(random() * 256); // red — the noise value
    bytes[i + 3] = 255; // opaque; green/blue stay zero
  }
  return bytes;
}

/** User-facing parameters for the Atmospheric Landscape background. */
const ATMOSPHERIC_LANDSCAPE_PARAMS: readonly BackgroundParam[] = [
  {
    kind: 'number',
    key: 'speed',
    label: 'Animation speed',
    hint: 'Scales the fly-over and the fog drift. 0 freezes the scene.',
    default: 1,
    min: 0,
    max: 3,
    step: 0.05,
    format: (value) => `${value.toFixed(2)}×`,
  },
];

interface AtmosphericLandscapeParams {
  /** Multiplier on the animation clock; 1 is the tuned default, 0 freezes it. */
  speed: number;
}

/** Read the typed params out of the opaque subsystem params bag. */
function resolveAtmosphericLandscapeParams(
  params?: Record<string, unknown>,
): AtmosphericLandscapeParams {
  const speed = params?.speed;
  return { speed: typeof speed === 'number' && Number.isFinite(speed) ? speed : 1 };
}

/**
 * Atmospheric Landscape (GPU only) — a volumetric terrain fly-over ported from
 * the Shadertoy demo by TekF (https://www.shadertoy.com/view/slVfD1).
 *
 * Two fragment passes per frame: the ray-march renders into a ping-pong
 * accumulation target (temporal antialiasing), then the tone pass samples it
 * onto the canvas.
 *
 * The engine and the WGSL are imported lazily so the metadata below can be
 * registered eagerly without pulling them into the initial bundle.
 */
async function start(
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle> {
  const { speed } = resolveAtmosphericLandscapeParams(params);
  const [
    { fragmentScene, startGpuBackground, texture3dAsset },
    { default: sceneShader },
    { default: displayShader },
  ] = await Promise.all([
    import('../../webgpu-render-engine'),
    import('./shaders/scene.wgsl'),
    import('./shaders/display.wgsl'),
  ]);

  return startGpuBackground(
    'atmospheric-landscape',
    fragmentScene<{ noise: Texture }>({
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

registerBackground({
  id: 'atmospheric-landscape',
  label: 'Atmospheric Landscape',
  engine: WEBGPU_ENGINE,
  credit: { author: 'TekF', url: 'https://www.shadertoy.com/view/slVfD1' },
  params: ATMOSPHERIC_LANDSCAPE_PARAMS,
  gpu: async () => ({ start }),
});
