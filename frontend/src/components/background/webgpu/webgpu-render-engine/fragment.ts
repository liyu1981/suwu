import { effect, frame, pingPong, sampler, target } from 'vgpu';
import type { ClearColor, Effect, Frame, PingPongTargets, ShaderSource, Target } from 'vgpu';
import { cappedSize } from './size';
import { elapsedSeconds } from './time';
import type { GpuScene, GpuSceneFactory } from './scene';
import type { GpuAssetBuilder } from './assets';

/** An offscreen render target, single-buffered. */
export interface SingleTargetSpec {
  readonly kind?: 'single';
  readonly format?: GPUTextureFormat;
  readonly clearColor?: ClearColor;
  /**
   * Render-resolution budget in megapixels, or a function of the resolved
   * params. `Infinity` (default) renders at the full canvas backing size.
   */
  readonly budget?: number | ((params: Record<string, unknown>) => number);
}

/** An offscreen render target with read/write halves, swapped every frame. */
export interface PingPongTargetSpec {
  readonly kind: 'pingPong';
  readonly format?: GPUTextureFormat;
  readonly clearColor?: ClearColor;
  readonly budget?: number | ((params: Record<string, unknown>) => number);
}

export type TargetSpec = SingleTargetSpec | PingPongTargetSpec;

/** What a pass can read when building its bindings. */
export interface FragmentFrameState<A extends object> {
  /** Size of the target this pass writes, in device pixels. */
  readonly size: readonly [number, number];
  /** Current surface device-pixel-ratio (matches `size`). */
  readonly dpr: number;
  /** Shared epoch seconds (see `time.ts`). */
  readonly time: number;
  /** Frames rendered since the scene started, counting from 1. */
  readonly frame: number;
  readonly params: Record<string, unknown>;
  readonly assets: A;
  /** The default linear/clamp sampler. */
  readonly sampler: GPUSampler;
  /** Extra samplers declared in `samplers`, by key. */
  readonly samplers: Record<string, GPUSampler>;
  /** Single offscreen targets, by key. */
  readonly targets: Record<string, Target>;
  /** Ping-pong target pairs, by key. `read`/`write` swap after every frame. */
  readonly pingPong: Record<string, PingPongTargets>;
}

export interface FragmentPassSpec<A extends object> {
  readonly shader: ShaderSource;
  /** `'canvas'`, a single target key, or a ping-pong target key (writes its `write` half). */
  readonly target: 'canvas' | string;
  /** Per-frame uniforms and bindings. Static values are re-set each frame (cheap). */
  readonly bindings?: (state: FragmentFrameState<A>) => Record<string, unknown>;
}

export interface FragmentSceneSpec<A extends object> {
  readonly label: string;
  readonly targets?: Record<string, TargetSpec>;
  /** Host-built GPU resources, by key, available as `state.assets`. */
  readonly assets?: { [K in keyof A]: GpuAssetBuilder<A[K]> };
  /** Extra samplers, by key, available as `state.samplers`. */
  readonly samplers?: Record<string, GPUSamplerDescriptor>;
  /** Reduced motion: frames to run before the still is presented. Default 1. */
  readonly reducedMotionSettle?: number;
  readonly passes: readonly FragmentPassSpec<A>[];
}

function resolveBudget(
  budget: number | ((params: Record<string, unknown>) => number) | undefined,
  params: Record<string, unknown>,
): number {
  if (typeof budget === 'function') return budget(params);
  return budget ?? Number.POSITIVE_INFINITY;
}

/**
 * A declarative WebGPU pass pipeline.
 *
 * Covers the backgrounds that share one shape: render the effect into an
 * offscreen target (single or ping-pong), then run a full-screen post pass to
 * the canvas. The descriptor states the targets, assets, samplers and pass
 * order; the shaders and their uniform structs are untouched, and each pass's
 * `bindings` maps host values onto whatever layout the shader declares.
 */
export function fragmentScene<A extends object = Record<string, never>>(
  spec: FragmentSceneSpec<A>,
): GpuSceneFactory {
  return async (init) => {
    const { gpu, surface, params } = init;

    const samplerCache: Record<string, GPUSampler> = {
      sampler: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
    };
    for (const [key, descriptor] of Object.entries(spec.samplers ?? {})) {
      samplerCache[key] = sampler(gpu, descriptor);
    }
    const defaultSampler = samplerCache.sampler;

    const assets = {} as A;
    if (spec.assets) {
      const builders = spec.assets as Record<string, GpuAssetBuilder<unknown>>;
      for (const [key, build] of Object.entries(builders)) {
        (assets as Record<string, unknown>)[key] = await build(gpu);
      }
    }

    const singles: Record<string, { target: Target; budget: number }> = {};
    const pairs: Record<string, { pp: PingPongTargets; budget: number }> = {};
    for (const [key, targetSpec] of Object.entries(spec.targets ?? {})) {
      const budget = resolveBudget(targetSpec.budget, params);
      const size = cappedSize(surface.size[0], surface.size[1], budget);
      if (targetSpec.kind === 'pingPong') {
        pairs[key] = {
          pp: pingPong(gpu, size[0], size[1], {
            format: targetSpec.format,
            clearColor: targetSpec.clearColor,
            label: `${spec.label}-${key}`,
          }),
          budget,
        };
      } else {
        singles[key] = {
          target: target(gpu, {
            size,
            format: targetSpec.format,
            clearColor: targetSpec.clearColor,
            label: `${spec.label}-${key}`,
          }),
          budget,
        };
      }
    }

    const targets: Record<string, Target> = {};
    for (const [key, entry] of Object.entries(singles)) targets[key] = entry.target;
    const pingPongTargets: Record<string, PingPongTargets> = {};
    for (const [key, entry] of Object.entries(pairs)) pingPongTargets[key] = entry.pp;

    const passes: { spec: FragmentPassSpec<A>; effect: Effect }[] = spec.passes.map(
      (pass, index) => ({
        spec: pass,
        effect: effect(gpu, pass.shader, { label: `${spec.label}-${index}` }),
      }),
    );

    const writeTarget = (id: string): Target => {
      if (id === 'canvas') return surface;
      const pair = pairs[id];
      if (pair) return pair.pp.write;
      const single = singles[id];
      if (single) return single.target;
      throw new Error(`[${spec.label}] pass writes unknown target "${id}"`);
    };

    let frameIndex = 0;

    const render = (current: Frame, time: number): void => {
      frameIndex += 1;
      for (const { spec: pass, effect: fx } of passes) {
        const destination = writeTarget(pass.target);
        if (pass.bindings) {
          fx.set(
            pass.bindings({
              size: destination.size,
              dpr: surface.dpr,
              time,
              frame: frameIndex,
              params,
              assets,
              sampler: defaultSampler,
              samplers: samplerCache,
              targets,
              pingPong: pingPongTargets,
            }),
          );
        }
        current.pass(destination, fx);
      }
      for (const entry of Object.values(pairs)) entry.pp.swap();
    };

    const scene: GpuScene = {
      resize(size) {
        for (const entry of Object.values(singles)) {
          entry.target.resize(cappedSize(size[0], size[1], entry.budget));
        }
        for (const entry of Object.values(pairs)) {
          const next = cappedSize(size[0], size[1], entry.budget);
          entry.pp.read.resize(next);
          entry.pp.write.resize(next);
        }
      },
      render,
      settle() {
        const count = spec.reducedMotionSettle ?? 1;
        for (let i = 0; i < count; i++) {
          frame(gpu, (current) => render(current, elapsedSeconds()));
        }
      },
      destroy() {
        // Targets, storage and textures are owned by the device and released
        // by `gpu.dispose()` in the host teardown.
      },
    };
    return scene;
  };
}
