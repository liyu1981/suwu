/**
 * Hiding the per-tile hover toolbar — the pure contract.
 *
 * The toolbar's zone covers a tile's top-right corner (224×48), which is also
 * where an extension may want to put its own controls. Two earlier attempts
 * failed: holding Shift fought every other Shift gesture, and double-tapping
 * Shift needed keyboard focus on the toolbar itself — which a user reaching for
 * a control underneath does not have.
 *
 * So it is an explicit action: an extension tile shows a **hide button** next to
 * its close button. Clicking it hides the toolbar for a few seconds
 * (App settings → Header → Tile toolbar; 0 removes the button), the corner goes
 * `pointer-events-none` throughout, and the extension's controls underneath are
 * clickable. It comes back on hover once the time is up.
 *
 * No imports here on purpose: the stateful half lives in
 * ./toolbarSuspensionState.ts, so this file is checkable by a Node script.
 */

/** The setting in milliseconds: 0 disables hiding (and hides the button). */
export function suspensionMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds * 1000);
}

/** Is a suspension that ends at `until` still running at `now`? */
export function isSuspended(until: number, now: number): boolean {
  return until > now;
}

/**
 * The classes the zone and the toolbar need for the current mode.
 *
 * Toolbar reveal is a CSS `group-hover` on the zone. While hidden both class
 * lists are emptied of hover behaviour, so nothing reappears on a mouse move
 * inside the corner — the whole point of the button.
 */
export function cornerClasses(suspended: boolean): { zone: string; toolbar: string } {
  return {
    zone: suspended ? 'pointer-events-none' : '',
    toolbar: suspended
      ? ''
      : 'group-hover/corner:pointer-events-auto group-hover/corner:opacity-100',
  };
}

/**
 * Which tiles offer the hide button.
 *
 * Extension tiles only: their surface belongs to the extension, so its top-right
 * corner may hold controls the user must reach. Built-in tiles keep their chrome
 * untouched — nothing is ever placed under their corner that the toolbar would
 * hide.
 */
export function showsHideControl(tileType: string | undefined): boolean {
  return tileType === 'extension';
}
