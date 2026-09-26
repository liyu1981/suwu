import type { Direction, MoveDir } from './layout';

export type WmAction =
  | 'split-right'
  | 'split-below'
  | 'close'
  | 'focus-next'
  | 'focus-prev'
  | 'focus-left'
  | 'focus-right'
  | 'focus-up'
  | 'focus-down'
  | 'swap'
  | 'focus-toggle'
  | 'toggle-spaces'
  | 'logout'
  | 'menu'
  | 'shortcuts';

/** Handlers the window manager provides for each action. */
export interface WmActionHandlers {
  split: (d: Direction) => void;
  close: () => void;
  focusOffset: (o: number) => void;
  focusDirection: (d: MoveDir) => void;
  enterSwap: () => void;
  toggleFocus: () => void;
  toggleSpaces: () => void;
  logout: () => void;
  openMenu: () => void;
  openShortcuts: () => void;
}

/** Dispatches a window-manager action to its handler. */
export function applyWmAction(name: WmAction, h: WmActionHandlers): void {
  switch (name) {
    case 'split-right':
      h.split('horizontal');
      break;
    case 'split-below':
      h.split('vertical');
      break;
    case 'close':
      h.close();
      break;
    case 'focus-next':
      h.focusOffset(1);
      break;
    case 'focus-prev':
      h.focusOffset(-1);
      break;
    case 'focus-left':
      h.focusDirection('left');
      break;
    case 'focus-right':
      h.focusDirection('right');
      break;
    case 'focus-up':
      h.focusDirection('up');
      break;
    case 'focus-down':
      h.focusDirection('down');
      break;
    case 'swap':
      h.enterSwap();
      break;
    case 'focus-toggle':
      h.toggleFocus();
      break;
    case 'toggle-spaces':
      h.toggleSpaces();
      break;
    case 'logout':
      h.logout();
      break;
    case 'menu':
      h.openMenu();
      break;
    case 'shortcuts':
      h.openShortcuts();
      break;
  }
}

/**
 * Maps a keydown event to a window-manager action, or null.
 * These shortcuts are chosen to not clash with common shell/readline
 * bindings, and are handled both on the parent window and relayed from
 * focused terminal iframes (via postMessage).
 */
export function wmAction(e: KeyboardEvent): WmAction | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  switch (e.key) {
    case 'Enter':
      return e.shiftKey ? 'split-below' : 'split-right';
    case 'q':
    case 'Q':
      return 'close';
    case 'j':
    case 'J':
      return 'focus-next';
    case 'k':
    case 'K':
      return 'focus-prev';
    case 'ArrowLeft':
      return e.shiftKey ? null : 'focus-left';
    case 'ArrowRight':
      return e.shiftKey ? null : 'focus-right';
    case 'ArrowUp':
      return e.shiftKey ? null : 'focus-up';
    case 'ArrowDown':
      return e.shiftKey ? null : 'focus-down';
    case 's':
    case 'S':
      return 'swap';
    case 'f':
    case 'F':
      return 'focus-toggle';
    case 'l':
    case 'L':
      // Alt+Shift+L logs out; Alt+L toggles the spaces.
      return e.shiftKey ? 'logout' : 'toggle-spaces';
    case '/':
    case '?': // Shift+/ produces '?' on most layouts
      return e.shiftKey ? 'shortcuts' : 'menu';
    default:
      return null;
  }
}
