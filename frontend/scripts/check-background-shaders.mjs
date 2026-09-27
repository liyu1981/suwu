// Validates every background shader with `vgpu check` (resolves the WGSL import
// graph and compiles it), and checks each background directory's layout:
// a parseable background.json whose id matches the directory name, scene.js,
// and a .shader.js artifact next to every entry shader.
//
// Roots: the in-bundle backgrounds (ambient-blob/video) plus the external
// layout — backgrounds/webgpu (builtin) and examples/background/webgpu.
//
//   pnpm --dir frontend bg:check
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = fileURLToPath(new URL('..', import.meta.url))
const repoDir = fileURLToPath(new URL('../..', import.meta.url))
const vgpuBin = join(frontendDir, 'node_modules', '.bin', 'vgpu')

const shaderRoots = [
  join(frontendDir, 'src', 'components', 'background'),
  join(repoDir, 'backgrounds'),
  join(repoDir, 'examples', 'background'),
]
const manifestRoots = [join(repoDir, 'backgrounds', 'webgpu'), join(repoDir, 'examples', 'background', 'webgpu')]

function findShaders(dir) {
  if (!existsSync(dir)) return []
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findShaders(path))
    else if (entry.name.endsWith('.wgsl')) found.push(path)
  }
  return found
}

function findBackgroundDirs() {
  const found = []
  for (const root of manifestRoots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(join(root, entry.name))
    }
  }
  return found
}

let failed = 0
const fail = (label, message) => {
  failed++
  console.error(`FAIL ${label}`)
  if (message) console.error(message)
}

// ── layout: manifest + entry + artifact ──────────────────────────────────────
for (const dir of findBackgroundDirs()) {
  const label = relative(repoDir, dir)
  const manifestPath = join(dir, 'background.json')
  if (!existsSync(manifestPath)) {
    fail(label, 'missing background.json')
    continue
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail(`${label}/background.json`, `invalid JSON: ${error.message}`)
    continue
  }
  if (manifest.id !== basename(dir)) {
    fail(label, `manifest id "${manifest.id}" must equal the directory name`)
  }
  if (!existsSync(join(dir, 'scene.js'))) fail(label, 'missing scene.js')

  for (const shader of findShaders(join(dir, 'shaders'))) {
    const source = readFileSync(shader, 'utf8')
    if (!source.includes('@fragment') && !source.includes('@compute')) continue
    const artifact = shader.replace(/\.wgsl$/, '.shader.js')
    if (!existsSync(artifact)) {
      fail(relative(repoDir, shader), `missing artifact ${basename(artifact)} (suwu background build)`)
      continue
    }
    const artifactSource = readFileSync(artifact, 'utf8')
    if (!artifactSource.startsWith('export default { version: 1, wgsl: ')) {
      fail(relative(repoDir, artifact), 'not a ShaderSource module (regenerate it)')
    }
    if (!artifactSource.includes('functionExports:')) {
      fail(relative(repoDir, artifact), 'missing functionExports (regenerate it)')
    }
  }
}

// ── compile every entry shader ───────────────────────────────────────────────
// Only entry shaders (fragment/compute); imported helper modules are validated
// transitively by the entry that imports them.
const entries = shaderRoots.flatMap(findShaders).filter((file) => {
  const source = readFileSync(file, 'utf8')
  return source.includes('@fragment') || source.includes('@compute')
})

for (const file of entries) {
  const label = relative(frontendDir, file)
  try {
    execFileSync(vgpuBin, ['check', file], { cwd: frontendDir, stdio: 'pipe' })
    console.log(`ok   ${label}`)
  } catch (error) {
    console.error(`FAIL ${label}`)
    failed++
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
    if (output) console.error(output)
  }
}

if (failed > 0) {
  console.error(`\n${failed} background problem(s) found`)
  process.exit(1)
}
console.log(`\n${entries.length} entry shader(s) validated, ${findBackgroundDirs().length} background dir(s) checked`)
