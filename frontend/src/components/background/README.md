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

  webgpu/                     # the WebGPU background family
    index.ts                  # registers every shadertoy (side-effect imports)
    webgpu-render-engine/     # shared host + declarative pipeline
      index.ts                # startGpuBackground / fragmentScene / GpuScene / time+size
      host.ts                 # device + surface, device-lost -> ctx.onFatal, teardown
      scene.ts                # GpuScene + lifecycle (loop, resize, reduced motion)
      fragment.ts             # fragmentScene(): targets, assets, samplers, passes
      assets.ts               # storage / texture3d upload helpers
      time.ts, size.ts        # shared epoch; megapixel budget math
    shadertoys/
      seascape/               # one shadertoy = one setup.ts + its .wgsl
        setup.ts              # params + definition + scene
        shaders/*.wgsl
      atmospheric-landscape/  # setup.ts merges params + noise-volume builder + scene
      rainforest/             # setup.ts merges params + scene
      matrix-rain/            # setup.ts merges params + glyph-atlas builder + scene
      interactive-fluid/      # setup.ts merges params + pointer input + solver + scene
```

A classic family keeps its nested `<name>-cpu` / `<name>-gpu` backends so their
dependencies stay separate. An engine-backed shadertoy keeps everything in one
`setup.ts` next to its `shaders/`: the eager path is metadata only, and the
heavy code — `vgpu`, the engine and the `.wgsl` — sits behind a dynamic import,
so those chunks are fetched only when the background actually runs.

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

**A WebGPU shadertoy** (built on the shared engine) is one file: drop
`webgpu/shadertoys/<name>/setup.ts` plus its `shaders/*.wgsl`, then add the
side-effect import to `webgpu/index.ts`. `setup.ts` declares the params, calls
`registerBackground({ ..., engine: WEBGPU_ENGINE, gpu: async () => ({ start }) })`
and builds the scene, dynamically importing the engine and the WGSL inside
`start` so the eager path stays metadata-only. See `webgpu/shadertoys/seascape/`
for the minimal form and `interactive-fluid/` for a hand-written `GpuScene`.

The shell selects a background by id, so new backgrounds need no changes outside
this folder.

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
  `seascape` and `rainforest` are GPU-only and have no CPU fallback.
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

The five engine-backed backgrounds (`webgpu/shadertoys/…`) share
`webgpu/webgpu-render-engine/`:

- `startGpuBackground()` owns the lifecycle they used to repeat: device +
  surface creation, device-lost reporting through `ctx.onFatal`, error logging,
  the resize → deferred-redraw wiring, the frame loop (driven by the shared
  `ctx.fps`), reduced-motion settling, and an idempotent teardown.
- `fragmentScene()` builds the common "effect → offscreen target (single or
  ping-pong) → post pass" pipeline from a descriptor: targets, assets, extra
  samplers, pass order, and per-frame `bindings`. `matrix-rain`, `seascape`,
  `atmospheric-landscape` and `rainforest` are little more than that descriptor
  plus their `.wgsl`; the shaders and their uniform structs are untouched.
- `interactive-fluid` uses the same host but supplies a hand-written `GpuScene`,
  because it owns a fixed-step compute simulation.
- `time.ts` is one shared epoch for every GPU background (the Shadertoy `iTime`
  model): restarting a backend on a parameter change never snaps the animation
  back to `t = 0`. `size.ts` caps a render budget in megapixels.

`ambient-blob` (the CPU-fallback baseline) and `video` (CPU only) are not part
of the engine. Engine-backed backgrounds declare `engine: WEBGPU_ENGINE`, and
System Settings groups them under one **WebGPU** selector with a second selector
for the currently registered engine backgrounds. Backgrounds are still declared
with `registerBackground({ id, label, params, gpu })`; the engine is an
implementation detail behind each shadertoy's `start`.

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

`bg:check` resolves and compiles every background entry shader with `vgpu check`:

```sh
pnpm --dir frontend bg:check     # all background .wgsl entry shaders
```

The ambient blob shader is additionally validated against an independent JS
reference of the same additive radial-gradient math, without a browser:

```sh
pnpm --dir frontend bg:render           # blob: render offscreen, assert pixels, PNG
pnpm --dir frontend bg:render:matrix    # matrix: render offscreen against a synthetic atlas
```

Each writes a `scripts/*-preview.png` for visual inspection.
