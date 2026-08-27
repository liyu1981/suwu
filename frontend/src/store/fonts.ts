import { atomWithStorage } from 'jotai/utils'

/** Bounds for the terminal font size (px). */
export const FONT_MIN = 8
export const FONT_MAX = 28

/** Font size used before anything is persisted. */
export const FONT_DEFAULT = 14

/**
 * Active terminal font size, shared across the parent page and every /term
 * pane iframe: each document runs this atomWithStorage, and localStorage
 * storage events keep them in sync whenever any writer changes it.
 */
export const fontSizeAtom = atomWithStorage<number>('suwu.term-font-size', FONT_DEFAULT)

/**
 * Persisted default, used by new sessions and the Reset action. Changed only
 * through the Settings dialog.
 */
export const fontDefaultAtom = atomWithStorage<number>('suwu.term-font-default', FONT_DEFAULT)

export function clampFont(n: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)))
}
