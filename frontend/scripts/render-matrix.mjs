// Headless pixel test for the Matrix rain + CRT shaders.
//
// The dev machine has no hardware WebGPU, so the shaders are validated by
// rendering offscreen with vgpu/node (Mesa llvmpipe) against a synthetic 1-bit
// glyph atlas. Checks the rain structure (mostly black, green, glyph-shaped
// cells, animation) and that the CRT pass changes the image.
//
//   pnpm --dir frontend bg:render:matrix
//
// Also writes matrix-preview.png next to this script.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { resolveShader } from '@vgpu/wgsl/runtime'
import { effect, frame, init, sampler, storage, target } from 'vgpu/node'

const WIDTH = 320
const HEIGHT = 240
const CELL_W = 24
const CELL_H = 30
const GLYPH_W = 24
const GLYPH_H = 30
const WORDS_PER_GLYPH = Math.ceil((GLYPH_W * GLYPH_H) / 32)

const SHADERS = new URL('../src/components/background/matrix-rain/matrix-rain-gpu/shaders/', import.meta.url)
const PREVIEW = fileURLToPath(new URL('./matrix-preview.png', import.meta.url))

// One synthetic glyph: a checkerboard, so a lit cell has both ink and gaps.
function checkerboardAtlas() {
  const words = new Uint32Array(WORDS_PER_GLYPH)
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < GLYPH_W; x++) {
      if ((x + y) % 2 === 0) {
        const bit = y * GLYPH_W + x
        words[bit >> 5] |= 1 << (bit & 31)
      }
    }
  }
  return words
}

const failures = []
function check(condition, label, detail = '') {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

const matrixResolved = await resolveShader({ entry: fileURLToPath(new URL('matrix.wgsl', SHADERS)) })
const crtResolved = await resolveShader({ entry: fileURLToPath(new URL('crt.wgsl', SHADERS)) })
console.log(`resolved shaders: matrix ${matrixResolved.wgsl.length}B, crt ${crtResolved.wgsl.length}B`)

const gpu = await init()
const scene = target(gpu, { size: [WIDTH, HEIGHT], format: 'rgba8unorm', clearColor: [0, 0, 0, 1] })
const output = target(gpu, { size: [WIDTH, HEIGHT], format: 'rgba8unorm', clearColor: [0, 0, 0, 1] })

const atlas = checkerboardAtlas()
const glyphs = storage(gpu, atlas.byteLength, 'read')
glyphs.write(atlas)

const rain = effect(gpu, matrixResolved.wgsl, {
  label: 'matrix-rain',
  set: {
    params: { resolution: [WIDTH, HEIGHT], cell: [CELL_W, CELL_H], time: 0, glyph_count: 1 },
    glyphs,
  },
})
const crt = effect(gpu, crtResolved.wgsl, {
  label: 'matrix-rain-crt',
  set: {
    params: {
      output_size: [WIDTH, HEIGHT],
      time: 0,
      curvature: 0.03,
      scanline: 0.55,
      aberration: 0.0016,
      vignette: 0.7,
      bloom: 0.5,
      flicker: 0,
    },
    src: scene,
    samp: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
  },
})

function isLit(px, i) {
  return px[i] + px[i + 1] + px[i + 2] > 24
}

async function renderRain(time) {
  rain.set({ params: { time } })
  rain.draw(scene)
  return scene.color.read({ mipLevel: 0, region: 'all' })
}

async function renderCrt(time) {
  rain.set({ params: { time } })
  crt.set({ params: { time } })
  frame(gpu, (current) => {
    current.pass(scene, rain)
    current.pass(output, crt)
  })
  return output.color.read({ mipLevel: 0, region: 'all' })
}

console.log('\nrain pass (t=0)')
const rawRain = await renderRain(0)
let rawLit = 0
for (let i = 0; i < rawRain.length; i += 4) if (isLit(rawRain, i)) rawLit++

// Glyph shape: the lit pixel's cell must contain both ink and gaps.
if (rawLit > 0) {
  let firstLit = -1
  for (let i = 0; i < rawRain.length; i += 4) {
    if (isLit(rawRain, i)) {
      firstLit = i
      break
    }
  }
  const x = (firstLit / 4) % WIDTH
  const y = Math.floor(firstLit / 4 / WIDTH)
  const col = Math.floor(x / CELL_W)
  const row = Math.floor(y / CELL_H)
  let cellLit = 0
  let cellDark = 0
  for (let cy = row * CELL_H; cy < (row + 1) * CELL_H; cy++) {
    for (let cx = col * CELL_W; cx < (col + 1) * CELL_W; cx++) {
      const i = (cy * WIDTH + cx) * 4
      if (isLit(rawRain, i)) cellLit++
      else cellDark++
    }
  }
  check(cellLit > 0 && cellDark > 0, 'glyph coverage is not a filled cell', `ink=${cellLit} gap=${cellDark}`)
}

console.log('\ncrt pass (t=0, t=1.5)')
const first = await renderCrt(0)
const second = await renderCrt(1.5)

let lit = 0
let greenDominant = 0
for (let i = 0; i < first.length; i += 4) {
  if (isLit(first, i)) {
    lit++
    if (first[i + 1] > first[i] && first[i + 1] > first[i + 2]) greenDominant++
  }
}
const blackFraction = 1 - lit / (WIDTH * HEIGHT)
check(lit > 0, 'some pixels are lit')
check(blackFraction > 0.4, 'background is mostly black', `${(blackFraction * 100).toFixed(1)}% black`)
const greenRatio = lit > 0 ? greenDominant / lit : 0
check(greenRatio > 0.9, 'lit pixels are predominantly green', `${(greenRatio * 100).toFixed(1)}% green-dominant`)

let differsFromRain = 0
for (let i = 0; i < first.length; i++) if (first[i] !== rawRain[i]) differsFromRain++
check(differsFromRain > 0, 'crt pass changes the image', `${differsFromRain} differing bytes`)

let animated = 0
for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) animated++
check(animated > 0, 'animation changes the frame', `${animated} differing bytes`)

const png = new PNG({ width: WIDTH, height: HEIGHT })
png.data.set(second)
writeFileSync(PREVIEW, PNG.sync.write(png))
console.log(`\nwrote ${PREVIEW}`)

gpu.dispose()

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall matrix-rain shader checks passed')
