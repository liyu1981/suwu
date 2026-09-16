// Deterministic white-noise volume for the Atmospheric Landscape shader.
//
// The original Shadertoy effect samples a small RGBA noise volume through
// hardware trilinear filtering (`texture(iChannel1, pos / 32.)`). This rebuilds
// that input without shipping an asset: a 64³ RGBA8 volume of per-voxel random
// values, which the GPU filters back into smooth value noise.
//
// 64 texels × 4 bytes = 256 bytes per row, which keeps `queue.writeTexture`
// rows aligned without padding.

export const NOISE_VOLUME_SIZE = 64

/** mulberry32 — tiny deterministic PRNG, so the landscape is stable across reloads. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Builds the padded RGBA8 noise volume (only `.r` is read by the shader). */
export function buildNoiseVolume(): Uint8Array {
  const size = NOISE_VOLUME_SIZE
  const bytes = new Uint8Array(size * size * size * 4)
  const random = mulberry32(0x9e3779b9)
  for (let i = 0; i < bytes.length; i += 4) {
    bytes[i] = Math.floor(random() * 256) // red — the noise value
    bytes[i + 3] = 255 // opaque; green/blue stay zero
  }
  return bytes
}
