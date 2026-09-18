/**
 * Render-resolution budgeting shared by the WebGPU backgrounds.
 *
 * The expensive raymarchers render into an offscreen target capped to a
 * megapixel budget and upscale to the canvas, so a high-DPR display never
 * multiplies the per-pixel cost of the march. A background declares its budget
 * (a constant, or a function of its parameters — see Rainforest's `detail`).
 */

/**
 * Canvas size clamped to `megapixels`, preserving aspect ratio. `Infinity`
 * (the default for a background with no budget) returns the full backing size.
 */
export function cappedSize(width: number, height: number, megapixels: number): [number, number] {
  const pixels = width * height;
  const budget = megapixels * 1_000_000;
  if (!(pixels > budget) || !Number.isFinite(budget)) {
    return [Math.max(2, width), Math.max(2, height)];
  }
  const scale = Math.sqrt(pixels / budget);
  return [Math.max(2, Math.round(width / scale)), Math.max(2, Math.round(height / scale))];
}
