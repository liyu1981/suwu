/**
 * WebGPU render engine — the shared host and declarative pass pipeline behind
 * every GPU-only background.
 *
 * - `startGpuBackground` owns the device/surface lifecycle, the frame loop, the
 *   shared `ctx.fps`, reduced motion and teardown.
 * - `fragmentScene` builds the common "effect → offscreen target → post pass"
 *   pipeline from a descriptor, so a background is little more than its WGSL.
 * - `elapsedSeconds` / `cappedSize` are the shared time base and resolution
 *   budget.
 *
 * `ambient-blob` (CPU fallback, baseline image) and `video` (CPU only) are not
 * part of the engine.
 */
export { startGpuBackground } from './scene';
export type { GpuScene, GpuSceneFactory, GpuSceneInit } from './scene';
export { fragmentScene } from './fragment';
export type {
  FragmentFrameState,
  FragmentPassSpec,
  FragmentSceneSpec,
  PingPongTargetSpec,
  SingleTargetSpec,
  TargetSpec,
} from './fragment';
export { storageAsset, texture3dAsset } from './assets';
export type { GpuAssetBuilder } from './assets';
export { openGpuHost } from './host';
export type { GpuHost, GpuHostOptions } from './host';
export { elapsedSeconds } from './time';
export { cappedSize } from './size';
