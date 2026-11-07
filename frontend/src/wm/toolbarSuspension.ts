/**
 * Suspending the per-tile hover toolbar — the pure contract.
 *
 * The toolbar's zone covers the tile's top-right corner (224×48), which is also
 * where an extension may want to put controls. Holding a modifier was the first
 * idea and it was wrong: it fights every other Shift gesture, and the key is
 * usually pressed while focus is inside the tile's iframe, where this document
 * never sees it.
 *
 * The contract now: while the toolbar is showing, double-tap Shift and it
 * disappears for a while — long enough to reach a control underneath, and it
 * stays away even if the pointer comes back into the corner. The duration is a
 * setting (`toolbarSuspensionSecondsAtom`, 0 = the gesture is off).
 *
 * No imports here on purpose: the stateful half lives in
 * ./toolbarSuspensionState.ts, so this file can be checked by a Node script.
 */

/** Two Shift presses within this window count as a double-tap. */
export const DOUBLE_TAP_MS = 400;

/**
 * True when a Shift press follows the previous one quickly enough. A clock that
 * went backwards (delta < 0) is not a double-tap either.
 */
export function isDoubleShift(previousMs: number, nowMs: number): boolean {
  const delta = nowMs - previousMs;
  return previousMs > 0 && delta >= 0 && delta <= DOUBLE_TAP_MS;
}

/** The setting in milliseconds: 0 disables both the gesture and the state. */
export function suspensionMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds * 1000);
}

/**
 * The classes the zone and the toolbar need for the current mode.
 *
 * Toolbar reveal is a CSS `group-hover` on the zone. While suspended both class
 * lists are emptied of hover behaviour, so nothing reappears on the next mouse
 * move inside the corner.
 */
export function cornerClasses(suspended: boolean): { zone: string; toolbar: string } {
  return {
    zone: suspended ? 'pointer-events-none' : '',
    toolbar: suspended
      ? ''
      : 'group-hover/corner:pointer-events-auto group-hover/corner:opacity-100',
  };
}
