import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { focusedIdAtom, layoutAtom, menuOpenAtom, menuViewAtom } from './atoms'
import { FONT_DEFAULT } from '../store/fonts'
import { clamp } from '../lib/utils'
import {
  closeAt,
  computeTiling,
  findNeighborRect,
  findLeaf,
  findSplit,
  focusByOffset,
  leaves,
  setLeafFontSize,
  setLeafType,
  splitAndFocus,
  swapLeaves,
  updateSplitAt,
  type Direction,
  type DividerSpec,
  type LayoutNode,
  type MoveDir,
} from './layout'
import { applyWmAction, wmAction } from './shortcuts'
import { TileTools } from './TileTools'
import { usePaneGhosts } from './usePaneGhosts'
import { getTilePlugin, getAllTilePlugins } from './tilePlugins'

// Register built-in tile plugins (side-effect imports).
import './plugins/term'
import './plugins/viewer'

/** Minimal inline dialog for selecting a tile type. */
function TileTypePicker({
  paneId,
  setLayout,
  onClose,
}: {
  paneId: string
  setLayout: (fn: (prev: LayoutNode | null) => LayoutNode | null) => void
  onClose: () => void
}) {
  const plugins = getAllTilePlugins()

  const select = (tileType: string) => {
    setLayout((prev) => (prev ? setLeafType(prev, paneId, tileType, FONT_DEFAULT, FONT_DEFAULT) : prev))
    onClose()
  }

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40">
      <div className="glass-control menu-glass rounded-[6px] p-3">
        <p className="mb-2 text-xs font-medium text-white/60">Choose tile type</p>
        <div className="flex gap-2">
          {plugins.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => select(p.id)}
              className="rounded px-4 py-2 text-sm font-medium text-slate-300 glass-btn transition hover:bg-white/10 hover:text-white"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * A tiling window-manager-style page: a tree of panes rendered as
 * same-origin iframes (each loading the content of its registered tile
 * plugin), with split / close / focus / resize controls.
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
      if (next) document.querySelector<HTMLElement>(`iframe[data-pane="${next}"]`)?.focus()
    },
    [store],
  )

  // Measure the tiling viewport so pane rects can be laid out in px.
  const viewportRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
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

  const openMenu = useCallback(() => {
    store.set(menuViewAtom, 'menu')
    store.set(menuOpenAtom, true)
  }, [store])
  const openShortcuts = useCallback(() => {
    store.set(menuViewAtom, 'shortcuts')
    store.set(menuOpenAtom, true)
  }, [store])

  // Per-tile font size setter: updates the leaf node in the layout tree.
  const setTileFontSize = useCallback(
    (id: string, fontSize: number) => {
      setLayout((prev) => (prev ? setLeafFontSize(prev, id, fontSize) : prev))
    },
    [setLayout],
  )

  // Send font size to each iframe whenever the layout tree changes.
  // Iframes read their initial fontSize from atomWithStorage; postMessage
  // overrides it with the per-tile value stored on the leaf node.
  useEffect(() => {
    if (!layout) return
    const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe[data-pane]')
    for (const iframe of iframes) {
      const paneId = iframe.getAttribute('data-pane')
      if (!paneId) continue
      const leaf = findLeaf(layout, paneId)
      if (leaf?.type !== 'leaf') continue
      const fontSize = leaf.fontSize ?? FONT_DEFAULT
      const fontDefault = leaf.fontDefault ?? FONT_DEFAULT
      iframe.contentWindow?.postMessage({ type: 'tile-font-size', fontSize, fontDefault }, '*')
    }
  }, [layout])

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

  const canMove = useCallback(
    (id: string, dir: MoveDir) => findNeighborRect(panes, id, dir) !== null,
    [panes],
  )

  const { ghosts, removeGhost } = usePaneGhosts(panes)

  const startDividerDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, seg: DividerSpec) => {
      e.preventDefault()
      e.stopPropagation()
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

  // State for the type-selection picker (one at a time).
  const [pickerPaneId, setPickerPaneId] = useState<string | null>(null)

  // When a pane is focused and has no type, open the picker.
  useEffect(() => {
    if (!focused || !layout) return
    const leaf = findLeaf(layout, focused)
    if (leaf && leaf.type === 'leaf' && !leaf.tileType) {
      setPickerPaneId(focused)
    }
  }, [focused, layout])

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
      {panes.map(({ id, x, y, w, h }) => {
        const leaf = layout ? findLeaf(layout, id) : null
        const tileType = leaf?.type === 'leaf' ? leaf.tileType : undefined
        const fontSize = leaf?.type === 'leaf' ? (leaf.fontSize ?? FONT_DEFAULT) : FONT_DEFAULT
        const fontDefault = leaf?.type === 'leaf' ? (leaf.fontDefault ?? FONT_DEFAULT) : FONT_DEFAULT
        const plugin = tileType ? getTilePlugin(tileType) : undefined

        return (
          <div
            key={id}
            className={`pane-anim pane-in absolute overflow-hidden rounded-[6px] border shadow-[0_8px_32px_rgb(0_0_0/0.25)] ${
              focused === id
                ? 'border-[color-mix(in_oklch,white_45%,var(--background))]'
                : 'border-white/5'
            }`}
            style={{ left: x, top: y, width: w, height: h }}
            onMouseDown={() => setFocused(id)}
          >
            {tileType && plugin ? (
              plugin.render(id)
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <button
                  type="button"
                  onClick={() => setPickerPaneId(id)}
                  className="glass-control rounded-[6px] px-6 py-3 text-sm font-medium text-slate-300 glass-btn transition hover:text-white"
                >
                  + Add tile
                </button>
              </div>
            )}
            <TileTools
              paneId={id}
              fontSize={fontSize}
              fontDefault={fontDefault}
              setFontSize={(size) => setTileFontSize(id, size)}
              plugin={plugin}
              canMove={canMove}
              move={move}
              closeTile={closeTile}
            />
          </div>
        )
      })}
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
      {pickerPaneId && layout && (
        <TileTypePicker
          paneId={pickerPaneId}
          setLayout={setLayout}
          onClose={() => setPickerPaneId(null)}
        />
      )}
    </div>
  )
}
