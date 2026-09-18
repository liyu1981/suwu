# Background Preview in System Settings — Plan

Status: **implemented** (2-GPU optimization deferred) · Owner: frontend · Related:
`frontend/src/components/background/`, `frontend/src/components/dialogs/SettingsView.tsx`

> Implementation notes (what shipped):
> - `canvas-size.ts` — CPU backends now size from the canvas layout box
>   (`clientWidth × clientHeight × dpr`) via a `ResizeObserver`, never
>   `window.innerWidth/Height`, and never write `canvas.style.*`. `ambient-blob-cpu`
>   and `video-cpu` updated; GPU backends already did this via vgpu's layout-backed
>   `surface()`.
> - `BackgroundPreview.tsx` — small live preview above the selector, sized to the
>   window aspect ratio (`fitPreviewBox`), `dpr: [1, 1.5]`, `fps: 24`. Reuses
>   `useBackground`, ignores the `?bg-id` debug override, shows a
>   "Preview needs WebGPU" caption for GPU-only backgrounds without WebGPU.
> - Wired into the Appearance tab above the `Combobox`.
> - Fit math regression check added at `scripts/check-preview-size.mjs`, run by
>   `pnpm check`.
> - **Deferred (per decision):** Phase 6 (suspend the full-viewport background
>   while the preview is mounted). Two GPU devices run at once for now; the
>   preview is small and bounded, and failures degrade to a blank preview rather
>   than a crash.
> - Not verified in a real browser from this environment — needs a visual/GPU
>   pass.

## 1. Goal

Show a small, live preview of the **selected** background directly above the
background selector in **System Settings → Appearance**, so the user can see
what they are choosing before they leave the dialog. The preview:

1. Uses the **current window's aspect ratio**, scaled down to a small box.
2. Renders **only the background canvas** (no terminal/tiles) into that box.
3. Updates when the background selection changes.
4. For the **video** background, renders the video with the current params.

The settings dialog is a glass panel over a `bg-black/45 backdrop-blur-xs`
scrim, so the full-viewport `AmbientBackground` behind it is mostly obscured —
the preview is the only way to judge a choice.

## 2. Findings that shape the design

- The subsystem already exposes everything we need:
  `getBackground(id)` + `resolveBackgroundParams(def, overrides)` +
  `useBackground({ id, params, dpr, fps })` + `startBackground`. A preview is
  just a second, small consumer of the same machinery.
- **GPU backends are already layout-driven.** vgpu's `surface()` treats any
  canvas with a numeric `clientWidth` as layout-backed and sizes its backing
  store from `clientWidth/clientHeight × dpr`, auto-resizing each frame
  (`vgpu/dist/surface.js`). A CSS-sized preview canvas therefore works with
  `ambient-blob`, `interactive-fluid`, `matrix-rain`,
  `atmospheric-landscape`, `seascape` and `rainforest` **with no backend
  changes**.
- **CPU backends are not.** `ambient-blob-cpu/renderer.ts` and
  `video-cpu/renderer.ts` both read `window.innerWidth/innerHeight` and write
  `canvas.style.width/height`. Pointed at a preview canvas they would force it
  to full-window size and destroy the dialog layout. This is the one required
  refactor.
- `AmbientBackground` applies a debug override (`?bg-id=...` / localStorage
  `suwu.bg-id`). The preview must **not** inherit it — it must show exactly the
  id the user selected.
- `useBackground` already restarts the backend when `params` changes and
  remounts the canvas via `canvasKey`; we reuse that so param edits update the
  preview live.

## 3. Required refactor — make CPU backends size from the canvas layout box

Unify CPU sizing with the GPU path: read the canvas's own CSS box, never the
window; never write `canvas.style.*` (the React layer owns layout).

New shared helper `frontend/src/components/background/canvas-size.ts`:

```ts
/** Logical CSS size of a canvas, min 1px, from its layout box. */
export function layoutSize(canvas: HTMLCanvasElement): [number, number]

/**
 * Resize a canvas backing store to `logical × dpr` and install the dpr
 * transform. Returns false (and does nothing) when the box is not laid out yet.
 */
export function applyCanvasSize(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  dpr: number,
): boolean
```

Changes:

- `ambient-blob/ambient-blob-cpu/renderer.ts`
  - `resize()` uses `layoutSize(canvas)` instead of `window.innerWidth/Height`;
    drop the two `canvas.style.*` writes.
  - Replace `window.addEventListener('resize', resize)` with a
    `ResizeObserver` on the canvas so both the full-viewport canvas and the
    preview track their own layout box (viewport resize still triggers it).
  - Guard the initial call: if the box is 0×0, skip until the observer fires.
- `video/video-cpu/renderer.ts` — same two changes.
  - `showMessage()` keeps working: it scales text by canvas size, and the
    preview simply shows the message at a small size. The "choose a file" /
    "loading" / codec-error states therefore render correctly in the preview.
- Leave the GPU backends untouched (vgpu already does this).
- Add a short "Sizing" note to `background/README.md`: **every backend must
  size from `canvas.clientWidth/clientHeight`, not `window`.**

This is a behaviour-preserving change for the full-viewport canvas: its
`fixed inset-0 h-full w-full` box already equals the viewport, so the pixels
rendered are identical.

### Alternative considered — add `size` to `BackgroundContext`

Carrying an explicit logical size in `BackgroundContext` would also work, but it
duplicates what vgpu derives on its own, needs a separate path for the
full-viewport resize case, and leaves the GPU/CPU implementations inconsistent.
Deriving from the canvas box keeps one rule for all backends.

## 4. New component — `BackgroundPreview`

`frontend/src/components/background/BackgroundPreview.tsx`, exported from
`background/index.ts`.

```tsx
export interface BackgroundPreviewProps {
  /** Registered background id; omit to follow `backgroundAtom`. */
  background?: string
  /** Cap on the preview's CSS height, px. Default 180. */
  maxHeight?: number
}
```

### Behaviour

- Reads `backgroundAtom` + `backgroundParamsAtom` (or the `background` prop),
  resolves params with `resolveBackgroundParams`, and starts the backend with
  `useBackground({ id, params, dpr: [1, 1.5], fps: 24 })`.
  - `dpr` capped low and `fps` reduced: the box is a few hundred px wide, so
    the backing store is ~100–150k pixels — cheap even for software canvas and
    ray-marched GPU shaders.
- **Ignores the debug override.** Resolves with `getBackground(id)` directly, so
  `?bg-id=` never hijacks the preview.
- Canvas is keyed by `` `${id}-${paramsKey}-${canvasKey}` `` exactly like
  `AmbientBackground`, so a selection or param change starts a fresh context.

### Sizing (same aspect ratio as the window)

A pure helper (unit-testable) next to the component:

```ts
/** Largest w×h box fitting in (containerWidth × maxHeight) at window aspect. */
export function fitPreviewBox(
  containerWidth: number,
  maxHeight: number,
  aspect: number, // window.innerHeight / window.innerWidth
): { width: number; height: number }
```

- `aspect` is read from `window.innerWidth/innerHeight`, re-read on `resize` /
  `orientationchange` so the preview aspect follows the window.
- `containerWidth` comes from a `ResizeObserver` on the preview wrapper.
- Result is rounded to integer px and applied as the wrapper's inline
  `width`/`height`; the canvas is `h-full w-full` inside it, so
  `clientWidth/clientHeight` (and thus the backend render size) match exactly.

### States

- `backend === null` after startup (GPU-only background, no WebGPU): overlay the
  existing `settings.backgroundGpuOnly` caption centered in the box.
- Video with no clip / loading / decode error: the CPU renderer already paints
  those messages onto the canvas, so no extra handling.

### Material & a11y

- Wrapper: `overflow-hidden rounded-[6px] border border-white/10 bg-black/20`
  (same material as the surrounding `section`), canvas `block h-full w-full
  pointer-events-none`, `aria-hidden="true"`, `data-backend` forwarded for
  debugging.
- Any caption uses the type scale only (`text-[11px]` Caption); no new font
  sizes (CI enforces this).

## 5. Wire into System Settings

In `SettingsView.tsx`, inside the Appearance tab's `section`, put the preview
between the section label and the `Combobox`:

```tsx
<span className={sectionLabel}>{t('settings.background')}</span>
<div className="mt-2">
  <BackgroundPreview />
</div>
<div className="mt-2">
  <Combobox ... />
</div>
```

Because the preview reads `backgroundAtom` / `backgroundParamsAtom`, selecting a
background in the `Combobox` (which writes `setBackground`) and editing any
parameter (`setParam`) update the preview with no extra wiring.

## 6. Optional phase — don't run two instances of the same background

While the preview is mounted, the full-viewport background keeps running behind
the scrim, so a GPU background is instantiated **twice**. The preview is cheap,
but it is still wasted work on the hidden copy, and video decodes twice.

Proposal (separate, opt-in step):

- Add `backgroundPreviewActiveAtom` (boolean) to `store/settings.ts`.
- `BackgroundPreview` sets it `true` while mounted (`useEffect`), resets on
  unmount.
- `AmbientBackground` reads it and, when true, omits its `<canvas>` — the hook
  is still called (rules of hooks) but sees no ref and starts nothing. On close,
  the main background restarts with the newly selected background.

Trade-off: the area around the dialog loses its live ambient backdrop while the
preview is open, and restarts on close. Decide with a visual check before
keeping. If rejected, document that two instances are acceptable because the
preview is bounded and small.

## 7. Interaction caveat — interactive-fluid

`installStirInput` listens on `window` by design (the full-screen canvas is
`pointer-events: none`). A preview instance would therefore be stirred by
pointer movement anywhere over the page, mapped through the preview's
`getBoundingClientRect`. This is harmless (clamped to the canvas) but slightly
odd. Options, in order of preference:

1. Accept it — the preview visibly reacts, and nothing else changes.
2. Add an optional `target: 'window' | 'canvas'` to `installStirInput`; the
   preview passes `'canvas'` and gets `pointer-events-auto` so it can be stirred
   directly.

Keep (1) for the first cut; revisit only if it feels wrong.

## 8. Files touched

| File | Change |
|---|---|
| `background/canvas-size.ts` | **new** layout-size helper |
| `background/ambient-blob/ambient-blob-cpu/renderer.ts` | size from canvas box, ResizeObserver |
| `background/video/video-cpu/renderer.ts` | size from canvas box, ResizeObserver |
| `background/BackgroundPreview.tsx` | **new** preview component |
| `background/preview-size.ts` | **new** `fitPreviewBox` (or co-located) |
| `background/index.ts` | export `BackgroundPreview` |
| `background/README.md` | document the sizing rule + preview |
| `dialogs/SettingsView.tsx` | render preview above the selector |
| `store/settings.ts` | *(optional phase 6)* preview-active atom |

## 9. Testing

- **Unit (vitest):** `fitPreviewBox` — wide/tall windows, container narrower than
  max-height, zero/degenerate aspect, integer rounding.
- **Manual matrix:** each registered background renders in the preview and
  reports the expected `data-backend`; switching selection restarts cleanly (no
  leaked canvas, no console errors); editing a param updates the preview;
  video with no clip shows the "choose a file" canvas message, then plays once
  a clip is picked; `?bg-id=` / `suwu.bg-id` does **not** override the preview.
- **Regression:** confirm the full-viewport background is visually unchanged
  after the CPU sizing refactor (same pixels) and that
  `pnpm --dir frontend bg:check` still passes.
- **Design checks:** `pnpm check` (type-check + off-scale font lint) passes.

## 10. Non-goals

- No edit to background visuals or shaders.
- No new persisted setting; the preview is transient UI.
- No preview for the debug override path.
- No preview of the app shell/tiles — the background canvas only.
