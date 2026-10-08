// Headless pixel test for the Hexagon Landscape shaders.
//
// The dev machine has no hardware WebGPU, so the shaders are validated by
// rendering offscreen with vgpu/node (Mesa llvmpipe): the two baked tiles
// (distance field + height map) are filled once, then the raymarch runs into
// an offscreen target and is blitted to an output target, exactly as scene.js
// encodes them. Checks the bake is non-empty, the scene has structure and the
// documented palette, and that the animation moves the camera.
//
//   pnpm --dir frontend bg:render:hexagon
//
// Also writes hexagon-preview.png next to this script.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { resolveShader } from '@vgpu/wgsl/runtime'
import { effect, frame, init, sampler, target } from 'vgpu/node'

const WIDTH = 320
const HEIGHT = 200
const FIELD_SIZE = 1024

const SHADERS = new URL('../../examples/background/webgpu/hexagon-landscape/shaders/', import.meta.url)
const PREVIEW = fileURLToPath(new URL('./hexagon-preview.png', import.meta.url))

const failures = []
function check(condition, label, detail = '') {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

// Float targets read back as raw little-endian bytes; the tiles are
// rgba16float and r16float, so decode half floats.
function half(bytes, offset) {
  const h = bytes[offset] | (bytes[offset + 1] << 8)
  const sign = h & 0x8000 ? -1 : 1
  const exp = (h & 0x7c00) >> 10
  const frac = h & 0x03ff
  if (exp === 0) return sign * 6.103515625e-5 * (frac / 1024)
  if (exp === 0x1f) return Number.NaN
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024)
}

const resolved = {}
for (const name of ['field', 'height', 'scene', 'blit']) {
  resolved[name] = await resolveShader({ entry: fileURLToPath(new URL(`${name}.wgsl`, SHADERS)) })
}
console.log(
  `resolved shaders: ${Object.entries(resolved)
    .map(([k, v]) => `${k} ${v.wgsl.length}B`)
    .join(', ')}`,
)

const gpu = await init()
const field = target(gpu, {
  size: [FIELD_SIZE, FIELD_SIZE],
  format: 'rgba16float',
  clearColor: [0, 0, 0, 1],
})
const heights = target(gpu, {
  size: [FIELD_SIZE, FIELD_SIZE],
  format: 'r16float',
  clearColor: [0, 0, 0, 1],
})
const scene = target(gpu, {
  size: [WIDTH, HEIGHT],
  format: 'rgba16float',
  clearColor: [0, 0, 0, 1],
})
const output = target(gpu, { size: [WIDTH, HEIGHT], format: 'rgba8unorm', clearColor: [0, 0, 0, 1] })

const bakeField = effect(gpu, resolved.field.wgsl, { label: 'hexagon-field' })
const bakeHeight = effect(gpu, resolved.height.wgsl, { label: 'hexagon-height' })
const march = effect(gpu, resolved.scene.wgsl, { label: 'hexagon-scene' })
const blit = effect(gpu, resolved.blit.wgsl, { label: 'hexagon-blit' })
const samp = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' })

function renderAt(time) {
  frame(gpu, (current) => {
    // Bake once, exactly as scene.js does.
    if (!baked) {
      current.pass(field, bakeField)
      current.pass(heights, bakeHeight)
      baked = true
    }
    march.set({
      params: { resolution: [WIDTH, HEIGHT], time, _pad: 0 },
      field_tex: field,
      height_tex: heights,
    })
    current.pass(scene, march)
    blit.set({ src: scene, samp })
    current.pass(output, blit)
  })
}

let baked = false

async function readOutput() {
  return output.color.read({ mipLevel: 0, region: 'all' })
}

// ── Bake: the distance field and height map ─────────────────────────────────
console.log('\nscene pass (t=10, t=14)')
const first = await (async () => {
  renderAt(10)
  return readOutput()
})()

console.log('\nbake tiles (filled on the first frame)')
{
  const fieldBytes = await field.color.read({ mipLevel: 0, region: 'all' })
  const texels = FIELD_SIZE * FIELD_SIZE
  let finite = 0
  let negative = 0
  for (let t = 0; t < texels; t++) {
    const d = half(fieldBytes, t * 8)
    if (Number.isFinite(d)) finite++
    if (d < 0) negative++
  }
  check(finite === texels, 'field texels are finite', `${finite} of ${texels}`)
  // Every tile of world space contains block interiors, where the distance is
  // negative; an unwritten (cleared) tile would be all zeros.
  check(negative > 0, 'field contains block interiors', `${negative} negative texels`)

  const heightBytes = await heights.color.read({ mipLevel: 0, region: 'all' })
  let varied = 0
  let minH = Infinity
  let maxH = -Infinity
  for (let t = 0; t < texels; t++) {
    const h = half(heightBytes, t * 2)
    if (Number.isFinite(h)) {
      minH = Math.min(minH, h)
      maxH = Math.max(maxH, h)
    }
    if (h > 0.1 && h < 0.9) varied++
  }
  check(varied > 0, 'height map varies', `range [${minH.toFixed(3)}, ${maxH.toFixed(3)}]`)
  check(minH > 0 && maxH < 1 && maxH - minH > 0.05, 'height map spans a useful range')
}

// ── Scene: structure, palette, animation ────────────────────────────────────
const second = await (async () => {
  renderAt(14)
  return readOutput()
})()

function stats(pixels) {
  let lit = 0
  let green = 0
  let red = 0
  let blue = 0
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]
    const g = pixels[i + 1]
    const b = pixels[i + 2]
    const l = (r + g + b) / 3
    if (r + g + b > 24) lit++
    if (g > r * 1.15 && g > b * 1.15) green++
    if (r > g * 1.3 && r > b * 1.3) red++
    if (b > r * 1.15 && b > g * 1.05) blue++
    sum += l
    sumSq += l * l
  }
  const n = pixels.length / 4
  const mean = sum / n
  return {
    n,
    lit,
    green,
    red,
    blue,
    mean,
    stddev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
  }
}

const a = stats(first)
const b = stats(second)
console.log(
  `  t=10: mean ${a.mean.toFixed(1)}, stddev ${a.stddev.toFixed(1)}, green ${a.green}, red ${a.red}, blue ${a.blue}`,
)
console.log(
  `  t=14: mean ${b.mean.toFixed(1)}, stddev ${b.stddev.toFixed(1)}, green ${b.green}, red ${b.red}, blue ${b.blue}`,
)

check(a.lit > a.n * 0.5, 'scene is lit (fog/sky covers the misses)', `${a.lit}/${a.n} lit`)
check(a.stddev > 8, 'scene has structure', `stddev ${a.stddev.toFixed(1)}`)
check(a.green > 0, 'grass renders', `${a.green} green-dominant pixels`)
check(a.red > 0, 'roofs render', `${a.red} red-dominant pixels`)
check(a.blue > 0, 'water or sky renders', `${a.blue} blue-dominant pixels`)

let moved = 0
for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) moved++
check(moved > 0, 'animation moves the camera', `${moved} differing bytes`)

// Same time, same image: the march is stateless (no temporal feedback), which
// is what makes the speed setting a pure time-scale.
renderAt(10)
const repeat = await readOutput()
let drift = 0
for (let i = 0; i < first.length; i++) if (first[i] !== repeat[i]) drift++
check(drift === 0, 'a fixed time renders an identical frame', `${drift} differing bytes`)

// Long flights keep their structure: the tiles wrap with fract(), so a camera
// far past the first tile must still hit wrapped field and height texels.
renderAt(600)
const far = await readOutput()
const farStats = stats(far)
console.log(`  t=600: mean ${farStats.mean.toFixed(1)}, stddev ${farStats.stddev.toFixed(1)}`)
check(farStats.stddev > 8, 'the wrapped field still renders structure at t=600', `stddev ${farStats.stddev.toFixed(1)}`)

const png = new PNG({ width: WIDTH, height: HEIGHT })
png.data.set(second)
writeFileSync(PREVIEW, PNG.sync.write(png))
console.log(`\nwrote ${PREVIEW}`)

gpu.dispose()

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall hexagon-landscape shader checks passed')
