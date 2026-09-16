# Ambient Background — WebGPU (vgpu) Plan

Status: **implemented** · Owner: frontend · Related:
`frontend/src/components/background/`

> Implementation notes (what shipped):
> - Subsystem at `frontend/src/components/background/` with a registry + fallback
>   selector, `ambient-blob/` (shared), `ambient-blob-cpu/`, `ambient-blob-gpu/`.
> - vgpu 0.5.0 + Vite WGSL loader wired (`vite.config.ts`, `src/wgsl-env.d.ts`);
>   the GPU backend is a lazy ~149 kB chunk, the CPU backend ~1.7 kB.
> - CPU fallback hardened: 30 fps cap, pause on hidden/blur, static under
>   reduced motion. Measured on the shell (1920×1080, dpr 2): ~99% -> ~49% of one
>   core at 30 fps, and 0% under reduced motion.
> - Shader validated headlessly (Mesa llvmpipe) via `pnpm --dir frontend bg:render`:
>   additive radial-gradient math matches an independent JS reference.
> - **Not yet verified in a real browser:** this dev box has no hardware WebGPU
>   (`webgpu = unavailable_software`), so the live GPU path needs a real-GPU
>   machine. The selector + fallback were verified in-browser (`data-backend="cpu"`).

## 1. Goal

Replace the CPU-bound canvas-2D ambient blob background with a **WebGPU renderer built
on [vgpu](https://vgpu.sh)** when the browser supports it, and keep the current
canvas-2D implementation as the **automatic fallback**. Reorganise background code into a
dedicated, extensible subsystem under `components/background/` so more backgrounds can be
added later without touching the shell.

### Why (measured, not assumed)

On the current shell page with **zero tiles open**, the ambient canvas alone costs:

| Condition | CPU |
|---|---|
| 1280×800, dpr 1 | ~13% of one core |
| 1920×1080, dpr 2 | **~95–99% of one core** (rAF drops to ~40/s) |
| `prefers-reduced-motion: reduce` | 0.0% (loop runs once) |

Profiling attributes it to canvas rasterization (`fill` / `createRadialGradient` /
`addColorStop` / `clearRect` / `arc`), not React. The dev box reports `2d_canvas =
unavailable_software` (`chrome://gpu`), i.e. the canvas is software-rasterized today. A
GPU fragment shader moves this work off the main thread and the CPU.

## 2. Non-goals / constraints

- **No visual regression.** The fallback must always render, and the WebGPU path should
  recreate the same look (same hues, palettes, motion constants).
- **Never pay for WebGPU when unavailable.** vgpu is loaded with a dynamic `import()` only
  after `navigator.gpu` + a successful adapter/device init.
- **Go-embed build stays intact.** Shaders are compiled to JS by the Vite WGSL loader, so
  no new runtime asset path is introduced in `pkg/assets`.
- **WebGPU needs a secure context** (HTTPS or `localhost`). Dev over a LAN IP on plain
  HTTP will fall back — expected and fine.
- **Fix the two known lifecycle gaps** while here: honour reduced-motion at runtime, and
  pause when the tab is hidden/backgrounded. The fallback canvas may also be throttled.

## 3. Dependencies & toolchain

```sh
pnpm --dir frontend add vgpu
```

- `vgpu` depends on `@vgpu/wgsl` (loaders) and `@vgpu/wgsl-std`; one install is enough.
- `frontend/vite.config.ts`: register the WGSL Vite loader:

  ```ts
  import { wgslVitePlugin } from '@vgpu/wgsl/loader-vite'
  // plugins: [ ..., wgslVitePlugin() ]
  ```

- `frontend/src/wgsl-env.d.ts` (new), for `.wgsl` imports:

  ```ts
  /// <reference types="@vgpu/wgsl/wgsl-types" />
  ```

- Record capability before coding: `pnpm --dir frontend exec vgpu doctor` (JSON verdict).
  Add a convenience script (`"bg:doctor": "vgpu doctor"`) if useful.

## 4. Folder structure

Location: **`frontend/src/components/background/`** (as requested).

Design rules:
- **One folder per renderer backend**: `<background>-cpu` and `<background>-gpu` are
  siblings, so the CPU and GPU implementations are fully separated and independently
  reviewable/testable.
- **A shared `<background>/` folder** holds the backend-agnostic definition (palette,
  motion math, types, defaults) so both backends are driven by identical numbers.
- **A registry + generic selector** at the subsystem root means new backgrounds are added
  by dropping a folder and registering a definition — the shell never changes.

```
frontend/src/components/background/
  README.md                     # subsystem overview + how to add a background
  index.ts                      # public barrel: AmbientBackground, startBackground, registry
  types.ts                      # BackgroundHandle, BackgroundContext, BackgroundDefinition,
                                #   BackgroundStarter, BackendKind
  registry.ts                   # registerBackground()/getBackground(); id -> definition
  select.ts                     # capability detection + gpu -> cpu fallback chain
  useBackground.ts              # React hook: mount, detection, reduced-motion, visibility, cleanup
  AmbientBackground.tsx         # thin React wrapper (<canvas> + useBackground)

  # ---- ambient blob (the first background) ----
  ambient-blob/                 # shared, backend-agnostic
    index.ts                    # BackgroundDefinition: id 'ambient-blob', default params
    params.ts                   # HUES, LIGHT/DARK, makeBlobs(), motion constants
    types.ts                    # Blob, Palette, AmbientBlobParams

  ambient-blob-cpu/             # CPU backend — current canvas-2D, moved + hardened
    index.ts                    # export startAmbientBlobCpu
    renderer.ts

  ambient-blob-gpu/             # GPU backend — vgpu / WebGPU
    index.ts                    # export startAmbientBlobGpu
    renderer.ts
    shaders/
      ambient.wgsl
      common.wgsl               # (optional) shared hash / color helpers
```

Future backgrounds follow the same shape, e.g.
`aurora/`, `aurora-cpu/`, `aurora-gpu/` — no changes to `AppShell.tsx`.

`AppShell.tsx` / `AuthGate.tsx` keep importing the component; the public API is stable:

```tsx
import { AmbientBackground } from '../components/background'
```

Rationale for splitting CPU/GPU folders: the two implementations have different
dependencies (canvas 2D vs vgpu + WGSL), different lifecycle failure modes, and different
test stories. Co-locating them in one file/folder drags vgpu into the fallback bundle and
makes parity review harder. Shared params live one level up so they cannot drift.

## 5. Interface design

```ts
// types.ts
export type BackendKind = 'gpu' | 'cpu'

export interface BackgroundContext {
  canvas: HTMLCanvasElement
  dpr: readonly [number, number]        // default [1, 2]
  fps: number                           // default 30
  reducedMotion: boolean
  /** Renderer asks the wrapper to remount the canvas (e.g. GPU device lost). */
  onFatal: (error: unknown) => void
}

export interface BackgroundHandle {
  readonly backend: BackendKind
  dispose(): void
  /** Optional: renderers that can pause/resume cheaply implement this. */
  setPaused?(paused: boolean): void
}

export type BackgroundStarter<P> = (
  ctx: BackgroundContext,
  params?: Partial<P>,
) => Promise<BackgroundHandle>

export interface BackgroundDefinition<P = unknown> {
  id: string
  label: string
  defaultParams?: Partial<P>
  cpu: () => Promise<{ start: BackgroundStarter<P> }>   // dynamic import
  gpu?: () => Promise<{ start: BackgroundStarter<P> }>  // dynamic import
}
```

`registry.ts` holds definitions; `ambient-blob/index.ts` self-registers (side-effect import
from `background/index.ts`). `select.ts` picks a backend:

```ts
// select.ts (sketch)
export async function startBackground<P>(
  def: BackgroundDefinition<P>,
  ctx: BackgroundContext,
  opts: { force?: BackendKind | 'auto' },
): Promise<BackgroundHandle> {
  const force = opts.force ?? readDebugOverride() ?? 'auto'
  if (force !== 'cpu' && def.gpu && navigator.gpu) {
    try {
      const gpu = await def.gpu()           // dynamic import
      // Device init happens before any surface touches ctx.canvas.
      return await gpu.start(ctx, def.defaultParams)
    } catch (err) {
      console.warn('[background] gpu backend failed, falling back to cpu', err)
    }
  }
  const cpu = await def.cpu()
  return cpu.start(ctx, def.defaultParams)
}
```

### Debug override

`?bg=gpu|cpu|auto` (query param wins) and/or `localStorage['suwu.bg']`. Essential here:
the dev box has no hardware WebGPU, so `?bg=cpu` exercises the fallback and `?bg=gpu`
exercises (and visibly fails/falls back) the GPU path.

### Canvas context is permanent — design for it

A `<canvas>` can only ever return one context type: once `getContext('webgpu')` succeeds,
`getContext('2d')` returns `null`. Therefore:

- The GPU backend **initialises the device before creating a surface on the visible
  canvas**. If `init()` throws (`VGPU-RING1-UNSUPPORTED` when WebGPU is unavailable), the
  canvas is untouched and the CPU backend starts normally.
- If the device is **lost later**, the renderer cannot fall back on the same element. It
  calls `ctx.onFatal`, and `AmbientBackground.tsx` bumps a React `key` to remount a fresh
  `<canvas>`, then starts the CPU backend.

## 6. Recreating the blobs in WGSL

Shared `ambient-blob/params.ts` is the single source of truth for both backends:

- `HUES = [200, 260, 320, 170, 30, 355]`, jittered ±12; `LIGHT`/`DARK` palettes; 12 blobs.
- Per blob: base position `(rx, ry)`, radius `0.07–0.25 × min(w,h)`, hue, sat, light, alpha,
  velocity, sine amplitude/frequency/phase.

Per-frame motion (identical equations in both backends):

```
x = wrap(rx*w + ampX*sin(t*freq + phase) + vx*t, -200, w+200)
y = wrap(ry*h + ampY*cos(t*freq*0.8 + phase*1.3) + vy*t, -200, h+200)
r = radius*min(w,h) * (1 + 0.08*sin(t*0.3 + phase))
hue = (blob.hue + t*1.2) % 360
```

Two implementation options:

1. **CPU drives motion, GPU draws.** JS computes 12 blob records per frame and uploads one
   small uniform array; the fragment shader loops over them. Simplest way to guarantee
   parity. Payload ≈ 12 × 32 B, negligible.
2. **GPU-only.** Pass the 12 seeds once and compute motion inside WGSL from `time`. Zero
   per-frame CPU, but wrap/sin math must be reimplemented and validated.

Recommendation: **option 1 first** (parity), optimise to option 2 only if profiling says so.

Shader sketch (`ambient-blob-gpu/shaders/ambient.wgsl`):

```wgsl
struct Blob { center: vec2f, radius: f32, hue: f32, sat: f32, light: f32, alpha: f32, _pad: vec2f }
struct Params { resolution: vec2f, time: f32, count: u32, blobs: array<Blob, 12> }
@group(0) @binding(0) var<uniform> params: Params;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * params.resolution;
  var acc = vec3f(0.0);
  for (var i = 0u; i < params.count; i++) {
    let b = params.blobs[i];
    let d = distance(p, b.center);
    // 3-stop radial gradient: solid to 0.6, linear to 0 at radius
    let f = clamp((b.radius - d) / (b.radius * 0.4), 0.0, 1.0);
    acc += hsl2rgb(b.hue, b.sat, b.light) * (b.alpha * f);
  }
  // additive composite ('lighter'), then premultiplied alpha for the canvas surface
  return vec4f(acc, 1.0);
}
```

Notes:
- WGSL uniform layout rules apply (16-byte struct alignment) — pad `Blob` explicitly; bind
  by reflected WGSL names.
- `surface(gpu, canvas, { dpr: [1, 2], alphaMode: 'premultiplied' })` (default is
  `premultiplied`); output premultiplied alpha so the CSS `.ambient-bg` gradients still show
  through, or paint the base colour in-shader and go opaque.
- `effect(gpu, source)` created once; `.set()` only per-frame values; `frameLoop(gpu, cb,
  { fps })`.

## 7. Lifecycle & performance guardrails

- **Reduced motion:** if `matchMedia('(prefers-reduced-motion: reduce)')` matches, render a
  single `frame()` and never start the loop; subscribe to the media query to stop/start if
  the OS setting changes. Applied in `useBackground` and passed to both backends.
- **Visibility:** stop the loop on `document.hidden`/`blur`, resume on `visible`/`focus`.
  Verify whether vgpu's `frameLoop` already releases work while hidden and rely on it if so.
- **DPR cap:** `dpr: [1, 2]` (or lower for the canvas fallback).
- **fps cap:** default 30 for a decorative background.
- **Device loss:** GPU backend reports via `ctx.onFatal` → wrapper remounts canvas → CPU.
- **Cleanup:** `dispose()` the `FrameLoopHandle`, `surface`, and `Gpu` in the hook teardown;
  guard against double-start (React StrictMode double-invoke in dev) and `VGPU-SURFACE-DUPLICATE`.
- **Fallback hardening (approved):** throttle the canvas-2D loop to the same fps cap, skip
  frames when idle, pause when hidden, and avoid rebuilding gradients every frame where
  cheap. This is a deliberate behaviour change accepted in Phase 1.

## 8. Phases

- **Phase 0 — toolchain.** Install `vgpu`, add `wgslVitePlugin()` + `wgsl-env.d.ts`, run
  `vgpu doctor`, record the result in this doc.
- **Phase 1 — subsystem skeleton + CPU extraction.** Create `components/background/`
  (`types`, `registry`, `select`, `useBackground`, `AmbientBackground`), move the existing
  canvas code to `ambient-blob-cpu/`, extract shared `ambient-blob/params.ts`. Apply the
  approved fallback hardening. Re-point `AppShell`/`AuthGate`. No GPU code yet.
- **Phase 2 — GPU backend.** Add `ambient-blob-gpu/` (renderer + `.wgsl`) behind
  `?bg=gpu` only; iterate on visual parity with pixel readback.
- **Phase 3 — selection + default.** Wire `select.ts`, make `auto` the default, handle
  device loss / canvas remount.
- **Phase 4 — hardening.** Reduced-motion observer, visibility pause, fps/dpr caps,
  StrictMode safety, cleanup.
- **Phase 5 — validation & docs.** Static render test, browser perf measurement, subsystem
  `README.md`, delete the old `components/AmbientBackground.tsx` once fully migrated.

## 9. Validation

- **Static pixels (no browser):** `frontend/scripts/render-ambient.mjs` uses `vgpu/node`
  (`pngjs`) to render the shader offscreen at fixed `time`, write `ambient.png`, and assert
  sample pixels. Gated on `vgpu doctor` being healthy.
- **Parity:** render `ambient-blob-cpu` and `ambient-blob-gpu` at the same `t` and diff
  (perceptual or per-pixel tolerance) — at minimum eyeball side by side.
- **Browser perf:** reuse the CDP harness (headless Chromium) to measure
  `Performance.getMetrics().TaskDuration` on the shell with `?bg=gpu` vs `?bg=cpu`. Target:
  main-thread CPU near 0% on the GPU path, and no pinned core with the fallback.
- **Gates:** `pnpm --dir frontend typecheck`, `pnpm --dir frontend check`.

## 10. Risks & open questions

| Risk | Mitigation |
|---|---|
| WebGPU unavailable in the target env (this dev box: `webgpu = unavailable_software`) | Fallback is the default; `?bg=` override; test GPU on a real-GPU machine |
| Secure-context requirement (LAN HTTP dev) | Detect and fall back; document |
| Canvas context type is permanent | Init device before attaching a surface; remount canvas via `onFatal` |
| Alpha / `premultiplied` compositing over `.ambient-bg` | Match alpha mode; validate pixels over the CSS gradient |
| Visual drift between backends | Shared `ambient-blob/params.ts`, CPU-driven uniforms, parity diff |
| Bundle size | Dynamic `import('vgpu')` per backend; WGSL loader emits JS |
| React StrictMode double-mount / duplicate surfaces | Idempotent start + `VGPU-SURFACE-DUPLICATE` handling |
| CSP | Shader source is JS/inline string; no new fetch. Verify against the server CSP header |

## 11. Resolved decisions

1. **Location** — `frontend/src/components/background/` (inside `components/`).
2. **Shader delivery** — `.wgsl` files + the Vite WGSL loader (`@vgpu/wgsl/loader-vite`).
3. **Fallback cost** — may be fixed: throttle, pause on hidden, cap fps/dpr.
4. **Subsystem** — yes; a registry-based design so multiple backgrounds and their
   `<name>-cpu` / `<name>-gpu` backends can be added without touching the shell.
