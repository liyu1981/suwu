import { atom, useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useRef } from 'react';
import { toolbarSuspensionSecondsAtom } from '../store/settings';
import { isDoubleShift, suspensionMs } from './toolbarSuspension';

/**
 * State and wiring for suspending the per-tile hover toolbar. The pure contract
 * lives in ./toolbarSuspension.ts so it can be checked without a DOM.
 */

/** Is the pointer currently inside some tile's tool corner? */
export const toolbarHoveredAtom = atom(false);

/** Timestamp (ms) until which the toolbar stays hidden; 0 = not suspended. */
export const toolbarSuspendedUntilAtom = atom(0);

/**
 * Installs the double-tap-Shift gesture. Mount once (TilingWM), not per tile.
 *
 * The gesture only arms while a tool corner is hovered — otherwise a fast
 * Shift-Shift while typing would hide a toolbar the user was not reaching for.
 */
export function useToolbarSuspensionGesture(): void {
  const seconds = useAtomValue(toolbarSuspensionSecondsAtom);
  const hovered = useAtomValue(toolbarHoveredAtom);
  const setUntil = useSetAtom(toolbarSuspendedUntilAtom);
  const lastPress = useRef(0);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' || e.repeat) return;
      const now = performance.now();
      const double = isDoubleShift(lastPress.current, now);
      lastPress.current = now;
      if (!double) return;
      // Reset so a third press does not re-trigger immediately.
      lastPress.current = 0;
      const ms = suspensionMs(seconds);
      if (ms === 0) return;
      // Only when the toolbar is actually showing over the tile's corner.
      if (!hovered) return;
      setUntil(Date.now() + ms);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [hovered, seconds, setUntil]);
}

/**
 * True while the toolbar is suspended. Schedules the expiry so every tile
 * re-renders the moment the suspension ends, instead of waiting for a mouse move.
 */
export function useToolbarSuspended(): boolean {
  const until = useAtomValue(toolbarSuspendedUntilAtom);
  const setUntil = useSetAtom(toolbarSuspendedUntilAtom);
  const remaining = until - Date.now();
  const suspended = remaining > 0;

  useEffect(() => {
    if (!suspended) return;
    const timer = window.setTimeout(() => setUntil(0), remaining);
    return () => window.clearTimeout(timer);
  }, [suspended, remaining, setUntil]);

  return suspended;
}
