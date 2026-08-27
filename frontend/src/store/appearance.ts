import { atomWithStorage } from 'jotai/utils'

/** Curated monospace stacks offered in Settings (each ends in a mono fallback). */
export const FONT_FAMILIES = [
  { label: 'JetBrains Mono', value: `'JetBrains Mono', Menlo, Monaco, monospace` },
  { label: 'Menlo', value: `Menlo, Monaco, 'Courier New', monospace` },
  { label: 'Monaco', value: `Monaco, Menlo, 'Courier New', monospace` },
  { label: 'SF Mono', value: `'SF Mono', ui-monospace, Menlo, monospace` },
  { label: 'Cascadia Code', value: `'Cascadia Code', 'Courier New', monospace` },
  { label: 'Fira Code', value: `'Fira Code', 'Courier New', monospace` },
  { label: 'Courier New', value: `'Courier New', monospace` },
] as const

/** Default terminal font family stack. */
export const FONT_FAMILY_DEFAULT = FONT_FAMILIES[0].value

export interface TerminalTheme {
  /**
   * #RRGGBBAA — painted by the pane wrapper itself; the xterm grid stays
   * transparent so the color (alpha included) is composited exactly once.
   */
  background: string
  foreground: string
  cursor: string
}

/** Defaults matching the original hardcoded look (#1e1e1e at 80% opacity). */
export const TERMINAL_THEME_DEFAULT: TerminalTheme = {
  background: '#1e1e1ecc',
  foreground: '#d4d4d4ff',
  cursor: '#d4d4d4ff',
}

/**
 * Terminal appearance settings, shared across the parent page and every /term
 * pane iframe: each document runs these atomWithStorage atoms, and localStorage
 * storage events keep them in sync whenever any writer changes them (same
 * pattern as fontSizeAtom in store/fonts).
 */
export const fontFamilyAtom = atomWithStorage<string>('suwu.term-font-family', FONT_FAMILY_DEFAULT)

export const termThemeAtom = atomWithStorage<TerminalTheme>('suwu.term-theme', TERMINAL_THEME_DEFAULT)
