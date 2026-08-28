import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { focusedIdAtom, layoutAtom, shortcutsOpenAtom } from './atoms'
import { FONT_MAX, FONT_MIN, clampFont, fontDefaultAtom, fontSizeAtom } from '../store/fonts'
import {
  clamp,
  closeAt,
  computeTiling,
  createLeaf,
  findNeighborRect,
  findSplit,
  focusByOffset,
  leaves,
  splitAt,
  swapLeaves,
  updateSplitAt,
  type Direction,
  type DividerSpec,
  type MoveDir,
  type Rect,
} from './layout'
import { wmAction, type WmAction } from './shortcuts'

function action(
  name: WmAction,
  h: {
    split: (d: Direction) => void
    close: () => void
    focusOffset: (o: number) => void
    moveFocused: (d: MoveDir) => void
    openHelp: () => void
  },
) {
  switch (name) {
    case 'split-right':
      h.split('horizontal')
      break
    case 'split-below':
      h.split('vertical')
      break
    case 'close':
      h.close()
      break
    case 'focus-next':
      h.focusOffset(1)
      break
    case 'focus-prev':
      h.focusOffset(-1)
      break
    case 'move-left':
      h.moveFocused('left')
      break
    case 'move-right':
      h.moveFocused('right')
      break
    case 'move-up':
      h.moveFocused('up')
      break
    case 'move-down':
      h.moveFocused('down')
      break
    case 'help':
      h.openHelp()
      break
  }
}

function ChevronIcon({ dir }: { dir: MoveDir }) {
  const d =
    dir === 'left'
      ? 'M15 6l-6 6 6 6'
      : dir === 'right'
        ? 'M9 6l6 6-6 6'
        : dir === 'up'
          ? 'M6 15l6-6 6 6'
          : 'M6 9l6 6 6-6'
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  )
}

const MOVE_DIRS: MoveDir[] = ['left', 'right', 'up', 'down']
const ARROW_KEY: Record<MoveDir, string> = { left: '←', right: '→', up: '↑', down: '↓' }

const moveBtn =
  'grid h-5 w-5 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-300'

const fontLabel = 'text-[9px] font-semibold leading-none'

function ResetFontSizeIcon() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}

/** A vanished tile rendered at its last rect while it fades out. */
type PaneGhost = { key: string; rect: Rect }

/**
 * A tiling window-manager-style page: a tree of terminal panes rendered as
 * same-origin iframes (each loading `/term` with a full-space xterm
 * terminal), with split / close / focus / resize controls.
 *
 * Rendering detail that matters: panes are NOT nested flex boxes mirroring
 * the layout tree — they are a flat list keyed by leaf id and positioned
 * absolutely from rects computed by `computeTiling`. Splitting or closing
 * then only mutates inline styles; an iframe's DOM node is never recreated
 * or reparented, so its PTY session survives layout changes.
 */
export default function TilingWM() {
  const store = useStore()
  const layout = useAtomValue(layoutAtom)
  const focused = useAtomValue(focusedIdAtom)
  const setFocused = useSetAtom(focusedIdAtom)
  const setLayout = useSetAtom(layoutAtom)

  const split = useCallback(
    (dir: Direction) => {
      const cur = store.get(layoutAtom)
      // Empty layout: create first tile
      if (!cur) {
        const leaf = createLeaf()
        store.set(layoutAtom, leaf)
        store.set(focusedIdAtom, leaf.id)
        return
      }
      const f = store.get(focusedIdAtom)
      const target = f && leaves(cur).includes(f) ? f : leaves(cur)[0]
      if (!target) return
      const next = splitAt(cur, target, dir)
      store.set(layoutAtom, next)
      const ids = leaves(next).filter((id) => id !== target)
      store.set(focusedIdAtom, ids[ids.length - 1] ?? target)
    },
    [store],
  )

  const close = useCallback(() => {
    const cur = store.get(layoutAtom)
    if (!cur) return
    const f = store.get(focusedIdAtom)
    if (!f) return
    const next = closeAt(cur, f)
    store.set(layoutAtom, next)
    store.set(focusedIdAtom, leaves(next)[0] ?? '')
  }, [store])

  const focusOffset = useCallback(
    (off: number) => {
      const cur = store.get(layoutAtom)
      const f = store.get(focusedIdAtom)
      const next = focusByOffset(cur, f, off)
      store.set(focusedIdAtom, next)
      // Move real keyboard focus with the border, or typing would keep
      // landing in the previously focused terminal.
      if (next) document.querySelector<HTMLElement>(`iframe[data-pane="${next}"]`)?.focus()
    },
    [store],
  )

  // Measure the tiling viewport so pane rects can be laid out in px.
  const viewportRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  // True while a divider drag is in progress (suspends rect transitions).
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Swap the tile with its nearest geometric neighbor in a direction; a
  // no-op when there is no neighbor (edge of the layout).
  const move = useCallback(
    (id: string, dir: MoveDir) => {
      const cur = store.get(layoutAtom)
      if (!cur || size.w <= 0 || size.h <= 0) return
      const { panes } = computeTiling(cur, size.w, size.h)
      const neighbor = findNeighborRect(panes, id, dir)
      if (!neighbor) return
      store.set(layoutAtom, swapLeaves(cur, id, neighbor.id))
      store.set(focusedIdAtom, id)
    },
    [store, size],
  )

  const moveFocused = useCallback(
    (dir: MoveDir) => {
      const f = store.get(focusedIdAtom)
      if (f) move(f, dir)
    },
    [store, move],
  )

  const openHelp = useCallback(() => store.set(shortcutsOpenAtom, true), [store])

  // Shared terminal font size: the hover tools adjust the global size so
  // every pane picks it up (same atoms the Settings dialog writes).
  const fontSize = useAtomValue(fontSizeAtom)
  const fontDefault = useAtomValue(fontDefaultAtom)
  const setFontSize = useSetAtom(fontSizeAtom)

  // Keep a valid focused leaf (initial state, after close, after storage load).
  useEffect(() => {
    const ids = leaves(layout)
    if (ids.length === 0) return
    if (!focused || !ids.includes(focused)) setFocused(ids[0])
  }, [layout, focused, setFocused])

  // Keyboard shortcuts when the parent window itself has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = wmAction(e)
      if (!a) return
      e.preventDefault()
      action(a, { split, close, focusOffset, moveFocused, openHelp })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [split, close, focusOffset, moveFocused, openHelp])

  // Focus changes reported by a pane iframe (its own window focus event is
  // reliable, unlike parent-side focusin between two iframes).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; pane?: unknown; action?: WmAction } | undefined
      if (d?.type === 'pane-focus') {
        if (typeof d.pane === 'string') store.set(focusedIdAtom, d.pane)
        return
      }
      const a = d?.type === 'wm-shortcut' ? d.action : undefined
      if (!a) return
      action(a, { split, close, focusOffset, moveFocused, openHelp })
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [store, split, close, focusOffset, moveFocused, openHelp])

  // Detect clicks into an iframe: the parent's document.activeElement becomes
  // the focused <iframe>, so we can track which pane is focused.
  useEffect(() => {
    const onFocus = () => {
      const el = document.activeElement as HTMLElement | null
      if (el?.tagName === 'IFRAME') {
        const id = el.getAttribute('data-pane')
        if (id) store.set(focusedIdAtom, id)
      }
    }
    window.addEventListener('focusin', onFocus)
    return () => window.removeEventListener('focusin', onFocus)
  }, [store])

  const { panes, dividers } = useMemo(
    () => computeTiling(layout, size.w, size.h),
    [layout, size.w, size.h],
  )

  // Whether a move in `dir` has a neighbor to swap with (drives the disabled
  // state of the per-tile hover buttons).
  const canMove = useCallback(
    (id: string, dir: MoveDir) => findNeighborRect(panes, id, dir) !== null,
    [panes],
  )

  // When tiles vanish (close), render ghosts at their last rects that fade
  // out; React unmounts instantly, so the ghost is what animates the exit.
  const prevRectsRef = useRef(new Map<string, Rect>())
  const [ghosts, setGhosts] = useState<PaneGhost[]>([])
  useEffect(() => {
    const cur = new Map(panes.map((p) => [p.id, { x: p.x, y: p.y, w: p.w, h: p.h }]))
    const vanished: PaneGhost[] = []
    for (const [id, rect] of prevRectsRef.current) {
      if (!cur.has(id)) vanished.push({ key: `${id}-${Date.now()}-${Math.random()}`, rect })
    }
    prevRectsRef.current = cur
    if (vanished.length > 0) setGhosts((all) => [...all, ...vanished])
  }, [panes])

  const startDividerDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, seg: DividerSpec) => {
      e.preventDefault()
      e.stopPropagation()

      // Rect transitions chase the pointer and break 1:1 tracking; during a
      // drag the panes must follow exactly, so suspend the animation.
      setDragging(true)

      const root = store.get(layoutAtom)
      const sp = findSplit(root, seg.splitId)
      const a = sp?.children[seg.index]?.size ?? 0
      const b = sp?.children[seg.index + 1]?.size ?? 0
      const totalFlex = a + b
      if (!(totalFlex > 0) || !(seg.length > 0)) return

      const target = e.currentTarget
      target.setPointerCapture(e.pointerId)
      const startPx = seg.axis === 'x' ? e.clientX : e.clientY
      const min = Math.min(0.15, totalFlex / 4)

      const onMove = (ev: PointerEvent) => {
        const delta = (seg.axis === 'x' ? ev.clientX : ev.clientY) - startPx
        const na = clamp(a + (delta / seg.length) * totalFlex, min, totalFlex - min)
        setLayout((layout) =>
          layout
            ? updateSplitAt(layout, seg.splitId, (children) =>
                children.map((c, i) =>
                  i === seg.index ? { ...c, size: na } : i === seg.index + 1 ? { ...c, size: totalFlex - na } : c,
                ),
              )
            : layout,
        )
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        setDragging(false)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [store, setLayout],
  )

  return (
    <div ref={viewportRef} className={`relative h-full w-full overflow-hidden ${dragging ? 'wm-dragging' : ''}`}>
      {/* Ghosts of just-closed tiles, fading out underneath the live panes. */}
      {ghosts.map((g) => (
        <div
          key={g.key}
          className="pane-out absolute rounded-[6px] border border-white/5 bg-black/20 shadow-[0_8px_32px_rgb(0_0_0/0.25)]"
          style={{ left: g.rect.x, top: g.rect.y, width: g.rect.w, height: g.rect.h }}
          onAnimationEnd={() => setGhosts((all) => all.filter((x) => x.key !== g.key))}
        />
      ))}
      {!layout && (
        <div className="flex h-full w-full items-center justify-center">
          <button
            type="button"
            onClick={() => split('horizontal')}
            className="glass-control rounded-[6px] px-6 py-3 text-sm font-medium text-slate-300 glass-btn transition hover:text-white"
          >
            + New tile
          </button>
        </div>
      )}
      {panes.map(({ id, x, y, w, h }) => (
        <div
          key={id}
          className={`pane-anim pane-in group absolute overflow-hidden rounded-[6px] border shadow-[0_8px_32px_rgb(0_0_0/0.25)] ${
            focused === id
              // Header chrome tone (apple-panel is white 10% over the page),
              // brightened well above it so the focused tile clearly reads.
              ? 'border-[color-mix(in_oklch,white_45%,var(--background))]'
              : 'border-white/5'
          }`}
          style={{ left: x, top: y, width: w, height: h }}
          onMouseDown={() => setFocused(id)}
        >
          <iframe src={`/term?pane=${id}`} title={`terminal-${id}`} data-pane={id} className="h-full w-full border-0 bg-transparent" />
          {/* Move controls: revealed while the pointer is over the tile;
              disabled when no neighbor exists that way. Keyboard users have
              Alt+Arrows, so the pill stays hover-only and never obstructs
              the focused terminal. */}
          <div
            className="pointer-events-none absolute right-1.5 top-1.5 z-10 flex gap-0.5 rounded-[6px] glass-control p-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 motion-reduce:transition-none"
            role="toolbar"
            aria-label={`Move tile ${id}`}
          >
            {/* Shared font size controls (global across panes) ... */}
            <button
              type="button"
              disabled={fontSize <= FONT_MIN}
              onClick={() => setFontSize(clampFont(fontSize - 1))}
              aria-label="Decrease font size"
              title="Decrease font size"
              className={moveBtn}
            >
              <span className={fontLabel}>A-</span>
            </button>
            <button
              type="button"
              disabled={fontSize >= FONT_MAX}
              onClick={() => setFontSize(clampFont(fontSize + 1))}
              aria-label="Increase font size"
              title="Increase font size"
              className={moveBtn}
            >
              <span className={fontLabel}>A+</span>
            </button>
            <button
              type="button"
              disabled={fontSize === fontDefault}
              onClick={() => setFontSize(fontDefault)}
              aria-label="Reset font size"
              title={`Reset font size (${fontDefault}px)`}
              className={moveBtn}
            >
              <ResetFontSizeIcon />
            </button>
            {/* ... then per-tile movement. */}
            <div className="mx-0.5 my-0.5 w-px self-stretch bg-white/10" />
            {MOVE_DIRS.map((dir) => (
              <button
                key={dir}
                type="button"
                disabled={!canMove(id, dir)}
                onClick={() => move(id, dir)}
                aria-label={`Move tile ${dir}`}
                title={`Move tile ${dir} (Alt+${ARROW_KEY[dir]})`}
                className={moveBtn}
              >
                <ChevronIcon dir={dir} />
              </button>
            ))}
          </div>
        </div>
      ))}
      {dividers.map((seg) => (
        <div
          key={`${seg.splitId}-${seg.index}`}
          className="absolute z-10 bg-white/5 hover:bg-sky-400/60 active:bg-sky-400"
          style={{
            left: seg.rect.x,
            top: seg.rect.y,
            width: seg.rect.w,
            height: seg.rect.h,
            cursor: seg.axis === 'x' ? 'col-resize' : 'row-resize',
          }}
          onPointerDown={(e) => startDividerDrag(e, seg)}
        />
      ))}
    </div>
  )
}
