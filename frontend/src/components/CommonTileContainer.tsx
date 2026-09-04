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

const TileSessionContext = createContext<Record<string, unknown> | null>(null)

/**
 * Read the saved session state for the current tile (if any).
 * Returns null when no saved state exists for this pane.
 */
export function useTileSessionState<T = Record<string, unknown>>(): T | null {
  return useContext(TileSessionContext) as T | null
}

/**
 * Returns a callback that posts a tile-state-update message to the parent
 * window manager, which persists it in localStorage for session restore.
 */
export function useReportTileState(paneId?: string) {
  return useCallback((state: Record<string, unknown>) => {
    const id = paneId ?? window.frameElement?.getAttribute('data-pane')
    if (!id) return
    window.parent?.postMessage({ type: 'tile-state-update', paneId: id, state }, '*')
  }, [paneId])
}

/**
 * Common container for all tile iframe pages. Handles:
 * - Loading saved session state from localStorage (keyed by server startedAt)
 * - Providing it via TileSessionContext to children
 * - Applying HTML zoom and wrapper styling when a zoomAtom is provided
 * - Notifying the parent window manager when this pane gains focus
 * - Relaying WM keyboard shortcuts (Alt+arrows, etc.) to the parent
 */
export function CommonTileContainer({ paneId, zoomAtom, noPadding, children }: Props) {
  const zoom = useAtomValue(zoomAtom ?? defaultZoomAtom)
  const bgColor = useAtomValue(fileBrowserBgAtom)
  useHtmlZoom(zoom)
  const [savedState, setSavedState] = useState<Record<string, unknown> | null>(null)

  // Listen for startedAt from parent TilingWM, then load saved state.
  useEffect(() => {
    const id = paneId ?? window.frameElement?.getAttribute('data-pane')
    if (!id) return

    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; startedAt?: string } | undefined
      if (d?.type === 'server-started-at' && typeof d.startedAt === 'string') {
        try {
          const raw = localStorage.getItem(SESSION_STATE_KEY)
          if (!raw) return
          const store: SessionStore = JSON.parse(raw)
          const state = store[d.startedAt]?.[id]?.state ?? null
          setSavedState(state)
        } catch {
          // ignore
        }
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
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
    <TileSessionContext.Provider value={savedState}>
      <div className={`flex flex-col rounded-[6px] text-sm text-white/80 ${noPadding ? '' : 'p-2'}`} style={{ ...tileZoomStyle(zoom), backgroundColor: bgColor }}>
        {children}
      </div>
    </TileSessionContext.Provider>
  )
}
