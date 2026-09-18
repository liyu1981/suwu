/**
 * Shared time base for every WebGPU background.
 *
 * A background restart (a parameter change, a canvas remount, a fresh GPU
 * device) must not snap the animation back to t = 0. Mirroring Shadertoy's
 * `iTime` — a single monotonic playback clock that survives a shader recompile
 * — every background reads `elapsedSeconds()` against one module-level epoch.
 *
 * `EPOCH` is captured at page load, so `elapsed` stays small (hours ≈ 10⁴ s)
 * and keeps fractional precision in an f32 uniform.
 */
const EPOCH = typeof performance !== 'undefined' ? performance.now() : 0;

/** Seconds since this module loaded. Continuous across backend restarts. */
export function elapsedSeconds(): number {
  return (performance.now() - EPOCH) / 1000;
}
