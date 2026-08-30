import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { focusedIdAtom, layoutAtom, menuOpenAtom, menuViewAtom, swapModeAtom } from './atoms'
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
import { openViewer, openFileBrowser } from '../lib/actionResolver'
import { TileTools } from './TileTools'
import { usePaneGhosts } from './usePaneGhosts'
import { getTilePlugin, getAllTilePlugins, type TilePlugin } from './tilePlugins'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'

// Register built-in tile plugins (side-effect imports).
import './plugins/term'
import './plugins/viewer'
import './plugins/filebrowser'

const appRow =
  'flex w-full cursor-pointer select-none items-center gap-3 rounded px-3 py-2.5 text-left ' +
  'outline-none transition-colors ' +
  'hover:bg-white/10 hover:text-popover-foreground active:bg-white/15 active:text-popover-foreground ' +
  'focus-visible:bg-white/10 focus-visible:text-popover-foreground'

function AppIcon({ id }: { id: string }) {
  const bg = id === 'term' ? 'bg-sky-500/20 text-sky-400' : id === 'fileviewer' ? 'bg-amber-500/20 text-amber-400' : 'bg-white/10 text-white/40'
  const letter = id.charAt(0).toUpperCase()
  return (
    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-xs font-bold ${bg}`}>
      {letter}
    </div>
  )
}

function ChevronIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

/** Empty pane shown when a tile has no type assigned yet. Auto-focuses on mount. */
function EmptyPane({ paneId, onPick }: { paneId: string; onPick: (id: string) => void }) {
  const { t } = useTranslation()
  const setFocused = useSetAtom(focusedIdAtom)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const timer = setTimeout(() => {
      el.focus()
      setFocused(paneId)
    }, 50)
    return () => clearTimeout(timer)
  }, [paneId, setFocused])

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="flex h-full w-full items-center justify-center outline-none"
    >
      <button
        type="button"
        onClick={() => onPick(paneId)}
        className="glass-control rounded-[6px] px-6 py-3 text-sm font-medium text-slate-300 glass-btn transition hover:text-white"
      >
        + {t('wm.addTile').replace('+ ', '')}
      </button>
    </div>
  )
}

/** iOS-settings-style dialog for choosing which application to open in a tile. */
function TileTypePicker({
  paneId,
  setLayout,
  onClose,
}: {
  paneId: string
  setLayout: (fn: (prev: LayoutNode | null) => LayoutNode | null) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const plugins = getAllTilePlugins()
  const navRef = useRef<HTMLElement>(null)

  useEffect(() => {
    navRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [])

  const select = (tileType: string) => {
    setLayout((prev) => (prev ? setLeafType(prev, paneId, tileType, FONT_DEFAULT, FONT_DEFAULT) : prev))
    onClose()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const rows = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    if (rows.length === 0) return
    const current = rows.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    switch (e.key) {
      case 'ArrowDown':
        next = current < 0 ? 0 : (current + 1) % rows.length
        break
      case 'ArrowUp':
        next = current < 0 ? rows.length - 1 : (current - 1 + rows.length) % rows.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = rows.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    rows[next].focus()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="w-[min(92vw,28rem)]" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <DialogTitle>{t('wm.openApp')}</DialogTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('wm.chooseApp')}</p>
        <nav ref={navRef} aria-label="Applications" onKeyDown={onKeyDown} className="mt-3">
          <div className="divide-y divide-white/5 rounded-[6px] border border-white/10 bg-black/20">
            {plugins.map((p: TilePlugin) => (
              <button
                key={p.id}
                type="button"
                onClick={() => select(p.id)}
                className={appRow}
              >
                <AppIcon id={p.id} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-popover-foreground">{p.label}</div>
                  {p.description && (
                    <div className="text-[11px] text-muted-foreground">{p.description}</div>
                  )}
                </div>
                <ChevronIcon />
              </button>
            ))}
          </div>
        </nav>
      </DialogContent>
    </Dialog>
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
  const { t } = useTranslation()
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
      // Skip the picker-open effect for the focus shift caused by this close.
      closeRefCount.current++
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

  const focusDirection = useCallback(
    (dir: MoveDir) => {
      const cur = store.get(layoutAtom)
      const f = store.get(focusedIdAtom)
      if (!cur || !f || size.w <= 0 || size.h <= 0) return
      const { panes } = computeTiling(cur, size.w, size.h)
      const neighbor = findNeighborRect(panes, f, dir)
      if (!neighbor) return
      store.set(focusedIdAtom, neighbor.id)
      document.querySelector<HTMLElement>(`iframe[data-pane="${neighbor.id}"]`)?.focus()
    },
    [store, size],
  )

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

  // Swap mode: enter, complete, cancel.
  const swapSource = useAtomValue(swapModeAtom)
  const setSwapSource = useSetAtom(swapModeAtom)

  const startSwap = useCallback(
    (id: string) => {
      setSwapHighlightIdx(0)
      setSwapSource(id)
    },
    [setSwapSource],
  )

  const completeSwap = useCallback(
    (targetId: string) => {
      const src = store.get(swapModeAtom)
      if (!src || src === targetId) {
        setSwapSource(null)
        return
      }
      const cur = store.get(layoutAtom)
      if (!cur) return
      store.set(layoutAtom, swapLeaves(cur, src, targetId))
      store.set(focusedIdAtom, src)
      setSwapSource(null)
    },
    [store, setSwapSource],
  )

  const cancelSwap = useCallback(() => {
    setSwapSource(null)
  }, [setSwapSource])

  const enterSwap = useCallback(() => {
    const f = store.get(focusedIdAtom)
    if (f) startSwap(f)
  }, [store, startSwap])

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
    () => ({ split, close, focusOffset, focusDirection, moveFocused, enterSwap, openMenu, openShortcuts }),
    [split, close, focusOffset, focusDirection, moveFocused, enterSwap, openMenu, openShortcuts],
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
      const d = e.data as { type?: string; pane?: unknown; path?: string; tileType?: string; sourcePane?: string; action?: ReturnType<typeof wmAction> } | undefined
      if (d?.type === 'pane-focus') {
        if (typeof d.pane === 'string') store.set(focusedIdAtom, d.pane)
        return
      }
      if (d?.type === 'wm-close-pane' && typeof d.pane === 'string') {
        closeTile(d.pane)
        return
      }
      if (d?.type === 'wm-open-file' && typeof d.path === 'string') {
        // Reuse the actionResolver approach: split from the source pane,
        // set type and initialPath directly on the store.
        if (d.sourcePane) store.set(focusedIdAtom, d.sourcePane)
        if (d.tileType === 'fileviewer') {
          openViewer(d.path, store)
        } else if (d.tileType === 'filebrowser') {
          openFileBrowser(d.path, store)
        }
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
  const closeRefCount = useRef(0)

  // When a pane is focused and has no type, open the picker — but not right
  // after a tile was closed (close shifts focus, which would re-trigger the
  // picker for the next empty leaf).
  useEffect(() => {
    if (!focused || !layout) return
    if (closeRefCount.current > 0) {
      closeRefCount.current--
      return
    }
    const leaf = findLeaf(layout, focused)
    if (leaf && leaf.type === 'leaf' && !leaf.tileType) {
      setPickerPaneId(focused)
    }
  }, [focused, layout])

  // Keyboard navigation during swap mode.
  const [swapHighlightIdx, setSwapHighlightIdx] = useState(0)
  const selectablePanes = useMemo(
    () => (swapSource ? panes.filter((p) => p.id !== swapSource) : []),
    [panes, swapSource],
  )
  const swapOverlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!swapSource) return
    // Pull focus out of any iframe so keyboard events reach the window.
    swapOverlayRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        cancelSwap()
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        setSwapHighlightIdx((i) => (i + 1) % selectablePanes.length)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        setSwapHighlightIdx((i) => (i - 1 + selectablePanes.length) % selectablePanes.length)
      } else if (e.key === 'Enter') {
        const target = selectablePanes[swapHighlightIdx]
        if (target) completeSwap(target.id)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [swapSource, selectablePanes, swapHighlightIdx, cancelSwap, completeSwap])

  return (
    <div ref={viewportRef} data-tiling-viewport className={`relative h-full w-full overflow-hidden ${dragging ? 'wm-dragging' : ''}`}>
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
            + {t('wm.newTile').replace('+ ', '')}
          </button>
        </div>
      )}
      {panes.map(({ id, x, y, w, h }) => {
        const leaf = layout ? findLeaf(layout, id) : null
        const tileType = leaf?.type === 'leaf' ? leaf.tileType : undefined
        const fontSize = leaf?.type === 'leaf' ? (leaf.fontSize ?? FONT_DEFAULT) : FONT_DEFAULT
        const fontDefault = leaf?.type === 'leaf' ? (leaf.fontDefault ?? FONT_DEFAULT) : FONT_DEFAULT
        const plugin = tileType ? getTilePlugin(tileType) : undefined
        const initialPath = leaf?.type === 'leaf' ? leaf.initialPath : undefined

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
              plugin.render(id, { paneId: id, initialPath })
            ) : (
              <EmptyPane paneId={id} onPick={setPickerPaneId} />
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
              startSwap={startSwap}
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
      {/* Swap mode overlay */}
      {swapSource && panes.map(({ id, x, y, w, h }) => {
        if (id === swapSource) return null
        const isHighlighted = selectablePanes[swapHighlightIdx]?.id === id
        return (
          <div
            key={`swap-${id}`}
            className={`absolute z-30 cursor-pointer transition-colors ${
              isHighlighted
                ? 'bg-sky-400/20 border border-sky-400/60'
                : 'bg-sky-500/10 border border-sky-400/30 hover:bg-sky-400/15'
            }`}
            style={{ left: x, top: y, width: w, height: h }}
            onClick={() => completeSwap(id)}
            onMouseEnter={() => setSwapHighlightIdx(selectablePanes.findIndex((p) => p.id === id))}
          >
            <div className="flex h-full items-center justify-center">
              <span className="rounded bg-black/60 px-2 py-1 text-[11px] text-white/70">
                {t('wm.swapWithThisTile')}
              </span>
            </div>
          </div>
        )
      })}
      {swapSource && (() => {
        const src = panes.find((p) => p.id === swapSource)
        if (!src) return null
        return (
          <div
            key="swap-source-glow"
            className="pointer-events-none absolute z-30 rounded-[6px] border border-amber-400/60 shadow-[0_0_12px_rgb(251_191_36/0.25)]"
            style={{ left: src.x, top: src.y, width: src.w, height: src.h }}
          />
        )
      })()}
      {swapSource && (
        <div
          key="swap-scrim"
          ref={swapOverlayRef}
          tabIndex={-1}
          className="absolute inset-0 z-20 outline-none"
          onClick={cancelSwap}
        />
      )}
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
