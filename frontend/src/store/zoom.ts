import { atomWithStorage } from 'jotai/utils'

/**
 * Per-plugin iframe HTML zoom level.
 *
 * Value is a multiplier: 1 = 100%, 5 = 500%. Applied to the iframe document
 * via document.documentElement.style.zoom. Each plugin has its own atom so the
 * same plugin type stays in sync across every pane (localStorage storage
 * events keep each iframe's atom up to date, like fileBrowserBgAtom).
 */

/** Bounds for the zoom level. */
export const ZOOM_MIN = 1      // 100%
export const ZOOM_MAX = 5      // 500%
export const ZOOM_STEP = 0.25  // 25% steps

/** Zoom used before anything is persisted. */
export const ZOOM_DEFAULT = 1

export const fileBrowserZoomAtom = atomWithStorage<number>('suwu.filebrowser-zoom', ZOOM_DEFAULT)
export const dropboxZoomAtom = atomWithStorage<number>('suwu.dropbox-zoom', ZOOM_DEFAULT)
export const forwardZoomAtom = atomWithStorage<number>('suwu.forward-zoom', ZOOM_DEFAULT)
export const gitGraphZoomAtom = atomWithStorage<number>('suwu.gitgraph-zoom', ZOOM_DEFAULT)

export function clampZoom(n: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n * 4) / 4))
}