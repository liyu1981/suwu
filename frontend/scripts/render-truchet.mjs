// Headless pixel test for the Cubic Truchet shaders.
//
// The dev machine has no hardware WebGPU, so the shaders are validated by
// rendering offscreen with vgpu/node (Mesa llvmpipe), exactly as scene.js
// encodes them: one march pass into an offscreen target, one blit to an
// output target. Checks the scene is lit and structured, the three object
// categories show (near-white tubes, colorful bands/lights), the animation
// moves, and a fixed time renders an identical frame.
//
//   pnpm --dir frontend bg:render:truchet
//
// Also writes truchet-preview.png next to this script.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { resolveShader } from '@vgpu/wgsl/runtime'
import { effect, frame, init, sampler, target } from 'vgpu/node'

const WIDTH = 320
const HEIGHT = 200

const SHADERS = new URL('../../examples/background/webgpu/cubic-truchet/shaders/', import.meta.url)
const PREVIEW = fileURLToPath(new URL('./truchet-preview.png', import.meta.url))

const failures = []
function check(condition, label, detail = '') {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

const resolved = {}
for (const name of ['truchet', 'blit']) {
  resolved[name] = await resolveShader({ entry: fileURLToPath(new URL(`${name}.wgsl`, SHADERS)) })
}
console.log(
  `resolved shaders: ${Object.entries(resolved)
    .map(([k, v]) => `${k} ${v.wgsl.length}B`)
    .join(', ')}`,
)

const gpu = await init()
const scene = target(gpu, {
  size: [WIDTH, HEIGHT],
  format: 'rgba16float',
  clearColor: [0, 0, 0, 1],
})
const output = target(gpu, { size: [WIDTH, HEIGHT], format: 'rgba8unorm', clearColor: [0, 0, 0, 1] })

const march = effect(gpu, resolved.truchet.wgsl, { label: 'cubic-truchet' })
const blit = effect(gpu, resolved.blit.wgsl, { label: 'cubic-truchet-blit' })
const samp = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' })

function renderAt(time) {
  frame(gpu, (current) => {
    march.set({ params: { resolution: [WIDTH, HEIGHT], time, _pad: 0 } })
    current.pass(scene, march)
    blit.set({ src: scene, samp })
    current.pass(output, blit)
  })
  return output.color.read({ mipLevel: 0, region: 'all' })
}

function stats(pixels) {
  let lit = 0
  let colorful = 0
  let white = 0
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]
    const g = pixels[i + 1]
    const b = pixels[i + 2]
    const l = (r + g + b) / 3
    if (r + g + b > 24) lit++
    if (Math.max(r, g, b) - Math.min(r, g, b) > 32) colorful++
    if (Math.min(r, g, b) > 170) white++
    sum += l
    sumSq += l * l
  }
  const n = pixels.length / 4
  const mean = sum / n
  return { n, lit, colorful, white, mean, stddev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) }
}

console.log('\nscene pass (t=10, t=12)')
const first = await renderAt(10)
const second = await renderAt(12)
const a = stats(first)
const b = stats(second)
console.log(
  `  t=10: mean ${a.mean.toFixed(1)}, stddev ${a.stddev.toFixed(1)}, lit ${a.lit}, colorful ${a.colorful}, white ${a.white}`,
)
console.log(`  t=12: mean ${b.mean.toFixed(1)}, stddev ${b.stddev.toFixed(1)}`)

check(a.lit > a.n * 0.3, 'scene is lit', `${a.lit}/${a.n} lit`)
check(a.stddev > 8, 'scene has structure', `stddev ${a.stddev.toFixed(1)}`)
check(a.colorful > a.n * 0.05, 'the colored bands/lights render', `${a.colorful} colorful pixels`)
check(a.white > 0, 'the whitish tubes render', `${a.white} near-white pixels`)

let moved = 0
for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) moved++
check(moved > 0, 'animation moves the camera/lights', `${moved} differing bytes`)

// The march is stateless: same time, same image.
const repeat = await renderAt(10)
let drift = 0
for (let i = 0; i < first.length; i++) if (first[i] !== repeat[i]) drift++
check(drift === 0, 'a fixed time renders an identical frame', `${drift} differing bytes`)

const png = new PNG({ width: WIDTH, height: HEIGHT })
png.data.set(second)
writeFileSync(PREVIEW, PNG.sync.write(png))
console.log(`\nwrote ${PREVIEW}`)

gpu.dispose()

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall cubic-truchet shader checks passed')
