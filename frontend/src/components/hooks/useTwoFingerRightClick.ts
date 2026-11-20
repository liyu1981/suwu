/**
 * Two-finger tap → right click, for the mobile shell.
 *
 * A phone has no right button, which puts every context menu in the app out of
 * reach: the file browser's row menu, SFTP file actions, git graph's repo tabs and
 * commits. A two-finger tap is the closest thing a touch screen has to a right
 * click — it is stationary (so it cannot be confused with pinch-zoom, which needs
 * movement), it does not conflict with iOS's long-press callout or text selection,
 * and the shell can keep it to itself.
 *
 * The detector lives *inside each tile document*, not in the shell: touch events in
 * an iframe never bubble to the parent, and an overlay would swallow the
 * interaction it is supposed to augment. `CommonTileContainer` is rendered exactly
 * once by every tile page, which makes it the one place to install it.
 *
 * What it synthesises is a plain `contextmenu` MouseEvent at the midpoint of the
 * two fingers. Every existing menu already opens from that event and reads
 * `clientX`/`clientY`, so no menu code had to change — including the terminal,
 * where the event is simply what a right click would deliver.
 */
import { useEffect } from 'react';
import { TWO_FINGER_MAX_DRIFT_PX, isTwoFingerTap } from '../../lib/twoFinger';
import { hostedByMobileShell } from '../../lib/mobile';

/** The element a right click at this point would land on, in this document. */
function elementAt(x: number, y: number): Element | null {
  return document.elementFromPoint(x, y);
}

/**
 * Dispatch a right-button `contextmenu` at a point, as a mouse would.
 *
 * `button`/`buttons` are set so handlers that distinguish buttons behave the same
 * as with a real right click; `cancelable` lets them suppress the native menu.
 */
export function dispatchContextMenuAt(x: number, y: number): boolean {
  const target = elementAt(x, y);
  if (!target) return false;
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: 2,
    buttons: 2,
  });
  target.dispatchEvent(event);
  return true;
}

interface Tracked {
  id: number;
  x: number;
  y: number;
}

/**
 * Install the gesture on this document. Returns a cleanup function.
 *
 * Kept as a plain function (rather than inline in the hook) so it can be reasoned
 * about and exercised without React.
 */
export function installTwoFingerRightClick(): () => void {
  let tracked: Tracked[] | null = null;
  let startedAt = 0;
  let drift = 0;
  let cancelled = false;

  const midpoint = (points: Tracked[]) => ({
    x: (points[0].x + points[1].x) / 2,
    y: (points[0].y + points[1].y) / 2,
  });

  const onStart = (e: TouchEvent) => {
    // Three or more fingers is a system gesture, not a right click.
    if (e.touches.length > 2) {
      tracked = null;
      cancelled = true;
      return;
    }
    if (e.touches.length !== 2) return;
    tracked = Array.from(e.touches).map((t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));
    startedAt = e.timeStamp || performance.now();
    drift = 0;
    cancelled = false;
  };

  const onMove = (e: TouchEvent) => {
    if (!tracked || cancelled) return;
    const points = tracked;
    drift = Array.from(e.touches).reduce((worst, touch) => {
      const start = points.find((t) => t.id === touch.identifier);
      if (!start) return worst;
      return Math.max(worst, Math.hypot(touch.clientX - start.x, touch.clientY - start.y));
    }, drift);
    // Any real movement is a pinch or a two-finger scroll: leave it alone.
    if (drift > TWO_FINGER_MAX_DRIFT_PX) cancelled = true;
  };

  const onEnd = (e: TouchEvent) => {
    // Wait for the last finger: a tap ends when the screen is free of them.
    if (!tracked || e.touches.length > 0) return;
    const points = tracked;
    const wasCancelled = cancelled;
    const duration = (e.timeStamp || performance.now()) - startedAt;
    const { x, y } = midpoint(points);
    tracked = null;
    cancelled = false;
    if (!wasCancelled && isTwoFingerTap(duration, drift)) dispatchContextMenuAt(x, y);
  };

  const onCancel = () => {
    tracked = null;
    cancelled = false;
  };

  const options: AddEventListenerOptions = { capture: true, passive: true };
  document.addEventListener('touchstart', onStart, options);
  document.addEventListener('touchmove', onMove, options);
  document.addEventListener('touchend', onEnd, options);
  document.addEventListener('touchcancel', onCancel, options);

  return () => {
    document.removeEventListener('touchstart', onStart, options);
    document.removeEventListener('touchmove', onMove, options);
    document.removeEventListener('touchend', onEnd, options);
    document.removeEventListener('touchcancel', onCancel, options);
  };
}

/**
 * Install the gesture once per tile document, and only under `/mobile`.
 *
 * The dataset guard keeps two mounted containers (a panel nested inside a route
 * wrapper, or React's development double effect) from installing two listeners,
 * which would open every menu twice.
 */
export function useTwoFingerRightClick(): void {
  useEffect(() => {
    if (!hostedByMobileShell()) return;
    const root = document.documentElement;
    if (root.dataset.suwuTwoFinger === '1') return;
    root.dataset.suwuTwoFinger = '1';
    const uninstall = installTwoFingerRightClick();
    return () => {
      uninstall();
      delete root.dataset.suwuTwoFinger;
    };
  }, []);
}
