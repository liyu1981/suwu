import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { focusedIdAtom, layoutAtom, menuOpenAtom, menuViewAtom, spacesAtom, activeSpaceAtom, swapModeAtom, focusAtom, FOCUS_SPACE_NAME } from './atoms'
import { fontDefaultAtom } from '../store/fonts'
import { clamp } from '../lib/utils'
import {
  closeAt,
  computeTiling,
  cycleSpace,
  createLeaf,
  createSpace,
  findNeighborRect,
  findLeaf,
  findSplit,
  focusByOffset,
  getPaneData,
  leaves,
  moveLeafBetweenSpaces,
  setPaneData,
  splitAtWithId,
  swapLeafIds,
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
import { getCredentials } from '../lib/auth'
import { TileTools } from './TileTools'
import { usePaneGhosts } from './usePaneGhosts'
import { getTilePlugin, getAllTilePlugins, type TilePlugin } from './tilePlugins'
import { getAllAppConfigs, type AppConfig } from './appConfigs'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'
import { SESSION_STATE_KEY, MAX_SERVER_SESSIONS, type TileSessionMap, type SessionStore } from './sessionState'

// Register built-in tile plugins (side-effect imports).
import './plugins/term'
import './plugins/viewer'
import './plugins/filebrowser'
import './plugins/empty'
import './plugins/forward'
import './plugins/dropbox'

// Register app config presets (side-effect imports).
import './configs/herdr'

const appRow =
  'flex w-full cursor-pointer select-none items-center gap-3 rounded px-3 py-2.5 text-left ' +
  'outline-none transition-colors ' +
  'hover:bg-white/10 hover:text-popover-foreground active:bg-white/15 active:text-popover-foreground ' +
  'focus-visible:bg-white/10 focus-visible:text-popover-foreground'

function AppIcon({ id }: { id: string }) {
  const bg = id === 'term' ? 'bg-sky-500/20 text-sky-400' : id === 'fileviewer' ? 'bg-amber-500/20 text-amber-400' : id === 'forward' ? 'bg-cyan-500/20 text-cyan-400' : 'bg-white/10 text-white/40'
  const letter = id === 'forward' ? 'F' : id.charAt(0).toUpperCase()
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

/** iOS-settings-style dialog for choosing which application to open in a tile. */
function TileTypePicker({
  paneId,
  setLayout,
  onSelect,
  onClose,
}: {
  paneId: string
  setLayout: (fn: (prev: LayoutNode | null) => LayoutNode | null) => void
  onSelect: (tileType: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const plugins = getAllTilePlugins().filter((p) => p.id !== 'empty')
  const appConfigs = getAllAppConfigs()
  const navRef = useRef<HTMLElement>(null)
  const [homeDir, setHomeDir] = useState<string | null>(null)

  useEffect(() => {
    navRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const headers: Record<string, string> = {}
    const creds = getCredentials()
    if (creds) headers['Authorization'] = creds
    fetch('/api/home', { cache: 'no-store', headers, signal: controller.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.path) setHomeDir(data.path) })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  const selectPlugin = (tileType: string, params?: Record<string, string>) => {
    const initialPath = (tileType === 'filebrowser' || tileType === 'fileviewer') ? homeDir ?? undefined : undefined
    setLayout((prev) => prev ? setLeafType(prev, paneId, tileType, initialPath, params) : prev)
    onSelect(tileType)
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

  // Build a merged list: real plugins first, then app config presets.
  type PickerItem =
    | { kind: 'plugin'; plugin: TilePlugin }
    | { kind: 'config'; config: AppConfig }
  const items: PickerItem[] = [
    ...plugins.map((p) => ({ kind: 'plugin' as const, plugin: p })),
    ...appConfigs.map((c) => ({ kind: 'config' as const, config: c })),
  ]

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="w-[min(92vw,28rem)]" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <DialogTitle>{t('wm.openApp')}</DialogTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('wm.chooseApp')}</p>
        <nav ref={navRef} aria-label="Applications" onKeyDown={onKeyDown} className="mt-3">
          <div className="divide-y divide-white/5 rounded-[6px] border border-white/10 bg-black/20">
            {items.map((item) => {
              if (item.kind === 'plugin') {
                const p = item.plugin
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => selectPlugin(p.id)}
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
                )
              }
              const c = item.config
              const letter = (c.iconLetter ?? c.label.charAt(0)).toUpperCase()
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => selectPlugin(c.pluginId, c.params)}
                  className={appRow}
                >
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-xs font-bold ${c.iconBg}`}>
                    {letter}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-popover-foreground">{c.label}</div>
                    {c.description && (
                      <div className="text-[11px] text-muted-foreground">{c.description}</div>
                    )}
                  </div>
                  <ChevronIcon />
                </button>
              )
            })}
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
  const spaces = useAtomValue(spacesAtom)
  const activeSpace = useAtomValue(activeSpaceAtom)
  const focused = useAtomValue(focusedIdAtom)
  const setFocused = useSetAtom(focusedIdAtom)
  const setLayout = useSetAtom(layoutAtom)
  // fontDefaultAtom is the "default for new terminals" preset, not a
  // runtime override. Each tile's actual font lives in space.paneData.
  const fontPreset = useAtomValue(fontDefaultAtom)

  // Server start timestamp — identifies this server instance.
  const [serverStartedAt, setServerStartedAt] = useState<string>('')

  // Per-tile session state for the current server instance.
  const [sessionState, setSessionState] = useState<TileSessionMap>({})

  // Load from localStorage: use the latest timestamp if available,
  // otherwise query server for startedAt.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSION_STATE_KEY)
      if (raw) {
        const store: SessionStore = JSON.parse(raw)
        const keys = Object.keys(store)
        if (keys.length > 0) {
          keys.sort()
          const latest = keys[keys.length - 1]
          setServerStartedAt(latest)
          setSessionState(store[latest])
          return
        }
      }
    } catch {
      // ignore
    }
    const headers: Record<string, string> = {}
    const creds = getCredentials()
    if (creds) headers['Authorization'] = creds
    fetch('/api/server-info', { cache: 'no-store', headers })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.startedAt) {
          setServerStartedAt(data.startedAt)
        }
      })
      .catch(() => {})
  }, [])

  // Notify child iframes when startedAt changes.
  useEffect(() => {
    if (!serverStartedAt) return
    document.querySelectorAll<HTMLIFrameElement>('iframe[data-pane]').forEach((iframe) => {
      iframe.contentWindow?.postMessage({ type: 'server-started-at', startedAt: serverStartedAt }, '*')
    })
    // When startedAt changes (server restarted), load the new server's state
    // (which is likely empty) so tiles don't try to restore stale state.
    try {
      const raw = localStorage.getItem(SESSION_STATE_KEY)
      if (raw) {
        const store: SessionStore = JSON.parse(raw)
        const newState = store[serverStartedAt] ?? {}
        setSessionState(newState)
      } else {
        setSessionState({})
      }
    } catch {
      setSessionState({})
    }
  }, [serverStartedAt])

  // Load saved state for this server instance once startedAt is known.
  useEffect(() => {
    if (!serverStartedAt) return
    try {
      const raw = localStorage.getItem(SESSION_STATE_KEY)
      if (!raw) return
      const store: SessionStore = JSON.parse(raw)
      const saved = store[serverStartedAt]
      if (saved) {
        setSessionState(saved)
      }
    } catch {
      // ignore
    }
  }, [serverStartedAt])

  // Listen for tile-state-update messages from iframes and persist to localStorage.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; paneId?: string; state?: Record<string, unknown> } | undefined
      if (d?.type === 'tile-state-update' && typeof d.paneId === 'string' && d.state) {
        const leaf = layout ? findLeaf(layout, d.paneId) : null
        const tileType = leaf?.type === 'leaf' ? leaf.tileType : undefined
        if (!tileType) return
        setSessionState((prev) => {
          const old = prev[d.paneId!]
          if (old && JSON.stringify(old.state) === JSON.stringify(d.state)) return prev
          return { ...prev, [d.paneId!]: { tileType, state: d.state! } }
        })
      }
      // Child iframe requesting its font size (sent on mount to fix
      // the race where the parent's postMessage arrives before the
      // child's listener is registered).
      if (d?.type === 'request-font-size' && typeof d.paneId === 'string') {
        const activeSpaces = store.get(spacesAtom)
        const activeIdx = store.get(activeSpaceAtom)
        const activeSpace = activeSpaces[activeIdx]
        const pane = activeSpace ? getPaneData<{ fontSize?: number; fontDefault?: number }>(activeSpace, d.paneId) : undefined
        const fontSize = pane?.fontSize ?? fontPreset
        const fontDefault = pane?.fontDefault ?? fontPreset
        e.source?.postMessage({ type: 'tile-font-size', fontSize, fontDefault })
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [layout, fontPreset, store])

  // Debounced write of session state to localStorage (only if changed).
  // Re-queries server startedAt before writing to handle server restarts.
  useEffect(() => {
    if (!serverStartedAt) return
    const t = setTimeout(async () => {
      try {
        // Re-query server startedAt to detect restarts.
        const headers: Record<string, string> = {}
        const creds = getCredentials()
        if (creds) headers['Authorization'] = creds
        const res = await fetch('/api/server-info', { cache: 'no-store', headers })
        let currentStartedAt = serverStartedAt
        if (res.ok) {
          const info = await res.json()
          if (info?.startedAt && info.startedAt !== serverStartedAt) {
            currentStartedAt = info.startedAt
            setServerStartedAt(currentStartedAt)
            // Notify children of new startedAt.
            document.querySelectorAll<HTMLIFrameElement>('iframe[data-pane]').forEach((iframe) => {
              iframe.contentWindow?.postMessage({ type: 'server-started-at', startedAt: currentStartedAt }, '*')
            })
          }
        }

        const raw = localStorage.getItem(SESSION_STATE_KEY)
        const store: SessionStore = raw ? JSON.parse(raw) : {}
        const current = JSON.stringify(store[currentStartedAt] ?? {})
        const next = JSON.stringify(sessionState)
        if (current === next) return
        store[currentStartedAt] = sessionState
        // Prune: keep at most MAX_SERVER_SESSIONS entries (FIFO by key).
        const keys = Object.keys(store)
        if (keys.length > MAX_SERVER_SESSIONS) {
          keys.sort()
          for (let i = 0; i < keys.length - MAX_SERVER_SESSIONS; i++) {
            delete store[keys[i]]
          }
        }
        localStorage.setItem(SESSION_STATE_KEY, JSON.stringify(store))
      } catch {
        // localStorage full or unavailable — silently ignore.
      }
    }, 500)
    return () => clearTimeout(t)
  }, [sessionState, serverStartedAt])

  // Cleanup: remove session entries for tiles that no longer exist in any space.
  useEffect(() => {
    if (!spaces.length) return
    const ids = new Set(spaces.flatMap((s) => leaves(s.layout)))
    setSessionState((prev) => {
      let changed = false
      const next = { ...prev }
      for (const key of Object.keys(next)) {
        if (!ids.has(key)) {
          delete next[key]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [spaces])

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

  // Move a tile to another space.
  const moveTileToSpace = useCallback(
    (paneId: string, targetIdx: number) => {
      const sp = store.get(spacesAtom)
      const curIdx = store.get(activeSpaceAtom)
      if (curIdx === targetIdx) return
      const next = moveLeafBetweenSpaces(sp, paneId, curIdx, targetIdx)
      store.set(spacesAtom, next)
      store.set(activeSpaceAtom, targetIdx)
      store.set(focusedIdAtom, paneId)
    },
    [store],
  )

  // ── Focus mode ──────────────────────────────────────────────────
  const focusState = useAtomValue(focusAtom)
  const setFocusState = useSetAtom(focusAtom)

  const toggleFocus = useCallback(
    (paneId?: string) => {
      const id = paneId ?? store.get(focusedIdAtom)
      if (!id) return

      const current = store.get(focusAtom)
      if (current) {
        // Exit focus: restore source space.
        const sp = store.get(spacesAtom)
        const srcIdx = current.sourceSpaceIndex
        const srcSpace = sp[srcIdx]
        if (!srcSpace) { setFocusState(null); return }

        // Restore source layout and re-insert the leaf.
        let restoredLayout = current.sourceLayoutSnapshot
        if (restoredLayout) {
          // Find a leaf in restored layout to split from.
          const restoredLeaves = leaves(restoredLayout)
          if (restoredLeaves.length > 0) {
            // Check if the leaf already exists in restored layout.
            const existingLeaf = findLeaf(restoredLayout, current.paneId)
            if (!existingLeaf) {
              // Re-insert using smart split.
              const splitFrom = restoredLeaves[0]
              const { next } = splitAtWithId(restoredLayout, splitFrom, 'horizontal', 'after')
              const newIds = leaves(next)
              const emptyLeaf = newIds.find((nid) => nid !== splitFrom)
              if (emptyLeaf) {
                const originalLeaf = findLeaf(sp[0]?.layout, current.paneId)
                if (originalLeaf?.type === 'leaf') {
                  let swapped = swapLeafIds(next, emptyLeaf, current.paneId)
                  swapped = setLeafType(swapped, current.paneId, originalLeaf.tileType ?? '', originalLeaf.initialPath, originalLeaf.params)
                  restoredLayout = swapped
                }
              }
            }
          }
        }

        // Update spaces: remove focus space (index 0), restore source.
        const nextSpaces = sp.filter((_, i) => i !== 0).map((s, i) => {
          // srcIdx was adjusted +1 when focus space was inserted, so original = srcIdx - 1.
          const originalIdx = srcIdx - 1
          if (i === originalIdx) return { ...s, layout: restoredLayout }
          return s
        })
        store.set(spacesAtom, nextSpaces)
        // activeSpace: original index = srcIdx - 1 (since focus space at 0 is removed).
        store.set(activeSpaceAtom, Math.max(0, srcIdx - 1))
        store.set(focusedIdAtom, current.paneId)
        setFocusState(null)
      } else {
        // Enter focus: move tile to focus space (index 0).
        const sp = store.get(spacesAtom)
        const curIdx = store.get(activeSpaceAtom)
        const curSpace = sp[curIdx]
        if (!curSpace?.layout) return

        const leaf = findLeaf(curSpace.layout, id)
        if (!leaf || leaf.type !== 'leaf') return

        // Snapshot source layout for restore.
        const sourceSnapshot = curSpace.layout

        // Remove from current space.
        const newCurLayout = closeAt(curSpace.layout, id)

        // Ensure focus space exists at index 0.
        let nextSpaces = [...sp]
        if (nextSpaces[0]?.name !== FOCUS_SPACE_NAME) {
          const focusSpace = createSpace(FOCUS_SPACE_NAME)
          focusSpace.layout = null
          nextSpaces = [focusSpace, ...nextSpaces]
          // Adjust indices: source was at curIdx, now at curIdx + 1.
        }
        const adjustedIdx = nextSpaces[0]?.name === FOCUS_SPACE_NAME ? curIdx + 1 : curIdx

        // Set focus space layout to just the focused leaf (full viewport).
        const focusLeaf = { ...leaf }
        nextSpaces[0] = { ...nextSpaces[0], layout: focusLeaf }

        // Update source space.
        if (newCurLayout) {
          nextSpaces[adjustedIdx] = { ...nextSpaces[adjustedIdx], layout: newCurLayout }
        } else {
          // Source space is now empty — add a placeholder leaf.
          nextSpaces[adjustedIdx] = { ...nextSpaces[adjustedIdx], layout: createLeaf() }
        }

        store.set(spacesAtom, nextSpaces)
        store.set(activeSpaceAtom, 0)
        store.set(focusedIdAtom, id)
        setFocusState({
          paneId: id,
          sourceSpaceIndex: adjustedIdx,
          sourceLayoutSnapshot: sourceSnapshot,
        })
      }
    },
    [store, setFocusState],
  )

  const openMenu = useCallback(() => {
    store.set(menuViewAtom, 'menu')
    store.set(menuOpenAtom, true)
  }, [store])
  const openShortcuts = useCallback(() => {
    store.set(menuViewAtom, 'shortcuts')
    store.set(menuOpenAtom, true)
  }, [store])

  // Per-tile font size setter: updates paneData for the active space.
  const setTileFontSize = useCallback(
    (id: string, fontSize: number) => {
      const spaces = store.get(spacesAtom)
      const idx = store.get(activeSpaceAtom)
      const space = spaces[idx]
      if (!space) return
      store.set(spacesAtom, spaces.map((s, i) => i === idx ? setPaneData(s, id, 'fontSize', fontSize) : s))
    },
    [store],
  )

  // Send font size to each iframe whenever the layout or paneData changes.
  // Font is stored in space.paneData[paneId], falling back to fontPreset
  // (the "new terminal default" from settings) for tiles with no explicit
  // font set.
  useEffect(() => {
    if (!layout) return
    const activeSpaceData = spaces[activeSpace]
    const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe[data-pane]')
    for (const iframe of iframes) {
      const paneId = iframe.getAttribute('data-pane')
      if (!paneId) continue
      const leaf = findLeaf(layout, paneId)
      if (leaf?.type !== 'leaf') continue
      const pane = activeSpaceData ? getPaneData<{ fontSize?: number; fontDefault?: number }>(activeSpaceData, paneId) : undefined
      const fontSize = pane?.fontSize ?? fontPreset
      const fontDefault = pane?.fontDefault ?? fontPreset
      iframe.contentWindow?.postMessage({ type: 'tile-font-size', fontSize, fontDefault }, '*')
    }
  }, [layout, fontPreset, spaces, activeSpace])

  // Keep a valid focused leaf (initial state, after close, after storage load).
  useEffect(() => {
    const ids = leaves(layout)
    if (ids.length === 0) return
    if (!focused || !ids.includes(focused)) setFocused(ids[0])
  }, [layout, focused, setFocused])

  // When switching spaces, ensure focused id is valid in the new space.
  useEffect(() => {
    const ids = leaves(layout)
    if (ids.length === 0) return
    if (focused && !ids.includes(focused)) setFocused(ids[0])
  }, [activeSpace])

  // Exit focus mode when switching spaces (e.g., clicking a space button).
  // We handle this by watching activeSpace changes and clearing focus state.
  const prevActiveSpaceRef = useRef(activeSpace)
  useEffect(() => {
    const current = store.get(focusAtom)
    if (current && activeSpace !== 0 && prevActiveSpaceRef.current === 0) {
      // User switched spaces while in focus mode — exit focus.
      const sp = store.get(spacesAtom)
      const srcIdx = current.sourceSpaceIndex

      // Remove focus space (index 0) and restore source layout.
      const nextSpaces = sp.filter((_, i) => i !== 0).map((s, i) => {
        const originalIdx = srcIdx - 1
        if (i === originalIdx) return { ...s, layout: current.sourceLayoutSnapshot }
        return s
      })
      store.set(spacesAtom, nextSpaces)
      // Set active space: user clicked on a space, so use the target space index.
      // The target is at the original index minus 1 (focus space removed).
      const targetIdx = Math.min(activeSpace - 1, nextSpaces.length - 1)
      store.set(activeSpaceAtom, Math.max(0, targetIdx))
      store.set(focusedIdAtom, current.paneId)
      setFocusState(null)
    }
    prevActiveSpaceRef.current = activeSpace
  }, [activeSpace, store, setFocusState])

  const wmHandlers = useMemo(
    () => ({ split, close, focusOffset, focusDirection, moveFocused, enterSwap, toggleFocus, openMenu, openShortcuts }),
    [split, close, focusOffset, focusDirection, moveFocused, enterSwap, toggleFocus, openMenu, openShortcuts],
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

  // Space switching: Ctrl+1-9, Ctrl+Tab, Ctrl+Shift+Tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      const sp = store.get(spacesAtom)
      const cur = store.get(activeSpaceAtom)

      // Ctrl+1..9 → switch to space N
      if (!e.shiftKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1
        if (idx < sp.length) {
          e.preventDefault()
          store.set(activeSpaceAtom, idx)
          store.set(focusedIdAtom, '')
        }
        return
      }

      // Ctrl+Tab → next space
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        store.set(activeSpaceAtom, cycleSpace(sp, cur, 1))
        store.set(focusedIdAtom, '')
        return
      }

      // Ctrl+Shift+Tab → prev space
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        store.set(activeSpaceAtom, cycleSpace(sp, cur, -1))
        store.set(focusedIdAtom, '')
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store])

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

  const { panes } = useMemo(
    () => computeTiling(layout, size.w, size.h),
    [layout, size.w, size.h],
  )

  // Compute tiling for all spaces (for rendering non-active spaces).
  const spaceTilings = useMemo(
    () => spaces.map((s) => computeTiling(s.layout, size.w, size.h)),
    [spaces, size.w, size.h],
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
      {spaces.map((space, si) => {
        const til = spaceTilings[si]
        const isActive = si === activeSpace
        return (
          <div
            key={space.id}
            className="absolute inset-0"
            style={{ display: isActive ? 'block' : 'none' }}
          >
            {isActive && !layout && (
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
            {til.panes.map(({ id, x, y, w, h }) => {
              const leaf = space.layout ? findLeaf(space.layout, id) : null
              const tileType = leaf?.type === 'leaf' ? leaf.tileType : undefined
              const pane = getPaneData<{ fontSize?: number; fontDefault?: number }>(space, id)
              const fontSize = pane?.fontSize ?? fontPreset
              const fontDefault = pane?.fontDefault ?? fontPreset
              const plugin = tileType ? getTilePlugin(tileType) : undefined
              const initialPath = leaf?.type === 'leaf' ? leaf.initialPath : undefined
              const params = leaf?.type === 'leaf' ? leaf.params : undefined

              return (
                <div
                  key={id}
                  className={`pane-anim pane-in absolute overflow-hidden rounded-[6px] border shadow-[0_8px_32px_rgb(0_0_0/0.25)] ${
                    isActive && focused === id
                      ? 'border-[color-mix(in_oklch,white_45%,var(--background))]'
                      : 'border-white/5'
                  }`}
                  style={{ left: x, top: y, width: w, height: h }}
                  onMouseDown={() => {
                    store.set(activeSpaceAtom, si)
                    setFocused(id)
                  }}
                >
                  {(plugin ?? getTilePlugin('empty'))?.render(id, { paneId: id, initialPath, onOpenPicker: setPickerPaneId, params })}
                  {isActive && (
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
                      isFocused={focusState?.paneId === id}
                      onToggleFocus={() => toggleFocus(id)}
                      spaces={spaces.map((s, i) => {
                        const tileIds = leaves(s.layout)
                        const tileLabels = tileIds.map((id) => {
                          const leaf = findLeaf(s.layout, id)
                          const tileType = leaf?.type === 'leaf' ? leaf.tileType : undefined
                          return tileType ? getTilePlugin(tileType)?.label ?? tileType : 'Empty'
                        })
                        return { index: i, name: s.name, label: String(i), tileCount: tileIds.length, tileLabels }
                      })}
                      activeSpaceIndex={activeSpace}
                      onMoveToSpace={moveTileToSpace}
                    />
                  )}
                </div>
              )
            })}
            {til.dividers.map((seg) => (
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
      })}
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
          onSelect={(tileType) => {
            if (tileType !== 'term') return
            const spaces = store.get(spacesAtom)
            const idx = store.get(activeSpaceAtom)
            const space = spaces[idx]
            if (space) {
              const existing = getPaneData<{ fontSize?: number }>(space, pickerPaneId)
              if (!existing?.fontSize) {
                store.set(spacesAtom, spaces.map((s: any, i: number) => i === idx ? setPaneData(s, pickerPaneId, 'fontSize', fontPreset) : s))
              }
            }
          }}
          onClose={() => setPickerPaneId(null)}
        />
      )}
    </div>
  )
}
