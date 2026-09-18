import { registerBackground } from '../../../registry';
import { WEBGPU_ENGINE } from '../../../constants';
import type { BackgroundContext, BackgroundHandle, BackgroundParam } from '../../../types';

/**
 * Render-resolution presets. The scene is heavy (a 20×13 star tunnel, 45
 * glowing holes, a 19-step plasma loop and a 15-octave noise field), so it
 * renders into a capped offscreen target that the blit pass upscales. Higher
 * detail means more scene pixels — sharper, but heavier.
 */
type CosmosDetail = 'low' | 'medium' | 'high' | 'ultra' | 'native';

/** Scene render budget, in megapixels (`Infinity` = the full canvas backing). */
const COSMOS_DETAIL_BUDGETS: Record<CosmosDetail, number> = {
  low: 0.5,
  medium: 1.0,
  high: 2.0,
  ultra: 4.0,
  native: Number.POSITIVE_INFINITY,
};

const COSMOS_DEFAULT_DETAIL: CosmosDetail = 'high';

/** User-facing parameters for the Cosmos in Crystal background. */
const COSMOS_PARAMS: readonly BackgroundParam[] = [
  {
    kind: 'number',
    key: 'speed',
    label: 'Animation speed',
    hint: 'Scales the tunnel drift and the colour churn. 0 freezes the scene.',
    default: 1,
    min: 0,
    max: 3,
    step: 0.05,
    format: (value) => `${value.toFixed(2)}×`,
  },
  {
    kind: 'select',
    key: 'detail',
    label: 'Detail',
    hint: 'Higher detail renders more scene pixels — sharper, but heavier.',
    default: COSMOS_DEFAULT_DETAIL,
    options: [
      { value: 'low', label: 'Low (0.5 MP)' },
      { value: 'medium', label: 'Medium (1 MP)' },
      { value: 'high', label: 'High (2 MP)' },
      { value: 'ultra', label: 'Ultra (4 MP)' },
      { value: 'native', label: 'Native (canvas)' },
    ],
  },
];

interface CosmosParams {
  /** Multiplier on the animation clock; 1 is the original speed, 0 freezes it. */
  speed: number;
  /** Offscreen render budget / sharpness. */
  detail: CosmosDetail;
}

function isDetail(value: unknown): value is CosmosDetail {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'ultra' ||
    value === 'native'
  );
}

/** Read the typed params out of the opaque subsystem params bag. */
function resolveCosmosParams(params?: Record<string, unknown>): CosmosParams {
  const speed = params?.speed;
  const detail = params?.detail;
  return {
    speed: typeof speed === 'number' && Number.isFinite(speed) ? speed : 1,
    detail: isDetail(detail) ? detail : COSMOS_DEFAULT_DETAIL,
  };
}

/**
 * Cosmos in Crystal (GPU only) — a kaleidoscopic space tunnel ported from the
 * Shadertoy by nayk (https://www.shadertoy.com/view/MXccR4).
 *
 * One fragment pass renders the whole composite into a capped offscreen target;
 * a second blits it to the canvas. The engine and the WGSL are imported lazily
 * so the metadata below can be registered eagerly.
 */
async function start(
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle> {
  const { speed, detail } = resolveCosmosParams(params);
  const megapixels = COSMOS_DETAIL_BUDGETS[detail];
  const [
    { fragmentScene, startGpuBackground },
    { default: cosmosShader },
    { default: blitShader },
  ] = await Promise.all([
    import('../../webgpu-render-engine'),
    import('./shaders/cosmos.wgsl'),
    import('./shaders/blit.wgsl'),
  ]);

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

registerBackground({
  id: 'cosmos-in-crystal',
  label: 'Cosmos in Crystal',
  engine: WEBGPU_ENGINE,
  credit: { author: 'nayk', url: 'https://www.shadertoy.com/view/MXccR4' },
  params: COSMOS_PARAMS,
  gpu: async () => ({ start }),
});
