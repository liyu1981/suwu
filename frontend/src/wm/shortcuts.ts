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
