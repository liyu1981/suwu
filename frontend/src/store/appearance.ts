import { atomWithStorage } from 'jotai/utils'
import type { ITheme } from '@xterm/xterm'

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

/**
 * Full terminal theme — maps to xterm.js ITheme plus a background with alpha
 * channel for the pane wrapper compositing.
 *
 * All color strings are `#RRGGBB`. Background carries the alpha as the last
 * two hex digits (`#RRGGBBAA`) because the pane wrapper paints it directly;
 * all other colors are opaque (xterm doesn't support alpha on ANSI colors).
 */
export interface TerminalTheme {
  // ── Core ──────────────────────────────────────────────────────────
  /** #RRGGBBAA — pane wrapper background; xterm grid stays transparent. */
  background: string
  foreground: string
  cursor: string
  /** Accent color for block cursors (fg color inside the block). */
  cursorAccent: string

  // ── Selection ─────────────────────────────────────────────────────
  selectionBackground: string
  selectionForeground: string

  // ── ANSI 16-color palette ─────────────────────────────────────────
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/** Defaults matching the Suwu preset (#1e1e1e at 80% opacity, neutral grays). */
export const TERMINAL_THEME_DEFAULT: TerminalTheme = {
  background: '#1e1e1ecc',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#000000',

  selectionBackground: '#264f78',
  selectionForeground: '#ffffff',

  black: '#1e1e1e',
  red: '#f44747',
  green: '#6a9955',
  yellow: '#dcdcaa',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#808080',
  brightRed: '#f44747',
  brightGreen: '#6a9955',
  brightYellow: '#dcdcaa',
  brightBlue: '#569cd6',
  brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0',
  brightWhite: '#ffffff',
}

/**
 * Converts a TerminalTheme to an xterm.js ITheme.
 *
 * xterm accepts `#RRGGBB` or `rgba(...)` for most properties. The background
 * is passed through as-is (with alpha) so the transparent grid composites
 * correctly against the pane wrapper. Selection/ANSI colors are stripped to
 * 6-digit hex since xterm doesn't use alpha on those.
 */
export function themeToXtermTheme(t: TerminalTheme): ITheme {
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selectionBackground,
    selectionForeground: t.selectionForeground,
    black: t.black,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.blue,
    magenta: t.magenta,
    cyan: t.cyan,
    white: t.white,
    brightBlack: t.brightBlack,
    brightRed: t.brightRed,
    brightGreen: t.brightGreen,
    brightYellow: t.brightYellow,
    brightBlue: t.brightBlue,
    brightMagenta: t.brightMagenta,
    brightCyan: t.brightCyan,
    brightWhite: t.brightWhite,
  }
}

/**
 * Terminal appearance settings, shared across the parent page and every /term
 * pane iframe: each document runs these atomWithStorage atoms, and localStorage
 * storage events keep them in sync whenever any writer changes them (same
 * pattern as fontSizeAtom in store/fonts).
 */
export const fontFamilyAtom = atomWithStorage<string>('suwu.term-font-family', FONT_FAMILY_DEFAULT)

export const termThemeAtom = atomWithStorage<TerminalTheme>('suwu.term-theme', TERMINAL_THEME_DEFAULT)

/** Default file browser background (#1e1e1e at 80% opacity, matching terminal). */
export const FILE_BROWSER_BG_DEFAULT = '#1e1e1ecc'

/**
 * File browser background color, shared across every /filebrowser pane iframe.
 * Uses the same atomWithStorage + localStorage sync pattern as terminal theme.
 */
export const fileBrowserBgAtom = atomWithStorage<string>('suwu.filebrowser-bg', FILE_BROWSER_BG_DEFAULT)
