// Validates every background entry shader with `vgpu check` (resolves the WGSL
// import graph and compiles it), so a broken shader fails `bg:check` in CI
// instead of only at runtime.
//
//   pnpm --dir frontend bg:check
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = fileURLToPath(new URL('..', import.meta.url))
const backgroundsDir = join(frontendDir, 'src', 'components', 'background')
const vgpuBin = join(frontendDir, 'node_modules', '.bin', 'vgpu')

function findShaders(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findShaders(path))
    else if (entry.name.endsWith('.wgsl')) found.push(path)
  }
  return found
}

// Only entry shaders (fragment/compute); imported helper modules are validated
// transitively by the entry that imports them.
const entries = findShaders(backgroundsDir).filter((file) => {
  const source = readFileSync(file, 'utf8')
  return source.includes('@fragment') || source.includes('@compute')
})

let failed = 0
for (const file of entries) {
  const label = relative(backgroundsDir, file)
  try {
    execFileSync(vgpuBin, ['check', file], { cwd: frontendDir, stdio: 'pipe' })
    console.log(`ok   ${label}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${label}`)
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
    if (output) console.error(output)
  }
}

if (failed > 0) {
  console.error(`\n${failed} background shader(s) failed`)
  process.exit(1)
}
console.log(`\n${entries.length} background shader(s) validated`)
