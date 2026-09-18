# WebGPU Render Engine — Plan

Status: **implemented** · Owner: frontend · Family: `frontend/src/components/background/webgpu/`

> **Reorganized** after implementation: the engine and the backgrounds built on
> it now live together under `background/webgpu/` — the engine at
> `webgpu/webgpu-render-engine/`, each background at
> `webgpu/shadertoys/<name>/` as a single `setup.ts` plus its `shaders/`. The
> paths in this document below reflect the original layout; the design is
> unchanged.

> Implementation notes (what shipped):
> - `webgpu-render-engine/` with `host.ts`, `scene.ts` (`GpuScene` +
>   `startGpuBackground`), `fragment.ts` (`fragmentScene`), `assets.ts`,
>   `time.ts`, `size.ts`, `index.ts`.
> - `matrix-rain`, `seascape`, `atmospheric-landscape` and `rainforest` are now
>   `fragmentScene` descriptors; `renderer.ts` dropped from ~125–194 lines to
>   ~60–95 (mostly comments and shader bindings). Shaders are untouched.
> - `interactive-fluid` uses the host with a hand-written `GpuScene`; the
>   engine owns the loop and the scene turns each tick into 0–2 fixed steps.
> - One shared epoch (`time.ts`): matrix-rain's animation no longer resets on a
>   parameter change. One shared `ctx.fps` (default 30) drives every background.
> - Device-lost now reports through `ctx.onFatal` for all five (previously only
>   `ambient-blob`).
> - Verified: `typecheck`, `biome`, `bg:check` (17 shaders), `bg:render`,
>   `bg:render:matrix`, `pnpm build`. The engine ships as one shared chunk
>   (`webgpu-render-engine-*.js`, ~8 kB).
> - System Settings groups the engine backgrounds under a single **WebGPU**
>   selector (with a second selector for the registered backgrounds); the
>   `?bg-id` / `suwu.bg-id` debug override was removed — the background is chosen
>   in Settings.
> - **Not yet verified in a real browser** (no hardware WebGPU on the dev box):
>   live visuals for the five backgrounds still want an observer pass.

Related:
[`AMBIENT_BACKGROUND_PLAN.md`](./AMBIENT_BACKGROUND_PLAN.md),
[`MATRIX_RAIN_BACKGROUND_PLAN.md`](./MATRIX_RAIN_BACKGROUND_PLAN.md),
[`frontend/src/components/background/README.md`](../frontend/src/components/background/README.md)

## 1. Goal

The five GPU-only backgrounds — `matrix-rain`, `interactive-fluid`, `seascape`,
`atmospheric-landscape`, `rainforest` — are structurally the same renderer copied five times.
Each `*-gpu/renderer.ts` re-implements device init, surface creation, resize handling,
reduced-motion settling, the frame loop, and an idempotent teardown, then differs only in its
shader set, its offscreen target(s), and its per-frame uniforms.

Unify them into one engine, `webgpu-render-engine`, so that:

1. the lifecycle plumbing exists **once**;
2. a background is declared as **a set of WGSL entry shaders plus assets, targets and
   uniform bindings** — i.e. "switch the WGSL files", not "write another renderer";
3. the public subsystem (`BackgroundDefinition` / `BackgroundStarter` / `BackgroundContext`,
   the registry, params, System Settings, every `.wgsl` file) is **unchanged**.

Non-goal: the two non-members. `ambient-blob` (which has a CPU fallback and is the baseline
image) is **left alone**; `video` is CPU-only.

## 2. Current state

### 2.1 Boilerplate copied 5–6×

Every GPU renderer repeats:

1. `const gpu = await init({ powerPreference: 'low-power' })`
2. `surface(gpu, ctx.canvas, { dpr, clearColor, label })`
3. a `disposed` flag + `loop` + `unsubscribeResize` + `pendingRedraw`
4. an idempotent `teardown()` (cancel rAF, stop loop, unsubscribe, `gpu.dispose()`)
5. `surface.onResize` → resize targets + update the `resolution` uniform + a **deferred redraw
   under reduced motion** (because `frame()` must not run inside the resize callback)
6. `ctx.reducedMotion ? settle() : frameLoop(gpu, encode, { fps })`
7. `return { backend: 'gpu', dispose: teardown }`

Duplicated pure helpers:

| helper | copies | notes |
|---|---|---|
| `internalSize(w, h, budget)` | 3 | seascape 1.3 MP, atmospheric 0.3 MP, rainforest detail preset |
| `TIME_EPOCH` + `elapsed()` | 3 | seascape, atmospheric, rainforest |
| `resizeTargets(pingPong, size)` | 2 | atmospheric, rainforest |
| `teardown` block | 5 | near-identical |
| "settle N frames, then show one" | 4 | `SETTLE_FRAMES` 12 / 16 / 180 / 1 |

### 2.2 What legitimately differs

| concern | matrix | fluid | seascape | atmospheric | rainforest |
|---|---|---|---|---|---|
| offscreen target | single, canvas-size | fixed 128×72 grid | single, 1.3 MP | ping-pong | ping-pong |
| post pass | CRT | display | blit | tone | vignette |
| asset | glyph `storage` | — | — | 64³ `texture3d` | — |
| render budget | none | fixed grid | const 1.3 MP | const 0.3 MP | user `detail` |
| time source | `clock(gpu)` | step counter | epoch | epoch | epoch |
| driver | `frameLoop` | own rAF, fixed step, visibility | `frameLoop` | `frameLoop` | `frameLoop` |

### 2.3 Latent gaps found (fixed by centralising)

- **Only `ambient-blob-gpu` handles device loss** (`gpu.gpu.lost → ctx.onFatal`). The other five
  never call `ctx.onFatal`, so a lost device leaves a dead canvas. The engine centralises this.
- **Two time conventions collide.** `clock(gpu).time` resets per device (matrix); the module
  epoch deliberately survives restarts (seascape/atmospheric/rainforest). See §4.
- **Matrix's target is uncapped** full-canvas, unlike the raymarchers. Kept as-is (it is cheap),
  but now an explicit, declared budget.

## 3. Design

### 3.1 Two layers

A single engine that also swallows the fluid solver would over-abstract. Split into a **host
layer** (everyone) and a **declarative fragment layer** (the four fragment backgrounds).

- **Host** owns: `init()`, the surface, `gpu.gpu.lost → ctx.onFatal`, `gpu.onError`, resize →
  deferred-redraw wiring, the frame loop, reduced-motion settling, teardown.
- **Fragment pipeline** is the declarative part: targets (single/ping-pong), assets,
  samplers, pass list, per-frame `bindings`, and the render-resolution **budget**.
- **Fluid** uses the host + a scene that implements `render()` imperatively (it owns its
  simulation stepping — see §4.3).

### 3.2 Folder layout

Grouped under **`webgpu/`** so the engine and the backgrounds built on it sit
together:

```
frontend/src/components/background/
  webgpu/
    index.ts             # registers every shadertoy (side-effect imports)
    webgpu-render-engine/
      index.ts           # re-exports
      host.ts            # openGpuHost(): init, surface, device-lost/onError, teardown
      time.ts            # one shared epoch + elapsed()
      size.ts            # cappedSize(w, h, megapixels)
      scene.ts           # GpuScene interface + startGpuBackground()
      fragment.ts        # fragmentScene(spec): declarative pass pipeline
      assets.ts          # storage / texture3d asset builders
    shadertoys/
      <name>/            # one file per background
        setup.ts         # params + definition + scene
        shaders/*.wgsl
```

Each shadertoy's `setup.ts` merges what used to be `index.ts` + `params.ts` +
`<name>-gpu/renderer.ts` (+ helper modules). It registers metadata eagerly and
dynamically imports the engine and the WGSL inside `start`, so the lazy chunking
is preserved. See §5.

### 3.3 Interfaces

Shaped after vgpu's own `TierResources` pattern (see the bundled `adaptive-quality` guide).

```ts
// webgpu-render-engine/scene.ts
export interface GpuScene {
  /** Re-size the scene's internal targets. Called at start and on every surface resize. */
  resize(size: readonly [number, number]): void
  /** Encode one frame into the current vgpu Frame. */
  render(current: Frame, time: number): void
  /** Pre-compile every pass for the surface, so the first frame does not hitch. */
  prepare?(): Promise<void>
  /** Reduced motion: run N frames to settle, then show one still. */
  settle?(): void
  destroy(): void
}

export interface GpuSceneInit {
  gpu: Gpu
  surface: Surface
  size: readonly [number, number]
  params: Record<string, unknown>
  ctx: BackgroundContext
}

export type GpuSceneFactory = (init: GpuSceneInit) => GpuScene | Promise<GpuScene>

export function startGpuBackground(
  label: string,
  createScene: GpuSceneFactory,
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle>
```

`startGpuBackground` is the seven boilerplate steps, once. Every `*-gpu/index.ts` keeps its
current `export { startX as start }` shape.

### 3.4 Declarative fragment pipeline

```ts
// webgpu-render-engine/fragment.ts
export interface FragmentSceneSpec {
  label: string
  targets?: Record<string, {
    kind?: 'single' | 'pingPong'
    format?: GPUTextureFormat
    clearColor?: ClearColor
    /** Render-resolution budget in megapixels; Infinity = the canvas backing store. */
    budget?: number | ((params: Record<string, unknown>) => number)
  }>
  assets?: Record<string, AssetSpec>
  reducedMotionSettle?: number
  passes: readonly {
    shader: ShaderSource
    target: 'canvas' | string
    /** Per-frame bindings: uniforms, textures, samplers, storage. */
    bindings?: (state: FragmentFrameState) => SetBag
  }[]
}

export function fragmentScene(spec: FragmentSceneSpec): GpuSceneFactory
```

`FragmentFrameState` supplies `{ size, time, frame, targets, assets, sampler, params }`. The
builder creates targets/samplers/assets once, calls each pass's `bindings` per frame, swaps any
ping-pong target after the frame, and resizes everything on `resize`.

**Guardrail (decided):** the descriptor encodes only what ≥3 backgrounds share — targets,
ping-pong, budget, reduced-motion settle, assets. Anything background-specific stays inside the
`bindings` callback.

### 3.5 Assets

```ts
type AssetSpec =
  | { kind: 'storage';  build: () => Promise<ArrayBufferView> }
  | { kind: 'texture3d'; size: number; format: GPUTextureFormat; build: () => Uint8Array }
```

Covers the matrix glyph atlas (`storage`) and the atmospheric noise volume (`texture3d`). The
existing builders (`glyph-atlas.ts`, `noise-volume.ts`) are unchanged.

## 4. Shadertoy parity: clock, fps, and stepping

Two adjacent questions, resolved separately — the way Shadertoy resolves them.

- **Clock** — where the shader's `time` comes from.
- **Stepping** — how many simulation steps one presented frame represents.

### 4.1 What Shadertoy does

Shadertoy exposes `iTime` (shader playback time, seconds), `iTimeDelta`, `iFrame`,
`iFrameRate`, `iDate`, `iChannelTime`…

- **`iTime` is a single monotonic playback clock for the shader, not for the GPU context.**
  Editing the code recompiles the pipeline and **playback continues from the same `iTime`** —
  the animation does not snap back to 0. It resets only when the *playback* restarts (the ⟲
  reset button, a page reload).
- **Shadertoy does not impose a fixed timestep.** Multi-pass stateful shaders (fluids,
  reaction-diffusion) ping-pong **once per rendered frame**; the author chooses, and `iTimeDelta`
  / `iFrame` are exposed for those who integrate a delta. Many authors hardcode `dt = 1/60`.

So: one long-lived presentation clock that outlives resource rebuilds, plus per-shader control
of the simulation step.

### 4.2 Clock — one shared epoch (Shadertoy `iTime` parity)

Our canvas-remount architecture makes this the exact analogue of a Shadertoy recompile: a
params change tears down the renderer and starts a **new GPU device**.

```ts
// webgpu-render-engine/time.ts
const EPOCH = typeof performance !== 'undefined' ? performance.now() : 0
export const elapsedSeconds = (): number => (performance.now() - EPOCH) / 1000
```

- `seascape`, `atmospheric-landscape`, `rainforest`: **no behavior change** — same semantics,
  now one shared copy instead of three.
- `matrix-rain`: moves off `clock(gpu)` (which resets per device). One observable change: a
  slider drag no longer restarts the rain phase. This is the Shadertoy behaviour (`iTime`
  survives a recompile) and the intended one.
- `interactive-fluid`: unaffected — its simulation time is its own step counter (§4.3).

`EPOCH` is page-load time, so `elapsed` stays small (hours ≈ 10⁴ s) and f32 handles it; the
atmospheric shader already wraps its frame index mod 1024 for the same reason.

> `vgpu`'s `clock(gpu)` is correct for its own `adaptive-quality` example because that swap
> reuses the same `gpu`. Our reset is specific to the canvas remount, not to vgpu.

### 4.3 fps — one user-set variable, shared by every background

**Decision:** `fps` is a first-class variable of `webgpu-render-engine`, set by the user
(default **30**, the current `useBackground` value) and shared by every background. The engine's
presentation driver runs each background's `render()` at that rate; the per-call hardcoded
`fps` in the individual renderers disappears.

- `BackgroundContext.fps` remains in the public type; the engine is now its single source, read
  from one shared config/setting.
- A background may *declare* a preferred `fps` in its scene descriptor, but the user-set engine
  value is the shared default and wins.
- This removes the `driver: 'self'` special case for the fluid: the engine owns the loop for
  **all** backgrounds.

### 4.4 Stepping — simulation stays per-scene

Following Shadertoy (one buffer step per presented frame, author-controlled integration):

- The four fragment backgrounds are pure functions of `time`; one `render()` per tick, no state.
- `interactive-fluid` keeps its **fixed-step accumulator inside `render()`**. The engine owns
  the rAF/frame loop at `fps`; the fluid turns each tick's elapsed time into 0–2 steps of
  `1/60` (its existing `fixedStepCount` logic), which preserves solver stability at any
  `fps`. Its `render()` no longer starts its own rAF and no longer calls `frame()` itself.

Net: **one loop, one clock, one fps** at the engine; **one stepping policy per stateful scene**.

## 5. Per-background mapping

### 5.1 seascape — ~125 lines → ~30

```ts
export const start = (ctx, params) =>
  startGpuBackground('seascape', fragmentScene({
    label: 'seascape',
    budget: 1.3,
    targets: { scene: { format: 'rgba16float' } },
    reducedMotionSettle: 1,
    passes: [
      { shader: seascapeShader, target: 'scene',
        bindings: ({ size, time }) => ({ params: { resolution: size, time: time * speed * SEASCAPE_SPEED_BASE } }) },
      { shader: blitShader, target: 'canvas',
        bindings: ({ targets, sampler }) => ({ src: targets.scene, samp: sampler }) },
    ],
  }), ctx, params)
```

### 5.2 atmospheric-landscape — ping-pong + 3D asset

```ts
fragmentScene({
  label: 'atmospheric-landscape',
  budget: 0.3,
  reducedMotionSettle: 12,
  assets: { noise: { kind: 'texture3d', size: 64, format: 'rgba8unorm', build: buildNoiseVolume } },
  targets: { accum: { kind: 'pingPong', format: 'rgba16float' } },
  passes: [
    { shader: sceneShader, target: 'accum.write',
      bindings: ({ size, time, frame, accum, assets }) => ({
        params: { resolution: size, time: time * TIME_SCALE * speed, frame, blend: BLEND, _pad: 0 },
        prev_frame: accum.read,
        prev_sampler: sceneSampler,
        noise_volume: assets.noise,
        noise_sampler: noiseSampler,
      }) },
    { shader: displayShader, target: 'canvas',
      bindings: ({ accum, sampler }) => ({ src: accum.write, samp: sampler }) },
  ],
})
```

### 5.3 rainforest — same as atmospheric

Identical shape; only the post shader differs and the budget is
`params.detail → RAINFOREST_DETAIL_BUDGETS[detail]`. **The Inigo Quilez attribution headers in
the shader and the renderer must be preserved verbatim** (see the licensing note in the
background README).

### 5.4 matrix-rain

`fragmentScene` with `targets: { scene: { format: 'rgba8unorm', budget: Infinity } }`,
`assets: { glyphs: { kind: 'storage', build: buildGlyphAtlas } }`, and the two passes
(`matrixShader` → scene with the glyph storage + `cell` params; `crtShader` → canvas). Its
`time` comes from the shared epoch (§4.2).

### 5.5 interactive-fluid — host + imperative scene

```ts
startGpuBackground('interactive-fluid', (init) => ({
  prepare: async () => { fluid = createFluid(init.gpu); await prepareFluid(fluid, init.surface) },
  resize:  () => resizeFluid(fluid, init.surface),
  // Engine-driven tick: turns elapsed time into 0–2 fixed steps, then presents.
  render:  (frame, time) => { stepTick(fluid, time); renderFluidInto(fluid, init.surface, frame) },
  destroy: () => input?.dispose(),
}), ctx, params)
```

The compute solver (`simulation.ts`) and `pointer-input.ts` are unchanged; only loop ownership
moves to the engine.

## 6. What "switching the WGSL files" means

Each background keeps its own `shaders/` folder. The engine is parameterised by `ShaderSource`
references and asset builders. Switching a background = referencing different shader modules
plus a different pass list / budget / asset set.

**We do not introduce a shared uniform struct.** The ported Shadertoy shaders each declare their
own `Params` struct; rewriting them to a superset is churn with real pixel-regression risk and no
runtime benefit. The descriptor's `bindings` callback maps JS values onto whatever struct the
shader declares — exactly what `effect.set()` already does. Binding/JS mismatch is caught by
`bg:check` (shader compile) plus the observer review (§8).

## 7. Migration phases

Each phase is independently shippable and verifiable.

1. **Land the engine with zero customers.** `host.ts`, `time.ts`, `size.ts`, `scene.ts`,
   `fragment.ts`, `assets.ts`. No renderer changes. `bg:check` / `bg:render` /
   `bg:render:matrix` stay green.
2. **seascape** → declarative (simplest shape: single target + blit). First real customer.
3. **matrix-rain** → declarative (validates storage assets + the epoch change).
4. **atmospheric-landscape** → declarative (validates ping-pong + texture3d + settle count 12).
5. **rainforest** → declarative (validates dynamic budget + ping-pong; preserve licence header).
6. **interactive-fluid** → host + imperative scene (validates the engine-driven fixed-step tick).
7. Delete the now-dead duplicated helpers; update `background/README.md` (per-renderer
   descriptions + a `webgpu-render-engine/` section).

`ambient-blob` and `video` are untouched in every phase.

## 8. Validation

No golden-image harnesses (decided). The refactor is mechanical and the shaders are unchanged, so
verification is:

- **Automated build gates:** `pnpm --dir frontend typecheck`, `pnpm --dir frontend check`.
- **Shader compile:** `pnpm --dir frontend bg:check` — still compiles every entry `.wgsl`.
- **Existing headless pixel tests:** `bg:render` (ambient) and `bg:render:matrix` (matrix) keep
  covering their backgrounds; expect them to pass unchanged after phases 3.
- **Observer testing (per background):** with the user, select each of the five engine
  backgrounds in System Settings (**WebGPU** group) and check: normal motion,
  `prefers-reduced-motion` (still frame), a params change (speed / detail) restarting the
  backend **without** an animation snap (the §4.2 epoch), and a resize. Fluid additionally:
  pointer "stir" and tab-hide/resume.
- **Debug override:** `?bg=gpu|cpu|auto` (backend only; the background is chosen in Settings).

The one behaviour change to specifically watch is the clock: matrix-rain (and, if it ever adopts
the engine, ambient-blob) no longer reset their animation when a param changes.

## 9. Risks & open questions

| risk | mitigation |
|---|---|
| Over-abstraction (descriptor becomes a mini-framework) | Encode only what ≥3 backgrounds share; keep specifics in `bindings` (§3.4) |
| Fluid does not fit the declarative pipeline | Host + imperative `render()`; solver untouched |
| JS binding ↔ WGSL struct mismatch (no type check) | `bg:check` + observer review per background |
| Time semantics change (matrix) | Deliberate (Shadertoy parity); called out in §4.2 and §8 |
| f32 time precision | `EPOCH` is page-load time, so `elapsed` stays small |
| Per-frame allocations in the engine | `bindings` results are consumed immediately; no per-frame target/sampler churn |
| Bundle shape | vgpu is already a shared lazy chunk; a shared engine chunk matches that profile |
| Rainforest licence | Preserve attribution headers verbatim |
| `fps` plumbing | Engine reads one shared, user-set value; `BackgroundContext.fps` stays the contract |

Out of scope (decided): adaptive quality (GPU-tier / battery / FPS downgrade), fixed-timestep
engine mode, golden-image tests, and any change to `ambient-blob` or `video`.

## 10. Resolved decisions

1. **Fluid** — engine-driven loop; its fixed-step accumulator stays inside `render()`. No
   `driver: 'self'` escape hatch.
2. **Clock** — one shared module-level epoch (Shadertoy `iTime` parity); matrix moves off
   `clock(gpu)`.
3. **fps** — one user-set variable of `webgpu-render-engine` (default 30), shared by every
   background; backgrounds may declare a preferred value, user setting wins.
4. **Stepping** — per-scene; the four fragment backgrounds are stateless, fluid integrates its
   own fixed steps.
5. **Descriptor scope** — only cross-background concerns; specifics stay in `bindings`.
6. **Adaptive quality** — out of scope.
7. **Name** — `webgpu-render-engine`.
8. **`ambient-blob`** — untouched; it is the baseline.
9. **Validation** — no golden images; `bg:check` + existing render tests + observer review with
   the user.
