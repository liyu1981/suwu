# Backgrounds

Pluggable full-viewport backgrounds for the app shell. A background declares a
**CPU backend**, a **GPU backend**, or both; the selector picks the GPU one when
WebGPU is available and falls back to CPU when there is one. A GPU-only
background simply renders nothing on a browser without WebGPU.

```
components/background/
  index.ts                    # public API + registry barrel
  types.ts                    # Context / Handle / Starter / Definition / Param schema
  registry.ts                 # registerBackground() / getBackground() / listBackgrounds()
  external.ts                 # external list: cache hydration, /api/backgrounds, scene.js loader
  params.ts                   # default + override resolution for the param schema
  select.ts                   # capability detection + gpu -> cpu fallback chain
  useBackground.ts            # React lifecycle hook (detection, reduced motion, remount)
  BackgroundCanvas.tsx        # the app-shell canvas + hook + param resolution
  BackgroundPreview.tsx       # small in-dialog preview (same hook, own canvas)
  canvas-size.ts              # CPU backends size from the canvas layout box
  preview-size.ts             # fitPreviewBox(): aspect-preserving preview box math

  ambient-blob/               # background family: canvas-2D (fallback) + WebGPU
    index.ts                  # definition + registry entry (backend-agnostic)
    params.ts                 # palette + motion math (shared)
    types.ts                  # BlobSeed / RenderBlob / params types (shared)
    ambient-blob-cpu/         # canvas-2D backend (fallback)
    ambient-blob-gpu/         # WebGPU (vgpu) backend + .wgsl shaders

  video/                      # background family (canvas-2D, WebCodecs)
    index.ts                  # definition + params schema (file, fit, speed, mask)
    params.ts                 # typed params + resolveVideoParams() + caps
    video-cpu/
      renderer.ts             # mediabunny playback loop, reduced motion, error overlay
      loop.ts                 # crossfade-loop timing (window + blend progress)
      storage.ts              # OPFS clip library (store/list/read/clear, thumbnails)
      fit.ts                  # cover source rect

  webgpu/                     # the shared WebGPU engine (shipped, not a background)
    webgpu-render-engine/     # host + declarative pass pipeline
      index.ts                # startGpuBackground / fragmentScene / GpuScene / time+size
      host.ts                 # device + surface, device-lost -> ctx.onFatal, teardown
      scene.ts                # GpuScene + lifecycle (loop, resize, reduced motion)
      fragment.ts             # fragmentScene(): targets, assets, samplers, passes
      assets.ts               # storage / texture3d upload helpers
      time.ts, size.ts        # shared epoch; megapixel budget math

repository (outside the bundle):
  backgrounds/webgpu/seascape/   # BUILTIN: embedded in the Go binary
  examples/background/webgpu/*   # EXTERNAL: copied into the data dir by the user
    <id>/background.json + scene.js + shaders/{*.wgsl,*.shader.js}
```

A classic family keeps its nested `<name>-cpu` / `<name>-gpu` backends so their
dependencies stay separate. The engine-backed shadertoy backgrounds are
**external**: their directories are served by the Go backend (the builtin
`seascape` from the embedded FS, the rest from `<dataDir>/background/webgpu`)
and `external.ts` registers them from `GET /api/backgrounds`. Their `scene.js`
is imported lazily when a background starts and receives this bundle's engine
plus `vgpu` through the `create(api)` ABI — see `examples/background/README.md`
for the on-disk format.

## Using a background

```tsx
import { BackgroundCanvas } from '../components/background'

<BackgroundCanvas />                                   // ambient-blob (default)
<BackgroundCanvas background="interactive-fluid" />    // GPU only
```

`BackgroundCanvas` renders the app shell's full-viewport canvas and starts the
selected background. It sets `data-backend` (`gpu` / `cpu`) once a backend is
running.

`BackgroundPreview` renders the same background into a small canvas sized to the
current window's aspect ratio, for the System Settings panel:

```tsx
import { BackgroundPreview } from '../components/background'

<BackgroundPreview />                    // follows the selected background
<BackgroundPreview background="video" /> // a specific background
```

It reuses `useBackground` (so a selection or param change restarts the backend)
and always shows exactly the selected background.

## Adding a background

There are two shapes.

**A classic family** (a CPU backend, a standalone WebGPU backend, or both):

1. Create `<name>/` with the shared params/types and a definition module that
   calls `registerBackground({ id, label, params, cpu, gpu })`; `cpu` and `gpu`
   are dynamic imports of the backend folders (both optional).
2. Create `<name>/<name>-cpu/` and/or `<name>/<name>-gpu/`, each exporting
   `start` with the `BackgroundStarter` signature (the resolved params bag is
   the second argument).
3. Import the definition module from `index.ts` (side-effect import).

**An external WebGPU background** (the normal path — no rebuild): create a
directory under `examples/background/webgpu/<id>/` with `background.json`,
`scene.js` and `shaders/`, compile the entry shaders with the embedded
compiler, and copy the directory into `~/.suwu/background/webgpu/`. The shell
registers it from `GET /api/backgrounds` and imports its `scene.js` when it
starts. `backgrounds/webgpu/seascape/` is the reference implementation — same
format, embedded in the binary instead of copied. The full format and
workflows are documented in `examples/background/README.md`.

Regenerate shader artifacts after editing a `.wgsl`:

```sh
suwu background build shaders/seascape.wgsl > shaders/seascape.shader.js
```

The shell selects a background by id, so new backgrounds need no changes
outside the background directory.

## Parameters

A background can expose user-tunable settings without any UI work. Declare them
in the definition; System Settings renders a control for each kind and stores
the chosen value per background id:

```ts
registerBackground({
  id: 'seascape',
  label: 'Seascape',
  params: [
    {
      kind: 'number',            // slider (also: 'boolean' -> switch, 'select' -> dropdown,
      key: 'speed',              //         'text' -> input, 'file' -> file picker,
      label: 'Animation speed',  //         'color' -> colour picker)
      hint: 'Scales the drift of the camera and the waves.',
      default: 1,
      min: 0,
      max: 3,
      step: 0.05,
      format: (v) => `${v.toFixed(2)}×`,
    },
  ],
  gpu: async () => ({ start }),
})
```

- `defaultBackgroundParams(definition)` / `resolveBackgroundParams(definition,
  overrides)` (in `params.ts`) merge the declared defaults with the stored
  overrides, validating each against its schema — a stale or hand-edited
  localStorage entry can never reach a backend.
- `BackgroundCanvas` resolves the selected background's params and threads them
  through `useBackground` → `startBackground` → `starter(ctx, params)`.
- A params change restarts the backend (the params bag is part of the effect
  deps), because some values (e.g. a palette) can only be applied at setup.
  Sliders therefore commit on release rather than on every drag tick.
- A background reads typed values out of the bag in its own setup/params (e.g.
  `resolveSeascapeParams`) so the schema and the reader stay together.

The parameter schema is the single source of truth for defaults, UI and
validation; a backend never keeps its own copy.

### Credits

A background ported from an external work declares a `credit`. System Settings
renders one line under the background preview:

```ts
credit: { author: 'nayk', url: 'https://www.shadertoy.com/view/MXccR4' },
```

`author` is shown as-is, `url` as a link, and the optional `license` as a
trailing note (e.g. Seascape's `CC BY-NC-SA 3.0`, or Rainforest's
`used with permission`). For an external background it is plain JSON in
`background.json`; for a bundled classic family it is the `credit` field of the
`registerBackground` call. Extract it from the shader header; leave it off for
original work (`matrix-rain`).

## Backends

### Sizing

**Every backend sizes from its canvas's layout box** (`clientWidth ×
clientHeight × dpr`) and never touches `window.innerWidth/innerHeight` or
`canvas.style.*`. The React layer owns layout; the backend only fills the box it
is given. This is what lets the same backend render full-viewport in the shell
and tiny inside `BackgroundPreview`. GPU backends get it from vgpu (a canvas
with a numeric `clientWidth` is layout-backed and auto-resizes each frame); CPU
backends use `canvas-size.ts` and a `ResizeObserver`.

- **CPU** — anything that can render to the canvas without WebGPU. The ambient
  blob CPU backend is canvas-2D, throttled to `ctx.fps`, paused while the tab is
  hidden or the window is blurred, and static under `prefers-reduced-motion`.
- **GPU** — vgpu/WebGPU. The ambient blob GPU backend initialises the device
  *before* touching the canvas, so an unsupported browser falls back cleanly. A
  device lost after the surface is attached calls `ctx.onFatal`, and the hook
  remounts a fresh canvas (a canvas context type is permanent) with the GPU path
  disabled. `interactive-fluid`, `matrix-rain`, `atmospheric-landscape`,
  `cosmos-in-crystal`, `cubic-truchet`, `hexagon-landscape`,
  `monomino-domino`, `seascape` and `rainforest` are GPU-only and have no CPU
  fallback.
- **Video** — the `video` family is CPU-only (canvas-2D). The user picks short
  clips in System Settings; each is copied into an OPFS library (`storage.ts`)
  with a ~2s thumbnail, and the selected one is demuxed/decoded with mediabunny
  (`VideoSampleSink`), drawing the frames to the canvas in a loop. Frames are
  pulled lazily with backpressure, so memory stays bounded regardless of clip
  length. No `<video>` element, no network fetch and no audio. A configurable
  colour mask (colour + opacity, default white 10%) is drawn over the frame.
  Load and codec failures are reported on the canvas itself. The **Smooth loop**
  switch crossfades the last 2s of the clip into a second copy started from the
  beginning (source-over blending, so the mix is exactly
  `outgoing·(1−p) + incoming·p`), hiding the jump at the loop point; it is off
  by default and skipped for clips shorter than 4s.

### WebGPU render engine

The engine-backed backgrounds (external `scene.js`, e.g.
`backgrounds/webgpu/seascape`) share the bundled
`webgpu/webgpu-render-engine/`:

- `startGpuBackground()` owns the lifecycle they used to repeat: device +
  surface creation, device-lost reporting through `ctx.onFatal`, error logging,
  the resize → deferred-redraw wiring, the frame loop (driven by the shared
  `ctx.fps`), reduced-motion settling, and an idempotent teardown.
- `fragmentScene()` builds the common "effect → offscreen target (single or
  ping-pong) → post pass" pipeline from a descriptor: targets, assets, extra
  samplers, pass order, and per-frame `bindings`. `matrix-rain`, `seascape`,
  `atmospheric-landscape`, `cosmos-in-crystal`, `rainforest` and
  `cubic-truchet` are little more than that descriptor plus their `.wgsl`; the
  shaders and their uniform structs are untouched.
- `interactive-fluid`, `hexagon-landscape` and `monomino-domino` use the same
  host but supply a hand-written `GpuScene`: a fixed-step compute simulation,
  a one-off distance-field bake, and a per-frame back-buffer step that has to
  be swapped under the march.
- `time.ts` is one shared epoch for every GPU background (the Shadertoy `iTime`
  model): restarting a backend on a parameter change never snaps the animation
  back to `t = 0`. `size.ts` caps a render budget in megapixels.

`ambient-blob` (the CPU-fallback baseline) and `video` (CPU only) are not part
of the engine. Engine-backed backgrounds declare `engine: WEBGPU_ENGINE`, and
System Settings groups them under one **WebGPU** selector with a second selector
for the currently registered engine backgrounds. A classic family declares
`registerBackground({ id, label, params, gpu })` itself; an external background
declares the same fields as JSON in `background.json` and receives the engine
through its `create(api)` argument — the engine stays an implementation detail
behind each background's `start`.

> **Licensing note.** `rainforest` is an Inigo Quilez (iq) work whose original
> license forbids use in a product, altered or not. It is included with express
> permission from the author. Treat that permission as a dependency of shipping
> the build, and keep it on file.

## Debug overrides

- Backend: `?bg=gpu`, `?bg=cpu`, `?bg=auto`, or
  `localStorage.setItem('suwu.bg', 'cpu')`.

Useful where WebGPU is unavailable: `?bg=cpu` exercises the CPU fallback and
`?bg=gpu` exercises (or visibly fails) the GPU path. The background itself is
chosen in System Settings.

## Testing

`bg:check` compiles every background entry shader with `vgpu check` and
validates each background directory's layout (manifest id matches the
directory, `scene.js` exists, every entry `.wgsl` has a valid `.shader.js`
artifact):

```sh
pnpm --dir frontend bg:check     # all background .wgsl entry shaders + layout
```

The ambient blob shader is additionally validated against an independent JS
reference of the same additive radial-gradient math, without a browser:

```sh
pnpm --dir frontend bg:render           # blob: render offscreen, assert pixels, PNG
pnpm --dir frontend bg:render:matrix    # matrix: render offscreen against a synthetic atlas
pnpm --dir frontend bg:render:hexagon   # hexagon: bake + march offscreen, assert pixels, PNG
pnpm --dir frontend bg:render:domino    # domino: back-buffer to a settled tiling, then march, PNG
pnpm --dir frontend bg:render:truchet   # truchet: march offscreen, assert tubes/bands/blink, PNG
```

Each writes a `scripts/*-preview.png` for visual inspection.
