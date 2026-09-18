import { fragmentScene, startGpuBackground, texture3dAsset } from '../../webgpu-render-engine'
import { resolveAtmosphericLandscapeParams } from '../params'
import { buildNoiseVolume, NOISE_VOLUME_SIZE } from './noise-volume'
import displayShader from './shaders/display.wgsl'
import sceneShader from './shaders/scene.wgsl'
import type { Texture } from 'vgpu'
import type { BackgroundContext, BackgroundHandle } from '../../types'

// Internal render budget. The scene is expensive (a 200-step volumetric march),
// so it renders into an offscreen target at most this many megapixels and the
// tone pass upscales to the canvas.
const MAX_MEGAPIXELS = 0.3
// Temporal accumulation weight toward the freshly traced frame.
const BLEND = 0.3
// Playback speed for the fly-over, scaled down 10× from the original so the
// drift reads as an atmospheric backdrop; the user's `speed` multiplies this.
const TIME_SCALE = 0.1
// Reduced motion: settle the accumulation, then show one static frame.
const SETTLE_FRAMES = 12

/**
 * Atmospheric Landscape (GPU only) — a volumetric terrain fly-over ported from
 * the Shadertoy demo by TekF (https://www.shadertoy.com/view/slVfD1).
 *
 * Two fragment passes per frame: the ray-march renders into a ping-pong
 * accumulation target (temporal antialiasing), then the tone pass samples it
 * onto the canvas. On a browser without WebGPU the selector renders nothing.
 */
export function startAtmosphericLandscape(
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle> {
  const { speed } = resolveAtmosphericLandscapeParams(params)
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
  )
}
