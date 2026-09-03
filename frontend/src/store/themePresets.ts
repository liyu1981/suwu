import type { TerminalTheme } from './appearance'

export interface ThemePreset {
  id: string
  name: string
  theme: TerminalTheme
}

/** Shared opacity suffix for dark backgrounds — presets store opaque RGB,
 *  the global opacity slider applies alpha at runtime. */
const A = (hex: string) => hex + 'ff'

export const THEME_PRESETS: ThemePreset[] = [
  // ── Classic (Suwu default) ────────────────────────────────────────
  {
    id: 'classic',
    name: 'Classic',
    theme: {
      background: '#1e1e1ecc',
      foreground: '#d4d4d4',
      cursor: '#d4d4d4',
      cursorAccent: '#000000',
      selectionBackground: '#264f78',
      selectionForeground: '#ffffff',
      black: '#1e1e1e', red: '#f44747', green: '#6a9955', yellow: '#dcdcaa',
      blue: '#569cd6', magenta: '#c586c0', cyan: '#4ec9b0', white: '#d4d4d4',
      brightBlack: '#808080', brightRed: '#f44747', brightGreen: '#6a9955',
      brightYellow: '#dcdcaa', brightBlue: '#569cd6', brightMagenta: '#c586c0',
      brightCyan: '#4ec9b0', brightWhite: '#ffffff',
    },
  },

  // ── Dracula ───────────────────────────────────────────────────────
  {
    id: 'dracula',
    name: 'Dracula',
    theme: {
      background: A('#282a36'),
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      selectionForeground: '#f8f8f2',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
      brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
      brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },

  // ── Nord ──────────────────────────────────────────────────────────
  {
    id: 'nord',
    name: 'Nord',
    theme: {
      background: A('#2e3440'),
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: '#434c5e',
      selectionForeground: '#d8dee9',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },

  // ── Solarized Dark ────────────────────────────────────────────────
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    theme: {
      background: A('#002b36'),
      foreground: '#839496',
      cursor: '#839496',
      cursorAccent: '#002b36',
      selectionBackground: '#073642',
      selectionForeground: '#93a1a1',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75',
      brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },

  // ── Solarized Light ───────────────────────────────────────────────
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    theme: {
      background: A('#fdf6e3'),
      foreground: '#657b83',
      cursor: '#657b83',
      cursorAccent: '#fdf6e3',
      selectionBackground: '#eee8d5',
      selectionForeground: '#586e75',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75',
      brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },

  // ── Monokai Pro ───────────────────────────────────────────────────
  {
    id: 'monokai-pro',
    name: 'Monokai Pro',
    theme: {
      background: A('#2d2a2e'),
      foreground: '#fcfcfa',
      cursor: '#fcfcfa',
      cursorAccent: '#2d2a2e',
      selectionBackground: '#403e41',
      selectionForeground: '#fcfcfa',
      black: '#403e41', red: '#ff6188', green: '#a9dc76', yellow: '#ffd866',
      blue: '#78dce8', magenta: '#ab9df2', cyan: '#a9dc76', white: '#fcfcfa',
      brightBlack: '#727072', brightRed: '#ff6188', brightGreen: '#a9dc76',
      brightYellow: '#ffd866', brightBlue: '#78dce8', brightMagenta: '#ab9df2',
      brightCyan: '#78dce8', brightWhite: '#fcfcfa',
    },
  },

  // ── Gruvbox Dark ──────────────────────────────────────────────────
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    theme: {
      background: A('#282828'),
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: '#504945',
      selectionForeground: '#ebdbb2',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26',
      brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b',
      brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
  },

  // ── Catppuccin Mocha ──────────────────────────────────────────────
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    theme: {
      background: A('#1e1e2e'),
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      selectionBackground: '#45475a',
      selectionForeground: '#cdd6f4',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
  },

  // ── Tokyo Night ───────────────────────────────────────────────────
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    theme: {
      background: A('#1a1b26'),
      foreground: '#a9b1d6',
      cursor: '#c0caf5',
      cursorAccent: '#1a1b26',
      selectionBackground: '#33467c',
      selectionForeground: '#c0caf5',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a',
      brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
  },

  // ── One Dark ──────────────────────────────────────────────────────
  {
    id: 'one-dark',
    name: 'One Dark',
    theme: {
      background: A('#282c34'),
      foreground: '#abb2bf',
      cursor: '#528bff',
      cursorAccent: '#282c34',
      selectionBackground: '#3e4451',
      selectionForeground: '#abb2bf',
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
      brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
      brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
  },

  // ── Rosé Pine ─────────────────────────────────────────────────────
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    theme: {
      background: A('#191724'),
      foreground: '#e0def4',
      cursor: '#e0def4',
      cursorAccent: '#191724',
      selectionBackground: '#2a283e',
      selectionForeground: '#e0def4',
      black: '#26233a', red: '#eb6f92', green: '#31748f', yellow: '#f6c177',
      blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
      brightBlack: '#6e6a86', brightRed: '#eb6f92', brightGreen: '#31748f',
      brightYellow: '#f6c177', brightBlue: '#9ccfd8', brightMagenta: '#c4a7e7',
      brightCyan: '#ebbcba', brightWhite: '#e0def4',
    },
  },
]

/**
 * Matches a TerminalTheme against the preset catalog. Returns the preset id
 * if the theme's core colors (bg RGB, fg, cursor) match a preset, or null
 * for a custom theme. Used to highlight the active preset in the dropdown.
 */
export function matchPresetId(theme: TerminalTheme): string | null {
  for (const preset of THEME_PRESETS) {
    const p = preset.theme
    if (
      theme.background.slice(0, 7) === p.background.slice(0, 7) &&
      theme.foreground === p.foreground &&
      theme.cursor === p.cursor &&
      theme.cursorAccent === p.cursorAccent
    ) {
      return preset.id
    }
  }
  return null
}
