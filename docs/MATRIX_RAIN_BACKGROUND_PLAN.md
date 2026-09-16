# Matrix Rain — WebGPU Background Plan

Status: **implemented** · Owner: frontend · Family: `components/background/matrix-rain/`

> Implemented as decided: ASCII + half-width katakana, canvas-rasterised glyph
> atlas uploaded through vgpu `storage().write()` (no texture upload exists in
> vgpu 0.5.0), `@vgpu/wgsl-std/hash` for randomness, procedural single-pass
> fragment effect, GPU-only. `bg:check` validates `matrix.wgsl`; the headless
> `bg:render:matrix` pixel test passes against a synthetic checkerboard atlas.
> Live visual tuning (speed/trail/colors) still wants a real-GPU browser check.

## 1. Goal

A new **GPU-only** background that reproduces the Matrix "digital rain": a black
field with columns of green characters falling, a bright head glyph, and a
fading trail. It plugs into the existing background subsystem (registry +
System Settings), so no shell changes are needed.

Like `interactive-fluid`, it is GPU-only (WebGPU). On a browser without WebGPU
it renders nothing and is shown as "· WebGPU" in System Settings.

## 2. vgpu-native constraints (researched)

- vgpu 0.5.0 has **no image/texture upload API** — `Texture` exposes only
  `read`/`readFloats`/`createView`; the only documented upload is
  `Queue.writeBuffer` for buffers.
- vgpu's main API **`storage(gpu, bytes, access)` returns a `RingStorageBuffer`
  with `.write(data, offset?)`** — this is the native host→GPU upload path. Use
  it for the glyph data.
- `@vgpu/wgsl-std/hash` provides `hashU32`, `pcg2d`, `pcg3d`, `unitFloat`,
  `hash1/2/3` — reuse for per-column and per-glyph randomness.
- Read-only storage buffers are visible to the fragment stage (vgpu's default
  storage visibility is fragment + compute), so a single fullscreen `effect`
  can read the glyph atlas directly.

Conclusion: keep the glyph data in a small **read-only `storage` buffer** and
read one glyph bit per fragment. No texture, no sampler, no compute pass, no raw
`device.queue` calls — all through vgpu.

## 3. Approach — procedural, stateless

One fullscreen fragment `effect` computes the rain per pixel from
`clock(gpu).time` + hashes. No per-frame CPU work, no state buffers.

```
col   = floor(px.x / cell.x)
row   = floor(px.y / cell.y)
speed = mix(speedMin, speedMax, hash1(col))          // rows / second
phase = hash1(col + 11) * (rows + trail)
head  = mod(time * speed + phase, rows + trail)      // row of the bright head
d     = head - row                                    // 0 at head, grows upward
if d < 0 || d > trail: discard (black)
bright = select(1.0, pow(1 - d / trail, falloff), d >= 1.0)
glyph  = hashU32(col * K + row * M + floor(time / changeEvery) * N) % glyphCount
local  = fract(px / cell)                             // 0..1 within the cell
cover  = glyphBit(glyph, local)                       // 0/1 from the atlas
color  = mix(trailGreen, headColor, smoothstep(0, 1.5, d)) * bright * cover
return vec4f(color, 1.0)                              // opaque black background
```

- Direction: `v` grows downward in vgpu's `uv`, so increasing `head` over time
  reads as falling; the trail is the rows above the head.
- Glyphs mutate by quantizing time in the hash (`changeEvery`), reproducing the
  flicker without any state.
- Optional cheap glow (v1.1): add `exp(-d * k)` bloom-in-shader or sample
  coverage at a couple of offsets. No multi-pass bloom in v1.

## 4. Glyph atlas

Two viable sources:

**A. Canvas-rasterized (recommended for looks)** — at startup draw a monospace
glyph grid (ASCII printable + half-width katakana U+FF61–U+FF9F) to an offscreen
2D canvas, read the alpha, and pack to bits (e.g. 16×16 → 32 bytes/glyph; ~200
glyphs ≈ 6.4 KB). Upload once with `storage(gpu, bytes, 'read').write(bytes)`.
Canvas is only used to *author* the bytes; the GPU path is entirely vgpu.
Risk: katakana coverage depends on the system font — drop blank glyphs from the
charset.

**B. Embedded bitmap font (deterministic)** — a public-domain 8×8 bitmap font
shipped as bytes in a TS module. No font dependency, identical everywhere, but
blockier and katakana must be hand-designed/omitted.

Decision needed (§9).

## 5. Files (family pattern)

```
components/background/matrix-rain/
  index.ts                       # registerBackground({ id: 'matrix-rain', label: 'Matrix Rain', gpu })
  matrix-rain-gpu/
    index.ts                     # export start
    renderer.ts                  # init, surface, storage upload, effect, frameLoop, teardown
    glyph-atlas.ts               # author glyph bytes -> Uint8Array (+ charset, metrics)
    shaders/
      matrix.wgsl                # fullscreen effect (entry)
      common.wgsl                # hash / glyph-bit / cell helpers
```

Registration is a side-effect import in `components/background/index.ts`; the
System Settings → Appearance list is registry-driven, so it appears with no UI
change.

## 6. Renderer lifecycle

Mirror `ambient-blob-gpu` / `interactive-fluid-gpu`:

- `init({ powerPreference: 'low-power' })` before touching the canvas (so a
  failed GPU init leaves the canvas free — though this family is GPU-only, the
  selector already handles the no-backend case).
- `surface(gpu, canvas, { dpr: ctx.dpr })`, one `effect`, uniforms with
  `resolution` set on resize (via `surface.onResize`).
- `frameLoop(gpu, cb, { fps: ctx.fps })`; set `time` per frame only.
- `prefers-reduced-motion`: render one static frame (or a very slow drift) and
  do not loop.
- Pause while hidden (vgpu frame loop / explicit `document.hidden` guard).
- Device loss / runtime error → `ctx.onFatal` (canvas remount handled by the
  hook).
- `dispose()` the loop, surface, glyph storage, and gpu.

## 7. Validation

- `bg:check` picks it up automatically (the script validates every `@fragment`
  / `@compute` `.wgsl` entry).
- Add `scripts/render-matrix.mjs` (mirrors `render-ambient.mjs`): resolve the
  shader, render offscreen at a fixed time with a fixed atlas via `vgpu/node`,
  read pixels, assert:
  - most pixels are near-black,
  - a meaningful fraction are green,
  - coverage inside a known cell is non-uniform (glyph shape, not a filled box),
  - two different times produce different output (animation),
  and write `matrix-preview.png` for visual review.
- `typecheck`, biome + typography, `build`, full `pnpm run build`.

## 8. Phases

0. **Decide** glyph source + charset (§9).
1. **Atlas** — `glyph-atlas.ts` producing bytes; a throwaway debug effect that
   renders the atlas to verify correctness before the rain exists.
2. **Shader + renderer** — `matrix.wgsl` procedural rain; `renderer.ts` with
   frameLoop, resize, reduced motion, teardown.
3. **Register + settings** — side-effect import; verify it shows in Appearance;
   tag GPU-only automatically.
4. **Tune** — colors, head brightness, trail length/falloff, speed range, cell
   size, glyph change rate, using the pixel preview + a real browser.
5. **Docs** — README note; extend the plan with final tuned constants.

## 9. Decisions to confirm

1. **Charset** — ASCII only, or ASCII + half-width katakana (needs a font that
   provides them)?
2. **Glyph source** — A (canvas-rasterized, nicer, font-dependent) or B
   (embedded bitmap, deterministic, blockier)?
3. **Glow** — v1 flat green only, or include a cheap in-shader glow from the
   start?
4. **Reuse `@vgpu/wgsl-std/hash`** for randomness (recommended) vs inlining a
   hash in `common.wgsl`.
5. Defaults (speed, trail, change rate) — confirm they can be tuned in Phase 4
   rather than fixed now.

## 10. Risks

| Risk | Mitigation |
|---|---|
| No vgpu texture upload | Use a read-only `storage` buffer via `storage().write()` |
| Katakana font coverage varies | Drop blank glyphs; fall back to ASCII; or embedded bitmap |
| Storage indexing in fragment stage | 1 read-only storage buffer; well within `maxStorageBuffersPerShaderStage` |
| Procedural rain looks "too regular" | Per-column hash for speed/phase + time-quantized glyph mutation |
| Authenticity vs a stateful solver | v1 procedural; a compute + storage variant is a possible v2 |
| Bucket/asset footprint | Atlas is a few KB in a lazy GPU chunk (vgpu shared chunk already lazy) |
