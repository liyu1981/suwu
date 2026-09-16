# Backgrounds

Pluggable full-viewport backgrounds for the app shell. A background declares a
**CPU backend**, a **GPU backend**, or both; the selector picks the GPU one when
WebGPU is available and falls back to CPU when there is one. A GPU-only
background simply renders nothing on a browser without WebGPU.

```
components/background/
  index.ts                    # public API + registry barrel
  types.ts                    # BackgroundContext / Handle / Starter / Definition
  registry.ts                 # registerBackground() / getBackground() / listBackgrounds()
  select.ts                   # capability detection + gpu -> cpu fallback chain
  useBackground.ts            # React lifecycle hook (detection, reduced motion, remount)
  AmbientBackground.tsx       # the app-shell canvas + hook

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
   calls `registerBackground({ id, label, defaultParams, cpu, gpu })`. `cpu` and
   `gpu` are dynamic imports of the backend folders; both are optional (declare
   only the backends you have).
2. Create `<name>/<name>-cpu/` and/or `<name>/<name>-gpu/`, each exporting
   `start` with the `BackgroundStarter` signature.
3. Import the definition module from `index.ts` (side-effect import).

The shell selects a background by id, so new backgrounds need no changes outside
this folder.

## Backends

- **CPU** — anything that can render to the canvas without WebGPU. The ambient
  blob CPU backend is canvas-2D, throttled to `ctx.fps`, paused while the tab is
  hidden or the window is blurred, and static under `prefers-reduced-motion`.
- **GPU** — vgpu/WebGPU. The ambient blob GPU backend initialises the device
  *before* touching the canvas, so an unsupported browser falls back cleanly. A
  device lost after the surface is attached calls `ctx.onFatal`, and the hook
  remounts a fresh canvas (a canvas context type is permanent) with the GPU path
  disabled. `interactive-fluid` is GPU-only and has no CPU fallback.

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
pnpm --dir frontend bg:render    # render offscreen, assert pixels, write a PNG
```

`bg:render` writes `scripts/ambient-preview.png` for visual inspection.
