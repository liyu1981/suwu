import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { focusedIdAtom, layoutAtom, menuOpenAtom, menuViewAtom } from './atoms'
import { fontDefaultAtom } from '../store/fonts'
import { clamp } from '../lib/utils'
import {
  closeAt,
  computeTiling,
  findNeighborRect,
  findSplit,
  focusByOffset,
  leaves,
  splitAndFocus,
  swapLeaves,
  updateSplitAt,
  type Direction,
  type DividerSpec,
  type MoveDir,
} from './layout'
import { applyWmAction, wmAction } from './shortcuts'
import { TileTools } from './TileTools'
import { usePaneGhosts } from './usePaneGhosts'

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

  // Split the focused tile (or create the first one on an empty layout).
  const split = useCallback(
    (dir: Direction) => {
      const { next, focus } = splitAndFocus(store.get(layoutAtom), store.get(focusedIdAtom), dir)
      store.set(layoutAtom, next)
      store.set(focusedIdAtom, focus)
    },
    [store],
  )

  // Close a specific tile (hover ✕); Alt+Q closes the focused one.
  const closeTile = useCallback(
    (id: string) => {
      const cur = store.get(layoutAtom)
      if (!cur) return
      const next = closeAt(cur, id)
      store.set(layoutAtom, next)
      store.set(focusedIdAtom, leaves(next)[0] ?? '')
    },
    [store],
  )

  const close = useCallback(() => {
    const f = store.get(focusedIdAtom)
    if (f) closeTile(f)
  }, [store, closeTile])

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

  // Alt+/ opens the unified Suwu dialog at the root menu; Alt+Shift+/
  // jumps straight to the keyboard-shortcuts screen.
  const openMenu = useCallback(() => {
    store.set(menuViewAtom, 'menu')
    store.set(menuOpenAtom, true)
  }, [store])
  const openShortcuts = useCallback(() => {
    store.set(menuViewAtom, 'shortcuts')
    store.set(menuOpenAtom, true)
  }, [store])

  const fontDefault = useAtomValue(fontDefaultAtom)

  // Keep a valid focused leaf (initial state, after close, after storage load).
  useEffect(() => {
    const ids = leaves(layout)
    if (ids.length === 0) return
    if (!focused || !ids.includes(focused)) setFocused(ids[0])
  }, [layout, focused, setFocused])

  const wmHandlers = useMemo(
    () => ({ split, close, focusOffset, moveFocused, openMenu, openShortcuts }),
    [split, close, focusOffset, moveFocused, openMenu, openShortcuts],
  )

  // Keyboard shortcuts when the parent window itself has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = wmAction(e)
      if (!a) return
      e.preventDefault()
      applyWmAction(a, wmHandlers)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wmHandlers])

  // Focus changes reported by a pane iframe (its own window focus event is
  // reliable, unlike parent-side focusin between two iframes).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; pane?: unknown; action?: ReturnType<typeof wmAction> } | undefined
      if (d?.type === 'pane-focus') {
        if (typeof d.pane === 'string') store.set(focusedIdAtom, d.pane)
        return
      }
      const a = d?.type === 'wm-shortcut' ? d.action : undefined
      if (!a) return
      applyWmAction(a, wmHandlers)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [store, wmHandlers])

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

  // Ghosts of just-closed tiles, fading out underneath the live panes.
  const { ghosts, removeGhost } = usePaneGhosts(panes)

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
      {ghosts.map((g) => (
        <div
          key={g.key}
          className="pane-out absolute rounded-[6px] border border-white/5 bg-black/20 shadow-[0_8px_32px_rgb(0_0_0/0.25)]"
          style={{ left: g.rect.x, top: g.rect.y, width: g.rect.w, height: g.rect.h }}
          onAnimationEnd={() => removeGhost(g.key)}
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
          className={`pane-anim pane-in absolute overflow-hidden rounded-[6px] border shadow-[0_8px_32px_rgb(0_0_0/0.25)] ${
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
          <TileTools paneId={id} fontDefault={fontDefault} canMove={canMove} move={move} closeTile={closeTile} />
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
