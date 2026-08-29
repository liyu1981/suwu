import { layoutAtom, focusedIdAtom } from '../wm/atoms'
import { splitAndFocus, setLeafType, setLeafInitialPath, computeTiling } from '../wm/layout'
import { FONT_DEFAULT } from '../store/fonts'
import type { NotificationData } from '../store/notifications'
import type { AutoResolveSettings } from '../store/settings'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Store = { get: (atom: any) => any; set: (atom: any, value: any) => void }

/**
 * Determine the best split direction and side based on the focused tile's
 * dimensions. If the tile is wider than tall, split right; if taller, split
 * down. Falls back to split right when there's no focused tile.
 */
function resolveSplit(store: Store): { direction: 'horizontal' | 'vertical'; side: 'before' | 'after' } {
  const root = store.get(layoutAtom)
  const focused = store.get(focusedIdAtom)

  if (!root || !focused) {
    return { direction: 'horizontal', side: 'after' }
  }

  // Get viewport dimensions from the tiling container.
  const viewport = document.querySelector('[data-tiling-viewport]')
  const vw = viewport?.clientWidth || window.innerWidth
  const vh = viewport?.clientHeight || window.innerHeight

  if (vw <= 0 || vh <= 0) {
    return { direction: 'horizontal', side: 'after' }
  }

  const { panes } = computeTiling(root, vw, vh)
  const pane = panes.find((p) => p.id === focused)
  if (!pane) {
    return { direction: 'horizontal', side: 'after' }
  }

  if (pane.w >= pane.h) {
    // Wider than tall → split right (new tile after focused)
    return { direction: 'horizontal', side: 'after' }
  }
  // Taller than wide → split down (new tile after focused)
  return { direction: 'vertical', side: 'after' }
}

function doSplit(store: Store): string | null {
  const root = store.get(layoutAtom)
  if (!root) {
    // Empty layout: create first tile.
    const focused = store.get(focusedIdAtom)
    const { next, focus } = splitAndFocus(root, focused, 'horizontal', 'after')
    store.set(layoutAtom, next)
    return focus
  }
  const { direction, side } = resolveSplit(store)
  const focused = store.get(focusedIdAtom)
  const { next, focus } = splitAndFocus(root, focused, direction, side)
  store.set(layoutAtom, next)
  return focus
}

function setTypeAndFocus(store: Store, leafId: string, tileType: string): void {
  const root = store.get(layoutAtom)
  if (!root) return
  const withType = setLeafType(root, leafId, tileType, FONT_DEFAULT, FONT_DEFAULT)
  store.set(layoutAtom, withType)
  store.set(focusedIdAtom, leafId)
}

/**
 * Open a file browser tile navigated to the given directory path.
 */
export function openFileBrowser(path: string, store: Store): string | null {
  const leafId = doSplit(store)
  if (!leafId) return null
  setTypeAndFocus(store, leafId, 'filebrowser')
  // Set initialPath directly on the leaf node — no separate atom needed.
  const root = store.get(layoutAtom)
  if (root) store.set(layoutAtom, setLeafInitialPath(root, leafId, path))
  return leafId
}

/**
 * Open a viewer tile showing the given file path.
 */
export function openViewer(path: string, store: Store): string | null {
  const leafId = doSplit(store)
  if (!leafId) return null
  setTypeAndFocus(store, leafId, 'viewer')
  // Set initialPath directly on the leaf node — no separate atom needed.
  const root = store.get(layoutAtom)
  if (root) store.set(layoutAtom, setLeafInitialPath(root, leafId, path))
  return leafId
}

/**
 * Resolve an action from a notification. Returns true if auto-resolved,
 * false if it should show as an action button in the notification panel.
 */
export function resolveAction(
  data: NotificationData,
  store: Store,
  autoResolve: AutoResolveSettings,
): boolean {
  const { type, path } = data.payload

  if (type === 'dir' && autoResolve.filebrowser) {
    openFileBrowser(path, store)
    return true
  }
  if (type === 'file' && autoResolve.viewer) {
    openViewer(path, store)
    return true
  }
  return false
}

/**
 * Execute an action for a notification (called from action button click).
 */
export function executeAction(
  data: NotificationData,
  store: Store,
): void {
  const { type, path } = data.payload
  if (type === 'dir') {
    openFileBrowser(path, store)
  } else {
    openViewer(path, store)
  }
}
