# Example WebGPU backgrounds

These are the **catalog** backgrounds. Install them from a terminal and the
shell picks them up on reload — no rebuild:

```sh
# one, several, or all of them
suwu install --github matrix-rain
suwu install --github --kind background --all
```

Everything lands in `~/.suwu/background/webgpu/<id>/` and appears in
`System Settings → Background` next to the builtin `seascape` and the CPU
backgrounds. `suwu install --background <file.zip>` does the same from a zip
whose root is `background/webgpu/<id>/…`; a hand copy works too:

```sh
cp -r examples/background/webgpu/matrix-rain ~/.suwu/background/webgpu/
```

## Layout

Every background is one directory with the same shape the builtin uses:

```
<id>/
  background.json        # metadata + parameters (JSON only; see below)
  scene.js               # ESM module: export default create(api) -> { start }
  shaders/*.wgsl         # authored WGSL (entry shaders have @fragment/@compute)
  shaders/*.shader.js    # generated ShaderSource artifact (committed)
```

- **`background.json`** — `id` (must equal the directory name), `label`,
  `engine` (`webgpu-render-engine`), optional `credit`, and `params`.
  Parameter kinds: `number` (with `decimals`/`suffix` formatting instead of a
  callback), `boolean`, `select`, `text`, `color`. Invalid manifests are
  skipped by the server, never crash the shell.
- **`scene.js`** — exports `create(api)`, returning `{ start(ctx, params) }`.
  `api` carries the shared engine (`fragmentScene`, `startGpuBackground`,
  `storageAsset`, `texture3dAsset`) plus `vgpu` (`compute`, `effect`, `storage`,
  …). Never import a bare specifier — the browser cannot resolve one; everything
  you need arrives through `api`.
- **`shaders/*.shader.js`** — generated from the `.wgsl` graph. The compiler is
  embedded in `suwu`, so no Node toolchain is required:

  ```sh
  suwu background build shaders/matrix.wgsl > shaders/matrix.shader.js
  ```

  Compile every **entry** shader (any file with `@fragment` or `@compute`);
  helper modules (e.g. `fluid-common.wgsl`) are inlined transitively.

## Why the artifacts are committed

The shell imports `scene.js`, which imports the `.shader.js` artifacts — a
runtime WGSL resolver does not exist in the browser. Committing the artifacts
means `go build` and the release never run the compiler. Regenerate them with
`suwu background build` after editing a `.wgsl`; `pnpm --dir frontend bg:check`
fails CI when an artifact is missing or malformed.

## Sources

| Background | Origin |
| --- | --- |
| atmospheric-landscape | TekF — shadertoy.com/view/slVfD1 |
| cosmos-in-crystal | nayk — shadertoy.com/view/MXccR4 |
| hexagon-landscape | Shane — shadertoy.com/view/tdtyDs |
| interactive-fluid | vgpu Interactive Fluid example — vgpu.sh |
| matrix-rain | Suwu / vgpu example |
| monomino-domino | Shane — shadertoy.com/view/l3sBzM |
| rainforest | Inigo Quilez (iq) — shadertoy.com/view/4ttSWf, used with permission |

Deleting a directory unregisters the background; a stored selection then falls
back to `ambient-blob`.
