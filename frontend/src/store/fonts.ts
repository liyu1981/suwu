import { atomWithStorage } from 'jotai/utils'

/** Bounds for the terminal font size (px). */
export const FONT_MIN = 8
export const FONT_MAX = 28

/** Font size used before anything is persisted. */
export const FONT_DEFAULT = 14

/** Bounds for terminal line height (multiplier). */
export const LINE_HEIGHT_MIN = 1.0
export const LINE_HEIGHT_MAX = 2.0
export const LINE_HEIGHT_STEP = 0.1

/** Line height used before anything is persisted. */
export const LINE_HEIGHT_DEFAULT = 1.2

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

/**
 * Active terminal line height, shared across the parent page and every /term
 * pane iframe via localStorage sync (same pattern as fontSizeAtom).
 */
export const lineHeightAtom = atomWithStorage<number>('suwu.term-line-height', LINE_HEIGHT_DEFAULT)

/**
 * Persisted default, used by new sessions and the Reset action.
 */
export const lineHeightDefaultAtom = atomWithStorage<number>('suwu.term-line-height-default', LINE_HEIGHT_DEFAULT)

export function clampLineHeight(n: number): number {
  return Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, Math.round(n * 10) / 10))
}
