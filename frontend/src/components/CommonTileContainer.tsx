import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { atom, useAtomValue } from 'jotai'
import type { Atom } from 'jotai'
import { wmAction } from '../wm/shortcuts'
import { SESSION_STATE_KEY, type SessionStore } from '../wm/sessionState'
import { fileBrowserBgAtom } from '../store/appearance'
import { useHtmlZoom, tileZoomStyle } from './ZoomControls'

/** Default zoom atom (100%) used when the tile does not support zoom. */
const defaultZoomAtom = atom(1)

interface Props {
  paneId?: string
  /** Jotai atom that holds this tile's zoom level (e.g. fileBrowserZoomAtom). */
  zoomAtom?: Atom<number>
  /** Remove the default p-2 padding on the wrapper. */
  noPadding?: boolean
  children: React.ReactNode
}

interface TileSession {
  state: Record<string, unknown> | null
  /** True once the WM answered the state request (or the fallback elapsed). */
  ready: boolean
}

const TileSessionContext = createContext<TileSession>({ state: null, ready: false })

/**
 * Read the saved session state for the current tile (if any).
 * Returns null when no saved state exists for this pane.
 */
export function useTileSessionState<T = Record<string, unknown>>(): T | null {
  return useContext(TileSessionContext).state as T | null
}

/**
 * Returns a callback that posts a tile-state-update message to the parent
 * window manager, which persists it in localStorage for session restore.
 *
 * Updates are withheld until the WM has delivered this tile's saved state:
 * otherwise the mount-time defaults would clobber the very state we are about
 * to restore (the report effect runs before the request round-trips).
 */
export function useReportTileState(paneId?: string) {
  const { ready } = useContext(TileSessionContext)
  return useCallback((state: Record<string, unknown>) => {
    if (!ready) return
    const id = paneId ?? window.frameElement?.getAttribute('data-pane')
    if (!id) return
    window.parent?.postMessage({ type: 'tile-state-update', paneId: id, state }, '*')
  }, [paneId, ready])
}

/**
 * Common container for all tile iframe pages. Handles:
 * - Loading saved session state from the window manager (on mount, and after
 *   the WM recreates the iframe for a focus-mode / space switch)
 * - Providing it via TileSessionContext to children
 * - Applying HTML zoom and wrapper styling when a zoomAtom is provided
 * - Notifying the parent window manager when this pane gains focus
 * - Relaying WM keyboard shortcuts (Alt+arrows, etc.) to the parent
 */
export function CommonTileContainer({ paneId, zoomAtom, noPadding, children }: Props) {
  const zoom = useAtomValue(zoomAtom ?? defaultZoomAtom)
  const bgColor = useAtomValue(fileBrowserBgAtom)
  useHtmlZoom(zoom)
  const [session, setSession] = useState<TileSession>({ state: null, ready: false })

  // Ask the parent for this tile's saved state on mount, and also accept the
  // one-off server-started-at broadcast. The request is what restores a tile
  // whose iframe the WM recreated (focus mode, space switch): by then the
  // broadcast already fired, so waiting for it alone would leave the tile on
  // its empty/picker state.
  useEffect(() => {
    const id = paneId ?? window.frameElement?.getAttribute('data-pane')
    if (!id) return

    const onMsg = (e: MessageEvent) => {
      const d = e.data as {
        type?: string
        startedAt?: string
        state?: Record<string, unknown> | null
      } | undefined
      if (d?.type === 'tile-session-state') {
        // Authoritative: the WM's in-memory state is at least as fresh as
        // localStorage (which it writes on a debounce).
        setSession({ state: d.state ?? null, ready: true })
        return
      }
      if (d?.type === 'server-started-at' && typeof d.startedAt === 'string') {
        // Fallback for a WM that does not answer state requests: read the
        // persisted map, but never override a delivered state.
        let state: Record<string, unknown> | null = null
        try {
          const raw = localStorage.getItem(SESSION_STATE_KEY)
          if (raw) {
            const store: SessionStore = JSON.parse(raw)
            state = store[d.startedAt]?.[id]?.state ?? null
          }
        } catch {
          // ignore
        }
        setSession((prev) => (prev.ready ? prev : { state, ready: true }))
      }
    }
    window.addEventListener('message', onMsg)
    // Registered after the listener above, so the reply cannot arrive early.
    window.parent?.postMessage({ type: 'request-session-state', paneId: id }, '*')
    // Fallback: if the WM never answers (standalone page, older parent), stop
    // withholding reports after a beat instead of dropping them forever.
    const fallback = setTimeout(() => {
      setSession((prev) => (prev.ready ? prev : { ...prev, ready: true }))
    }, 300)
    return () => {
      window.removeEventListener('message', onMsg)
      clearTimeout(fallback)
    }
  }, [paneId])

  // Notify parent when this iframe gains focus.
  useEffect(() => {
    const onFocus = () => {
      const id = paneId ?? window.frameElement?.getAttribute('data-pane')
      if (id) {
        window.parent?.postMessage({ type: 'pane-focus', pane: id }, '*')
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [paneId])

  // Relay WM keyboard shortcuts to parent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = wmAction(e)
      if (!a) return
      e.preventDefault()
      e.stopPropagation()
      window.parent?.postMessage({ type: 'wm-shortcut', action: a }, '*')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <TileSessionContext.Provider value={session}>
      <div className={`flex flex-col rounded-[6px] text-white/80 ${noPadding ? '' : 'p-2'}`} style={{ ...tileZoomStyle(zoom), backgroundColor: bgColor }}>
        {children}
      </div>
    </TileSessionContext.Provider>
  )
}
