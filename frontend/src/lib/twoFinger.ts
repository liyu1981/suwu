/**
 * Two-finger tap recognition, kept pure so it can be asserted without a browser.
 *
 * A tap is quick and still. Anything that moves is a pinch or a two-finger
 * scroll, and those must keep working as themselves — the gesture listeners are
 * passive and never call preventDefault for exactly that reason.
 */
export const TWO_FINGER_MAX_MS = 400;
export const TWO_FINGER_MAX_DRIFT_PX = 12;

export function isTwoFingerTap(durationMs: number, maxDriftPx: number): boolean {
  return durationMs <= TWO_FINGER_MAX_MS && maxDriftPx <= TWO_FINGER_MAX_DRIFT_PX;
}
