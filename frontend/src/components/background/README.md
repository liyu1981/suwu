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
  AmbientBackground.tsx       # the app-shell canvas + hook + param resolution

  ambient-blob/               # one background family
    index.ts                  # definition + registry entry (backend-agnostic)
    params.ts                 # palette + motion math (shared)
    types.ts                  # BlobSeed / RenderBlob / params types (shared)
    ambient-blob-cpu/         # canvas-2D backend (fallback)
    ambient-blob-gpu/         # WebGPU (vgpu) backend + .wgsl shaders

  interactive-fluid/          # another family (GPU only)
    index.ts                  # definition + registry entry
    interactive-fluid-gpu/    # vgpu fluid solver + .wgsl shaders
      renderer.ts             # rAF loop, fixed timestep, resize + reduced motion
      pointer-input.ts        # window-level pointer tracking ("stir")
      simulation.ts           # multi-pass compute solver (advect/curl/…/display)
      shaders/*.wgsl

  matrix-rain/                # another family (GPU only)
    index.ts                  # definition + registry entry
    matrix-rain-gpu/          # procedural "digital rain" effect
      renderer.ts             # vgpu storage upload + effect + frameLoop
      glyph-atlas.ts          # canvas-rasterised 1-bit glyph atlas
      shaders/*.wgsl

  atmospheric-landscape/      # another family (GPU only)
    index.ts                  # definition + params schema (animation speed)
    params.ts                 # typed params + resolveAtmosphericLandscapeParams()
    atmospheric-landscape-gpu/
      renderer.ts             # ping-pong accumulation + ray-march + tone pass
      noise-volume.ts         # deterministic 64³ RGBA8 value-noise volume
      shaders/*.wgsl

  seascape/                   # another family (GPU only)
    index.ts                  # definition + params schema (animation speed)
    params.ts                 # typed params + resolveSeascapeParams()
    seascape-gpu/
      renderer.ts             # capped ray-march target + blit + frameLoop
      shaders/*.wgsl

  rainforest/                 # another family (GPU only)
    index.ts                  # definition + params schema (animation speed)
    params.ts                 # typed params + resolveRainforestParams()
    rainforest-gpu/
      renderer.ts             # ping-pong reprojection (camera matrix in texels) + blit
      shaders/*.wgsl

  video/                      # another family (canvas-2D, WebCodecs)
    index.ts                  # definition + params schema (file, fit, speed, mask)
    params.ts                 # typed params + resolveVideoParams() + caps
    video-cpu/
      renderer.ts             # mediabunny playback loop, reduced motion, error overlay
      loop.ts                 # crossfade-loop timing (window + blend progress)
      storage.ts              # OPFS clip library (store/list/read/clear, thumbnails)
      fit.ts                  # cover source rect
```

Backends live in nested `<name>-cpu` / `<name>-gpu` folders so their
dependencies stay separate: the vgpu/WGSL chunk is only fetched when a GPU
backend actually runs. Shared code lives next to them in `<name>/` so backends
cannot drift apart.

## Using a background

```tsx
import { AmbientBackground } from '../components/background'

<AmbientBackground />                                   // ambient-blob (default)
<AmbientBackground background="interactive-fluid" />    // GPU only
```

`AmbientBackground` renders a full-viewport canvas and starts the selected
background. It sets `data-backend` (`gpu` / `cpu`) once a backend is running.

## Adding a background

1. Create `<name>/` with any shared params/types and a definition module that
   calls `registerBackground({ id, label, params, cpu, gpu })`. `cpu` and `gpu`
   are dynamic imports of the backend folders; both are optional (declare only
   the backends you have). `params` is optional — see below.
2. Create `<name>/<name>-cpu/` and/or `<name>/<name>-gpu/`, each exporting
   `start` with the `BackgroundStarter` signature. The resolved params bag is
   the second argument.
3. Import the definition module from `index.ts` (side-effect import).

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
  gpu: () => import('./seascape-gpu'),
})
```

- `defaultBackgroundParams(definition)` / `resolveBackgroundParams(definition,
  overrides)` (in `params.ts`) merge the declared defaults with the stored
  overrides, validating each against its schema — a stale or hand-edited
  localStorage entry can never reach a backend.
- `AmbientBackground` resolves the selected background's params and threads them
  through `useBackground` → `startBackground` → `starter(ctx, params)`.
- A params change restarts the backend (the params bag is part of the effect
  deps), because some values (e.g. a palette) can only be applied at setup.
  Sliders therefore commit on release rather than on every drag tick.
- Backends read typed values out of the bag in their own `<name>/params.ts`
  (e.g. `resolveSeascapeParams`) so the schema and the reader stay together.

The parameter schema is the single source of truth for defaults, UI and
validation; a backend never keeps its own copy.

## Backends

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

> **Licensing note.** `rainforest` is an Inigo Quilez (iq) work whose original
> license forbids use in a product, altered or not. It is included with express
> permission from the author. Treat that permission as a dependency of shipping
> the build, and keep it on file.

## Debug overrides

- Backend: `?bg=gpu`, `?bg=cpu`, `?bg=auto`, or
  `localStorage.setItem('suwu.bg', 'cpu')`.
- Background id: `?bg-id=interactive-fluid`, or
  `localStorage.setItem('suwu.bg-id', 'interactive-fluid')`.

Query params win over localStorage. Both are useful where WebGPU is
unavailable, or to preview a non-default background.

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
