# Backgrounds

Pluggable full-viewport backgrounds for the app shell. A background declares a
**CPU backend** and an optional **GPU backend**; the selector picks the GPU one
when WebGPU is available and transparently falls back to CPU.

```
components/background/
  index.ts                    # public API + registry barrel
  types.ts                    # BackgroundContext / Handle / Starter / Definition
  registry.ts                 # registerBackground() / getBackground() / listBackgrounds()
  select.ts                   # capability detection + gpu -> cpu fallback chain
  useBackground.ts            # React lifecycle hook (detection, reduced motion, remount)
  AmbientBackground.tsx       # the app-shell canvas + hook

  ambient-blob/               # shared, backend-agnostic definition (params, motion, colours)
  ambient-blob-cpu/           # canvas-2D backend (fallback)
  ambient-blob-gpu/           # WebGPU (vgpu) backend + .wgsl shaders
```

The two backends live in sibling `<name>-cpu` / `<name>-gpu` folders so their
dependencies stay separate: the vgpu/WGSL chunk is only fetched when the GPU
backend actually runs. Shared palette and motion math live in `<name>/` so the
backends cannot drift apart.

## Using a background

```tsx
import { AmbientBackground } from '../components/background'

<AmbientBackground />
```

`AmbientBackground` renders a full-viewport canvas and starts the `ambient-blob`
background. It sets `data-backend` (`gpu` / `cpu`) once a backend is running.

## Adding a background

1. Create `<name>/` with the shared params/types and a definition module that
   calls `registerBackground({ id, label, defaultParams, cpu, gpu })`, where
   `cpu`/`gpu` are dynamic imports of the backend folders.
2. Create `<name>-cpu/` and (optionally) `<name>-gpu/`, each exporting
   `start` with the `BackgroundStarter` signature.
3. Import the definition module from `index.ts` (side-effect import).

The shell imports `AmbientBackground` by id, so new backgrounds need no changes
outside this folder.

## Backends

- **CPU** — anything that can render to the canvas without WebGPU. The ambient
  blob CPU backend is canvas-2D, throttled to `ctx.fps`, paused while the tab is
  hidden or the window is blurred, and static under `prefers-reduced-motion`.
- **GPU** — vgpu/WebGPU. The ambient blob GPU backend initialises the device
  *before* touching the canvas, so an unsupported browser falls back cleanly. A
  device lost after the surface is attached calls `ctx.onFatal`, and the hook
  remounts a fresh canvas (a canvas context type is permanent) with the GPU path
  disabled.

## Debug override

Force a backend with either of:

- `?bg=gpu`, `?bg=cpu`, `?bg=auto` in the URL, or
- `localStorage.setItem('suwu.bg', 'cpu')`.

Query param wins over localStorage. Useful where WebGPU is unavailable.

## Testing

The ambient blob shader is validated headlessly (no browser) against an
independent JS reference of the same additive radial-gradient math:

```sh
pnpm --dir frontend bg:check     # resolve + validate the .wgsl import graph
pnpm --dir frontend bg:render    # render offscreen, assert pixels, write a PNG
```

`bg:render` writes `scripts/ambient-preview.png` for visual inspection.
