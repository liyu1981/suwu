# Tile Drag-to-Layout Revamp — Plan

Status: **implemented** (see the deviation note below)
Owner area: `frontend/src/wm/`

> **Implementation deviation:** while wiring the drag swap, the pre-existing
> `swapLeaves()` was found to swap leaf *data* while pinning ids to their slots,
> so panes never changed position (it contradicted its own doc comment). It is
> fixed to move each pane's identity *and* data to the other's slot. This also
> repairs the existing `Alt+S` swap mode.
Related skills: `apple-design` (direct manipulation, interruptibility),
`suwu-tile-plugin-design` (toolbar composition, type scale).

## 1. Goal

Replace the four imperative "move tile" operations (left / right / up / down,
`Alt+Shift+Arrow` + hover-toolbar chevrons) with a single, direct-manipulation
**drag-to-layout** gesture:

- Press a drag handle on a tile → enter a drop-targeting mode (like swap mode,
  but no covers are shown until the pointer is over a tile).
- While dragging, track the pointer and highlight a **drop zone** on the tile
  under the cursor.
- Commit the layout change **only on pointer-up**. `Esc` cancels with no change.

The existing **swap mode** (`Alt+S`, all-tile covers) is **kept**. The new drag
mode is an additional way to reach swap (center drop) plus the four new
"insert adjacent, half-size" operations.

The current keyboard move bindings are retired; focus navigation
(`Alt+Arrow`) and split/close/swap/focus shortcuts are unchanged.

## 2. Current state (what exists today)

| Concern | Where |
| --- | --- |
| Move = swap with geometric neighbour | `TilingWM.tsx` `move()` / `moveFocused()` (~L745–765) |
| Move bindings | `shortcuts.ts` `move-left/right/up/down`, `Alt+Shift+Arrow` |
| Move buttons | `TileTools.tsx` `MOVE_DIRS` chevrons |
| Move capability probe | `TilingWM.tsx` `canMove()`, `findNeighborRect()` in `layout.ts` |
| Swap mode | `swapModeAtom` in `atoms.ts`; `startSwap/completeSwap/cancelSwap` + overlay in `TilingWM.tsx` (~L768–800, L1427–1473) |
| Swap primitive | `swapLeaves(root, a, b)` in `layout.ts` |
| Pane rendering | flat absolutely-positioned divs from `computeTiling()`; `data-pane` iframes |
| Hover toolbar | `TileTools.tsx`, revealed near the top-right `w-56 h-12` zone |
| Reflow animation | `.pane-anim` (0.4s critically-damped approx.) in `styles.css` |

Important constraint: pane bodies are **iframes owned by the child window**.
Pointer events over the tile interior go to the iframe, not the parent. A drag
must therefore **start from a parent-window handle** and rely on
`setPointerCapture` to keep receiving `pointermove` even when the cursor is over
an iframe. (Confirmed by the existing divider-drag in `startDividerDrag`, which
uses `setPointerCapture`.)

## 3. Concepts & geometry

For a target pane rect `R = {x, y, w, h}` (the "ABCD" of the spec), define an
inner rect `I` ("EFGH") that is **65%** of `R`, centered:

```
insetX = 0.175 * w        insetY = 0.175 * h
I = { x + insetX, y + insetY, 0.65*w, 0.65*h }
```

```
A───────────────B
│   E───────F   │
│   │   I   │   │
│   G───────H   │
C───────────────D
```

Zone precedence (checked in this order, so the full-width top/bottom bands win
the corners, exactly as the spec's `AEFB` / `GCHD` rectangles imply):

| Order | Test | Zone | Meaning |
| --- | --- | --- | --- |
| 1 | point inside `I` | `swap` | swap dragged tile with `R` |
| 2 | `p.y < I.y` | `top` | dragged becomes top half, `R` bottom half |
| 3 | `p.y > I.y + I.h` | `bottom` | dragged becomes bottom half, `R` top half |
| 4 | `p.x < I.x` | `left` | dragged becomes left half, `R` right half |
| 5 | `p.x > I.x + I.w` | `right` | dragged becomes right half, `R` left half |

Notes:
- The spec's item **e** is blank in the request; it is inferred to be the
  **left** half (`AEGC`), matching items **d/f** (bottom/right).
- A point over a gutter (8px divider) or outside every pane → **no target**,
  no cover shown.
- The dragged tile itself is excluded as a target.

## 4. Drop operations

| Zone | Layout op | Split direction | Dragged side |
| --- | --- | --- | --- |
| `swap` | `swapLeaves(root, source, target)` (existing) | — | — |
| `top` | insert adjacent | `vertical` | `before` |
| `bottom` | insert adjacent | `vertical` | `after` |
| `left` | insert adjacent | `horizontal` | `before` |
| `right` | insert adjacent | `horizontal` | `after` |

### 4.1 New pure helpers in `layout.ts`

```ts
export type DropZone = 'swap' | 'top' | 'bottom' | 'left' | 'right';

/** Zone for a point relative to a pane rect, or null when outside. */
export function detectDropZone(p: { x: number; y: number }, r: Rect): DropZone | null;

/**
 * Move `sourceId` next to `targetId`, replacing the target slot with a 50/50
 * split. Preserves both leaf ids (and therefore the iframes) and the target's
 * tileType/params. Returns the new tree (or the original on invalid input).
 */
export function moveLeafAdjacent(
  root: LayoutNode,
  sourceId: string,
  targetId: string,
  zone: Exclude<DropZone, 'swap'>,
): LayoutNode;
```

There is deliberately **no** `coverRectForZone` helper: the cover is not a
geometric guess of "half of ABCD". It is read straight out of the **projected
layout** so the preview is pixel-identical to the committed result (see §4.2
and §5.2).

`moveLeafAdjacent` algorithm (pure, no React):

1. `findLeaf` source and target; bail if either is missing / not a leaf / equal.
2. `const without = closeAt(root, sourceId)` — remove the dragged leaf first
   (this collapses empties and may rebalance the remaining weights).
3. Walk `without` and replace the target leaf with
   `createSplit(direction, draggedLeaf, targetLeaf)` (or reversed for `after`),
   reusing the target node as-is and the captured source leaf data (same `id`,
   `tileType`, `initialPath`, `params`).
4. Both split children get `size: 1` (`createSplit` default) → true 50/50.

Because the source leaf id is preserved, the pane renderer (keyed by leaf id)
repositions the existing iframe instead of remounting it — the same invariant
the current `swapLeaves` protects.

Pane data needs no migration: drag stays inside one space and keeps pane ids.

### 4.2 Exact preview — projected layout

Removing the source first can grow the target's slot (e.g. it was `1/3` of a
split and becomes `1/2`), so the dragged tile is half of the **post-removal**
target slot, not necessarily half of the pre-drag ABCD. To keep the preview
honest, the cover is derived from the **actual projected layout**:

1. On hover, when `(sourceId, targetId, zone)` changes, compute
   `projected = zone === 'swap' ? swapLeaves(...) : moveLeafAdjacent(...)`.
2. Run `computeTiling(projected, size.w, size.h)` and read the rect of the
   **dragged leaf id** (both ops preserve the source id).
3. Use that rect as the cover rectangle.

Because the preview and the commit run the same operation through the same
`computeTiling`, the highlighted rect is exactly the final rect for every zone
(including a same-split sibling target). Recompute only when the target/zone
changes, not on every pixel of movement.

## 5. Drag interaction (state machine)

### 5.1 Start affordance

Add a **grip handle** to the shared section of `TileTools` (where the four
cheveron move buttons used to be). This is the primary and recommended
affordance because it lives in the parent window and can own the pointer.

- New `GripIcon` in `wm/icons.tsx` (e.g. six-dot grip), house `toolBtn` class.
- `onPointerDown={(e) => onDragStart(paneId, e)}`, `cursor-grab active:cursor-grabbing`,
  `touch-none`, `aria-label={t('wm.dragTile')}`, `title={t('wm.dragTileHint')}`.

The toolbar grip is the only start affordance (decided): no full-width top grab
strip.

### 5.2 States

`TilingWM` local state (mirrors the swap-mode pattern):

```ts
type DropTarget = { targetId: string; zone: DropZone; coverRect: Rect };
const [dragSource, setDragSource] = useState<string | null>(null);
const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
const [pointerPos, setPointerPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
const dragMovedRef = useRef(false);
```

`startTileDrag(paneId, e)`:

1. `e.preventDefault()` / `stopPropagation()`; set active space + focus pane.
2. `e.currentTarget.setPointerCapture(e.pointerId)`.
3. `setDragSource(paneId)`; attach `pointermove`, `pointerup`,
   `pointercancel`, and a capture-phase `keydown` (Escape) on `window`.
4. Movement threshold (~8–10px, apple-design §10) before showing any cover, so
   a plain click on the grip does not flash an overlay.

`onPointerMove`:

- Compute tiling-local point:
  `x = ev.clientX - viewportRef.current.getBoundingClientRect().left`, same for
  `y`.
- `computeTiling(store.get(layoutAtom), size.w, size.h)` (or reuse a ref to the
  current `panes`).
- Find the pane whose rect contains the point, excluding `dragSource`.
- `detectDropZone(point, rect)`. If the `(targetId, zone)` pair changed since
  the last move, compute the projected layout (§4.2) and store the dragged
  leaf's resulting rect as `coverRect`; otherwise reuse it. Set `dropTarget`
  (or `null`).
- Always update `pointerPos` (client coords) for the floating chip.

`onPointerUp`:

- If `dropTarget`: apply (see §5.3).
- Always: remove listeners, release capture, clear state.

`Escape` / `pointercancel`: cancel — remove listeners, clear state, no layout
change. (Escape listener uses capture so the focused iframe never sees it.)

### 5.3 Commit

```ts
const cur = store.get(layoutAtom);
if (!cur) return;
const next =
  zone === 'swap'
    ? swapLeaves(cur, sourceId, targetId)
    : moveLeafAdjacent(cur, sourceId, targetId, zone);
store.set(layoutAtom, next);
store.set(focusedIdAtom, sourceId);
```

Existing `.pane-anim` transitions animate the reflow (do **not** add
`wm-dragging`, which disables transitions — that class is for 1:1 divider
drags only).

## 6. Rendering while dragging

Rendered as sibling overlay layers in `TilingWM` (same layer style as the swap
overlay, `z-30`/`z-40`), driven purely by `dragSource` + `dropTarget`:

- **Cover** over the target rect, using the projected `coverRect` from §4.2:
  - `swap` → the projected dragged rect (== the target's slot), centered label
    `t('wm.dragSwap')` ("Swap").
  - `top`/`bottom`/`left`/`right` → the projected dragged rect, **no label**.
- **Material**: reuse the existing swap-overlay tint/border
  (`bg-sky-400/20 border-sky-400/60`) for consistency; that's already a
  translucent "material" per apple-design §12.
- **Source tile glow**: reuse the `swap-source-glow` amber ring so the lifted
  tile is obvious.
- **Floating label chip** that follows the pointer (`z-40`, `pointer-events-none`,
  fixed at `pointerPos` + a ~12px offset, flipping near viewport edges). Shows
  the dragged tile's plugin label (from `getTilePlugin(tileType)?.label`), in the
  `menu-glass` material with `rounded-[6px]` and a small shadow. This is the
  cheap "drag ghost" — cloning the iframe is not possible.
- **Cursor**: `grabbing` for the duration (viewport class or `document.body`
  style), restored on end.

Typography: cover label ("Swap") at **Caption 11px** (`text-[11px]`), matching
the existing `wm.swapWithThisTile` badge; the floating chip label at **Label
12px** (`text-xs`). No off-scale sizes (the `check-typography.mjs` gate).

## 7. Retiring the move feature — exact changes

1. **`frontend/src/wm/shortcuts.ts`**
   - Drop `'move-left' | 'move-right' | 'move-up' | 'move-down'` from `WmAction`.
   - Drop `moveFocused` from `WmActionHandlers` and its four `case`s in
     `applyWmAction`.
   - In `wmAction`, arrow keys no longer return `move-*`. Return `focus-*` only
     when `!e.shiftKey`; with Shift held, return `null` (Shift+Arrow is removed
     entirely, per the decision).
2. **`frontend/src/wm/TilingWM.tsx`**
   - Remove `move()` and `moveFocused()` callbacks; remove `canMove()`.
   - Remove them from the `wmHandlers` memo and its dependency array.
   - `TileTools` props: remove `canMove` / `move`; add `onDragStart`.
   - Keep `findNeighborRect` (used by `focusDirection`), `swapLeaves` (swap
     mode + drag), and `MoveDir` (focus).
3. **`frontend/src/wm/TileTools.tsx`**
   - Remove `MOVE_DIRS`, `ARROW_KEY`, the four move buttons, `canMove`/`move`
     props, the `ChevronIcon` and `MoveDir` imports.
   - Add `onDragStart` prop + grip button.
4. **`frontend/src/wm/tilePlugins.ts`**
   - Remove `canMove` and `move` from `ToolbarContext`; drop the now-unused
     `MoveDir` import. (No plugin actually used them — verified.)
5. **`frontend/src/wm/icons.tsx`**
   - Remove the `MoveDir`-based `ChevronIcon` (the split-header chevron is a
     separate local component in `TilingWM.tsx` and stays). Add `GripIcon`.
6. **`frontend/src/locales/en.json` + `zh_CN.json`**
   - Remove `wm.moveDir`, `shortcuts.movement`,
     `shortcuts.moveLeft/Right/Up/Down`.
   - Add `wm.dragTile`, `wm.dragTileHint`, `wm.dragSwap`.
   - Keep `wm.swapTile`, `wm.swapHint`, `wm.swapWithThisTile` (swap mode stays).
7. **`frontend/src/components/dialogs/ShortcutsView.tsx`**
   - Remove the "Move tile" (Movement) section. Optionally add a non-key row
     under Tiles: "Drag tile" → "Drag to a tile edge / hold to swap".
8. **Docs** (keep the skill truthful):
   - `.opencode/skills/suwu-tile-plugin-design/SKILL.md`
     - §7 toolbar composition diagram: replace `[move ←→↑↓]` with `[drag grip]`.
     - §2 `ToolbarContext` code block: drop `canMove` / `move`.
     - §14/§15 checklist wording ("split/close/move/swap" → drag).

## 8. Accessibility & edge cases

- **Escape always cancels** (capture-phase listener; no layout change).
- **Interruptibility**: drag can be reversed by moving back / releasing over no
  target; pointer capture keeps tracking over iframes.
- **Reduced motion**: the commit reflow already respects the global transition;
  verify `prefers-reduced-motion` handling is unaffected (covers are static).
- **Touch**: `touch-none` on the grip so the drag doesn't scroll; pointer events
  already unify mouse/touch/pen.
- **Single-tile space**: no other target → no drop target, drag is a no-op.
- **Source is the only other leaf / siblings**: `moveLeafAdjacent` handles
  collapse-then-split; add guards.
- **Drop on a divider**: yields no target; releasing commits nothing.
- **Cross-space drag**: out of scope; drag only targets panes in the active
  space.
- **Focus-space / hidden spaces**: overlays render for the active space only
  (same as swap overlay), so no cross-space ambiguity.

## 9. Verification plan

- `pnpm --dir frontend typecheck`
- `pnpm --dir frontend check` (Biome + typography + other gates)
- Manual (run `pnpm --dir frontend dev`):
  1. Drag grip → hover a tile's top edge → cover appears on the projected
     landing rect → release → source lands above target; both iframes stay alive
     (terminal scrollback, editor tabs preserved).
  2. Repeat for bottom / left / right.
  3. Hover the inner 65% → "Swap" cover → release → tiles exchange rects.
  4. `Esc` mid-drag → nothing changes.
  5. Release over a gutter / own tile → nothing changes.
  6. Click the grip without moving → nothing happens (threshold).
  7. `Alt+Arrow` still focuses; `Alt+Shift+Arrow` does nothing; swap mode
     (`Alt+S`) still works.
  8. Reload → layout persisted correctly.
  9. **Preview accuracy**: for every zone, the highlighted cover rect is
     pixel-identical to where the tile lands after release. Specifically test a
     target that shares a split with the source (where removal rebalances the
     slot) and confirm the half-size preview still matches the result.
  10. Floating chip follows the pointer and flips at viewport edges.
- No unit-test runner is configured in `frontend`; layout helpers are pure, so
  consider adding a lightweight check script if the project adopts one, but not
  required for this change.

## 10. Sequencing

1. `layout.ts`: `DropZone`, `detectDropZone`, `moveLeafAdjacent`.
2. `TilingWM.tsx`: drag state machine (`startTileDrag`, listeners, commit) +
   projected-layout preview, cover/glow overlays, floating chip.
3. `TileTools.tsx` + `icons.tsx`: grip handle, remove move buttons.
4. `shortcuts.ts` + `tilePlugins.ts`: retire move actions / context fields.
5. Locales + `ShortcutsView.tsx`.
6. Skill/doc updates.
7. Verify (§9).

## 11. Resolved decisions

1. **Start affordance** — toolbar grip only; no full-width top grab strip.
2. **Drag ghost** — include the floating label chip that follows the pointer.
3. **Preview accuracy** — the cover is derived from the projected layout, so
   the preview always matches the committed result exactly (§4.2).
4. **Shift+Arrow** — removed entirely; it does nothing after this change.
