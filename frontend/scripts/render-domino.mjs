// Headless pixel test for the Monomino Domino shaders.
//
// The dev machine has no hardware WebGPU, so the shaders are validated by
// rendering offscreen with vgpu/node (Mesa llvmpipe), exactly as scene.js
// encodes them: the 32×32 back-buffer ping-pongs until the tiling settles,
// then the raymarch runs into an offscreen target and is blitted to an output
// target. Checks the tiling's invariants (every cell carries its ID, links
// form matched domino pairs, monominos remain), the scene's structure, the
// documented palette, and that the animation moves the camera.
//
//   pnpm --dir frontend bg:render:domino
//
// Also writes domino-preview.png next to this script.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { resolveShader } from '@vgpu/wgsl/runtime'
import { effect, frame, init, pingPong, sampler, target } from 'vgpu/node'

const WIDTH = 320
const HEIGHT = 200
const GRID = 32
const CELLS = GRID * GRID
const SETTLE_STEPS = 240

const SHADERS = new URL('../../examples/background/webgpu/monomino-domino/shaders/', import.meta.url)
const PREVIEW = fileURLToPath(new URL('./domino-preview.png', import.meta.url))

const failures = []
function check(condition, label, detail = '') {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

const resolved = {}
for (const name of ['tiling', 'scene', 'blit']) {
  resolved[name] = await resolveShader({ entry: fileURLToPath(new URL(`${name}.wgsl`, SHADERS)) })
}
console.log(
  `resolved shaders: ${Object.entries(resolved)
    .map(([k, v]) => `${k} ${v.wgsl.length}B`)
    .join(', ')}`,
)

const gpu = await init()
const cells = pingPong(gpu, GRID, GRID, {
  format: 'rgba32float',
  clearColor: [0, 0, 0, 1],
})
const scene = target(gpu, {
  size: [WIDTH, HEIGHT],
  format: 'rgba16float',
  clearColor: [0, 0, 0, 1],
})
const output = target(gpu, { size: [WIDTH, HEIGHT], format: 'rgba8unorm', clearColor: [0, 0, 0, 1] })

const tiling = effect(gpu, resolved.tiling.wgsl, { label: 'domino-tiling' })
const march = effect(gpu, resolved.scene.wgsl, { label: 'domino-scene' })
const blit = effect(gpu, resolved.blit.wgsl, { label: 'domino-blit' })
const samp = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' })

// One back-buffer step, then swap so the march reads the fresh state.
let steps = -1
function stepTiling(current, gate) {
  steps += 1
  tiling.set({ info: { frame: steps, gate, _pad: [0, 0] }, buf_in: cells.read })
  current.pass(cells.write, tiling)
  cells.swap()
}

function stepN(n) {
  // One frame per step: an effect's uniforms are shared by every pass of a
  // frame, so back-to-back steps in one frame would all hash the last step's
  // frame counter.
  for (let i = 0; i < n; i++) {
    frame(gpu, (current) => stepTiling(current, 0))
  }
}

// The scene + blit only — no stepping, so a fixed time is repeatable.
function renderAt(time) {
  frame(gpu, (current) => {
    march.set({ params: { resolution: [WIDTH, HEIGHT], time, _pad: 0 }, buf_in: cells.read })
    current.pass(scene, march)
    blit.set({ src: scene, samp })
    current.pass(output, blit)
  })
  return output.color.read({ mipLevel: 0, region: 'all' })
}

// rgba32float reads back as raw little-endian bytes (or, on some paths, as
// floats); decode whichever arrives.
function cellFloats(raw) {
  if (raw instanceof Float32Array) return raw
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const out = new Float32Array(raw.byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true)
  return out
}

function readCells() {
  return cells.read.color.read({ mipLevel: 0, region: 'all' }).then(cellFloats)
}

// -- Direction helpers, mirroring common.wgsl -------------------------------
const DIRS = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
]

// ── Back-buffer: initialization ─────────────────────────────────────────────
console.log('\nback-buffer: initialization (step 0)')
stepN(1)
{
  const s = await readCells()
  let idsOk = 0
  let seeded = 0
  let linked = 0
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const i = (y * GRID + x) * 4
      const a = s[i]
      if (s[i + 1] === y * GRID + x) idsOk++
      // Links are 1..4; a force-seeded monomino is 0.01, an empty cell 0.
      if (a >= 0.5) linked++
      else if (a > 0) seeded++
    }
  }
  check(idsOk === CELLS, 'every cell stores its position ID', `${idsOk}/${CELLS}`)
  check(seeded > 0, 'some monominos are force-seeded', `${seeded} seeded`)
  check(linked === 0, 'no links exist before evolution', `${linked} linked`)
}

// ── Back-buffer: the tiling settles ────────────────────────────────────────
console.log(`\nback-buffer: evolution (${SETTLE_STEPS} forced steps)`)
stepN(SETTLE_STEPS)
{
  const s = await readCells()
  let linked = 0
  let monomino = 0
  let pairsOk = 0
  let pairBreaks = 0
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const i = (y * GRID + x) * 4
      const a = s[i]
      if (a < 0.5) {
        monomino++
        continue
      }
      linked++
      // A link stores its direction + 1; the partner must be linked back in
      // exactly the opposite direction, which is what makes it a domino.
      const dir = DIRS[Math.round(a) - 1]
      if (!dir) {
        pairBreaks++
        continue
      }
      const nx = (x + dir[0] + GRID) % GRID
      const ny = (y + dir[1] + GRID) % GRID
      const b = s[(ny * GRID + nx) * 4]
      const back = DIRS[Math.round(b) - 1]
      if (back && back[0] === -dir[0] && back[1] === -dir[1]) pairsOk++
      else pairBreaks++
    }
  }
  const ratio = (100 * linked) / CELLS
  check(linked > CELLS * 0.25, 'the tiling links into dominoes', `${ratio.toFixed(1)}% linked`)
  check(monomino > 0, 'monominoes remain', `${monomino} single cells`)
  check(pairBreaks === 0, 'every link is a matched pair', `${pairsOk} pairs, ${pairBreaks} broken`)
  console.log(`  ${linked} linked cells, ${monomino} monominoes`)
}

// ── Scene: structure, palette, animation ────────────────────────────────────
console.log('\nscene pass (t=10, t=12)')
const first = await renderAt(10)
const second = await renderAt(12)

function stats(pixels) {
  let lit = 0
  let colorful = 0
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]
    const g = pixels[i + 1]
    const b = pixels[i + 2]
    const l = (r + g + b) / 3
    if (r + g + b > 24) lit++
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24) colorful++
    sum += l
    sumSq += l * l
  }
  const n = pixels.length / 4
  const mean = sum / n
  return { n, lit, colorful, mean, stddev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) }
}

const a = stats(first)
const b = stats(second)
console.log(`  t=10: mean ${a.mean.toFixed(1)}, stddev ${a.stddev.toFixed(1)}, colorful ${a.colorful}`)
console.log(`  t=12: mean ${b.mean.toFixed(1)}, stddev ${b.stddev.toFixed(1)}, colorful ${b.colorful}`)

check(a.lit > a.n * 0.8, 'scene is lit (no fog, black would be a failure)', `${a.lit}/${a.n} lit`)
check(a.stddev > 8, 'scene has structure', `stddev ${a.stddev.toFixed(1)}`)
check(a.colorful > a.n * 0.05, 'the palette colors the tiles', `${a.colorful} colorful pixels`)

let moved = 0
for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) moved++
check(moved > 0, 'animation moves the camera/heights', `${moved} differing bytes`)

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
console.log('\nall monomino-domino shader checks passed')
