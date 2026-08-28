import type { Direction, MoveDir } from './layout'

export type WmAction =
  | 'split-right'
  | 'split-below'
  | 'close'
  | 'focus-next'
  | 'focus-prev'
  | 'move-left'
  | 'move-right'
  | 'move-up'
  | 'move-down'
  | 'menu'
  | 'shortcuts'

/** Handlers the window manager provides for each action. */
export interface WmActionHandlers {
  split: (d: Direction) => void
  close: () => void
  focusOffset: (o: number) => void
  moveFocused: (d: MoveDir) => void
  openMenu: () => void
  openShortcuts: () => void
}

/** Dispatches a window-manager action to its handler. */
export function applyWmAction(name: WmAction, h: WmActionHandlers): void {
  switch (name) {
    case 'split-right':
      h.split('horizontal')
      break
    case 'split-below':
      h.split('vertical')
      break
    case 'close':
      h.close()
      break
    case 'focus-next':
      h.focusOffset(1)
      break
    case 'focus-prev':
      h.focusOffset(-1)
      break
    case 'move-left':
      h.moveFocused('left')
      break
    case 'move-right':
      h.moveFocused('right')
      break
    case 'move-up':
      h.moveFocused('up')
      break
    case 'move-down':
      h.moveFocused('down')
      break
    case 'menu':
      h.openMenu()
      break
    case 'shortcuts':
      h.openShortcuts()
      break
  }
}

/**
 * Maps a keydown event to a window-manager action, or null.
 * These shortcuts are chosen to not clash with common shell/readline
 * bindings, and are handled both on the parent window and relayed from
 * focused terminal iframes (via postMessage).
 */
export function wmAction(e: KeyboardEvent): WmAction | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null
  switch (e.key) {
    case 'Enter':
      return e.shiftKey ? 'split-below' : 'split-right'
    case 'q':
    case 'Q':
      return 'close'
    case 'j':
    case 'J':
      return 'focus-next'
    case 'k':
    case 'K':
      return 'focus-prev'
    case 'ArrowLeft':
      return 'move-left'
    case 'ArrowRight':
      return 'move-right'
    case 'ArrowUp':
      return 'move-up'
    case 'ArrowDown':
      return 'move-down'
    case '/':
    case '?': // Shift+/ produces '?' on most layouts
      return e.shiftKey ? 'shortcuts' : 'menu'
    default:
      return null
  }
}
