// Headless pixel test for the ambient blob WGSL shader.
//
// The test machine may have no hardware WebGPU, so this is how the GPU
// backend's shader is validated: resolve the .wgsl import graph, render
// offscreen with vgpu/node (Mesa llvmpipe), read the pixels back, and compare
// every sampled pixel against an independent JS implementation of the same
// additive radial-gradient math the CPU backend relies on.
//
//   pnpm --dir frontend bg:render
//
// Also writes ambient-preview.png next to this script for visual inspection.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { resolveShader } from '@vgpu/wgsl/runtime'
import { effect, init, target } from 'vgpu/node'

const WIDTH = 160
const HEIGHT = 90
const CORE_STOP = 0.6
const TOLERANCE = 2

const SHADER_ENTRY = fileURLToPath(
  new URL(
    '../src/components/background/ambient-blob/ambient-blob-gpu/shaders/ambient.wgsl',
    import.meta.url,
  ),
)
const PREVIEW = fileURLToPath(new URL('./ambient-preview.png', import.meta.url))

function emptyBlobs() {
  return Array.from({ length: 12 }, () => ({ center: [0, 0], radius: 0, color: [0, 0, 0, 0] }))
}

/** Shader falloff, mirrored from common.wgsl. */
function falloff(distance, radius) {
  const coreRadius = radius * CORE_STOP
  const tail = Math.max(radius - coreRadius, 0.0001)
  return Math.min(Math.max((radius - distance) / tail, 0), 1)
}

/**
 * Independent reference for a pixel. WebGPU interpolates `uv` at pixel
 * centres, so the point sampled for pixel (x, y) is (x + 0.5, y + 0.5).
 */
function expectedPixel(blobs, x, y) {
  const px = x + 0.5
  const py = y + 0.5
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  for (const blob of blobs) {
    const dx = px - blob.center[0]
    const dy = py - blob.center[1]
    const f = falloff(Math.hypot(dx, dy), blob.radius)
    const contribution = blob.color[3] * f
    r += blob.color[0] * contribution
    g += blob.color[1] * contribution
    b += blob.color[2] * contribution
    a += contribution
  }
  return [r, g, b, Math.min(a, 1)].map((v) => Math.round(Math.min(v, 1) * 255))
}

const failures = []
function compare(pixels, blobs, points, label) {
  for (const [x, y] of points) {
    const i = (y * WIDTH + x) * 4
    const actual = [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]
    const expected = expectedPixel(blobs, x, y)
    const ok = actual.every((v, c) => Math.abs(v - expected[c]) <= TOLERANCE)
    if (!ok) failures.push(`${label}@${x},${y}`)
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${label} (${x},${y}) = [${actual.join(', ')}] ref [${expected.join(', ')}]`,
    )
  }
}

const resolved = await resolveShader({ entry: SHADER_ENTRY })
console.log(`resolved shader: ${resolved.wgsl.length} bytes, ${resolved.deps.length} modules`)

const gpu = await init()
const colorTarget = target(gpu, { size: [WIDTH, HEIGHT], format: 'rgba8unorm' })

async function render(blobs) {
  const shader = effect(gpu, resolved.wgsl, {
    set: { params: { resolution: [WIDTH, HEIGHT], blobs } },
  })
  shader.draw(colorTarget)
  return colorTarget.color.read({ mipLevel: 0, region: 'all' })
}

// 1. Single red blob: solid core, linear tail, transparent outside. Also the
//    preview image.
console.log('\nsingle red blob (center 80,45 r=30)')
{
  const blobs = emptyBlobs()
  blobs[0] = { center: [80, 45], radius: 30, color: [1, 0, 0, 1] }
  const px = await render(blobs)
  compare(px, blobs, [[80, 45], [80, 55], [80, 63], [80, 69], [80, 76], [5, 5], [155, 85]], 'red')
  const png = new PNG({ width: WIDTH, height: HEIGHT })
  png.data.set(px)
  writeFileSync(PREVIEW, PNG.sync.write(png))
  console.log(`  wrote ${PREVIEW}`)
}

// 2. Additive accumulation: red + green overlap -> yellow, alpha clamped to 1.
console.log('\nadditive overlap (red @70,45 + green @90,45, r=30)')
{
  const blobs = emptyBlobs()
  blobs[0] = { center: [70, 45], radius: 30, color: [1, 0, 0, 1] }
  blobs[1] = { center: [90, 45], radius: 30, color: [0, 1, 0, 1] }
  const px = await render(blobs)
  compare(px, blobs, [[80, 45], [70, 45], [90, 45], [60, 45], [100, 45], [80, 20]], 'overlap')
}

// 3. Alpha accumulation: a 0.5-alpha contribution per blob sums to 1.
console.log('\nalpha accumulation (two red @0.5, r=12, far apart)')
{
  const blobs = emptyBlobs()
  blobs[0] = { center: [50, 45], radius: 12, color: [1, 0, 0, 0.5] }
  blobs[1] = { center: [110, 45], radius: 12, color: [1, 0, 0, 0.5] }
  const px = await render(blobs)
  compare(px, blobs, [[50, 45], [50, 51], [110, 45], [80, 45]], 'alpha')
}

// 4. Empty field stays fully transparent.
console.log('\nempty field')
{
  const blobs = emptyBlobs()
  const px = await render(blobs)
  const opaque = []
  for (let i = 0; i < px.length; i += 1) if (px[i] !== 0) opaque.push(i)
  console.log(`  ${opaque.length === 0 ? 'ok  ' : 'FAIL'} all pixels transparent`)
  if (opaque.length !== 0) failures.push('empty-field')
}

gpu.dispose()

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall ambient-blob shader checks passed')
