// Builds the embedded WGSL compiler:
//
//   1. pkg/wgsl/resolver.js — @vgpu/wgsl's resolver bundled to a single IIFE
//      script (Node builtins aliased to the shims/ directory), embedded with
//      //go:embed and executed by pkg/wgsl on the QuickJS runtime.
//   2. pkg/wgsl/wgsl-stdlib.json — the @vgpu/wgsl-std WGSL sources keyed by
//      their package-relative path, merged into the in-memory module map.
//
// Run: pnpm --dir frontend wgsl:compiler   (also part of `pnpm check`? no —
// artifacts are committed; this regenerates them after a vgpu upgrade).
//
// The bundler never resolves `@vgpu/adapter-node` (aliased to a stub) and the
// bundle is written as an IIFE so QuickJS can eval it as a plain script.
import { build } from 'vite';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as pathResolve, relative, sep } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = pathResolve(here, '..', '..', '..');
const outDir = join(repoRoot, 'pkg', 'wgsl');
const entry = join(here, 'entry.js');

const shims = {
  'node:fs': join(here, 'shims/node-fs.js'),
  'node:fs/promises': join(here, 'shims/node-fs-promises.js'),
  'node:crypto': join(here, 'shims/node-crypto.js'),
  'node:module': join(here, 'shims/node-module.js'),
  'node:buffer': join(here, 'shims/node-buffer.js'),
  'node:path': join(here, 'shims/node-path.js'),
  '@vgpu/adapter-node': join(here, 'shims/adapter-node.js'),
};

const output = await build({
  configFile: false,
  logLevel: 'warn',
  resolve: {
    alias: Object.entries(shims).map(([find, replacement]) => ({
      find: new RegExp(`^${find.replace(/[/\\]/g, '\\$&')}$`),
      replacement,
    })),
  },
  build: {
    write: false,
    minify: true,
    target: 'es2021',
    lib: {
      entry,
      formats: ['iife'],
      name: 'SuwuWgslCompiler',
      fileName: () => 'resolver.js',
    },
  },
});

const bundle = Array.isArray(output) ? output[0].output : output.output;
let code = null;
for (const chunk of bundle) {
  if (chunk.type === 'chunk' && chunk.fileName.endsWith('.js')) code = chunk.code;
}
if (code === null) {
  console.error('wgsl-compiler: bundle produced no JS chunk');
  process.exit(1);
}
// `createRequire(import.meta.url)` sits in an unreachable package-alongside
// fallback; QuickJS script mode has no import.meta, so drop it wholesale.
code = code.replaceAll('import.meta.url', '""');
if (code.includes('import.meta')) {
  console.error('wgsl-compiler: unhandled import.meta in bundle');
  process.exit(1);
}
// Verify the bundle parses as a *script* (QuickJS evals it in script mode, so
// `import`/`export` statements would be a SyntaxError here too). Parsing with
// `new Function` is immune to the string-literal false positives a regex has.
try {
  new Function(code);
} catch (err) {
  console.error(`wgsl-compiler: bundle is not valid script code: ${err.message}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'resolver.js'), code);

// ── @vgpu/wgsl-std sources → wgsl-stdlib.json ────────────────────────────────
const require = createRequire(import.meta.url);
const wgslRuntime = require.resolve('@vgpu/wgsl/runtime');
const hashPath = createRequire(wgslRuntime).resolve('@vgpu/wgsl-std/hash');
const srcRoot = pathResolve(hashPath, '..', '..'); // @vgpu/wgsl-std/src

const stdlib = {};
// Keys carry the packageMap prefix (/vgpu/wgsl-std/) so a bare
// `@vgpu/wgsl-std/hash` import resolves to /vgpu-wgsl-std/hash/index.wgsl
// through packageMap { '@vgpu/wgsl-std/': '/vgpu-wgsl-std/' }.
const walk = (rel) => {
  const abs = join(srcRoot, rel);
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(child);
    else if (e.name.endsWith('.wgsl'))
      stdlib[`/vgpu-wgsl-std/${child}`] = readFileSync(join(abs, e.name), 'utf8');
  }
};
walk('');
writeFileSync(join(outDir, 'wgsl-stdlib.json'), `${JSON.stringify(stdlib)}\n`);

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
console.log(
  `wgsl-compiler: resolver.js ${kb(statSync(join(outDir, 'resolver.js')).size)}, ` +
    `wgsl-stdlib.json ${kb(statSync(join(outDir, 'wgsl-stdlib.json')).size)} ` +
    `(${Object.keys(stdlib).length} modules from ${relative(repoRoot, srcRoot).split(sep).join('/')})`,
);
