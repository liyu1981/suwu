/**
 * Mobile view: detection, the redirect decision, and the two pure helpers the
 * phone shell needs.
 *
 * The rule the whole feature rests on: **the desktop view is untouched**. `/`
 * keeps rendering the tiling WM; a phone is bounced to `/mobile`, which mounts
 * the same tile iframes and the same atoms with different chrome. So nothing
 * here decides *how* to render — only whether this client is a phone.
 *
 * The decision is a viewport capability question, not user-agent sniffing: an
 * iPad reports a desktop UA, and a narrow desktop window is not a phone. A
 * coarse pointer (or touch without hover) plus a phone-sized viewport is the
 * signal; `?desktop=1` / `?mobile=1` and a stored preference override it, because
 * guessing wrong must always be recoverable.
 *
 * Pure where it matters — `shouldUseMobileView`, `cycleTile`, `tileInfoLine` take
 * their input as arguments, so `scripts/check-mobile.mjs` can exercise the
 * matrix under Node. The rest reads `window`/`localStorage`, guarded.
 */

/** Above this width a touch device is treated as a tablet: it gets the desktop view. */
export const MOBILE_MAX_WIDTH = 820;

/** Where an explicit `?desktop=1` / `?mobile=1` choice is remembered. */
export const MOBILE_PREFERENCE_KEY = 'suwu.mobile-preference';

export type MobilePreference = 'auto' | 'mobile' | 'desktop';

export interface MobileEnv {
  pathname: string;
  search: string;
  width: number;
  height: number;
  coarsePointer: boolean;
  /** `matchMedia('(hover: hover)')` — false on a touch-first device. */
  hover: boolean;
  hasTouch: boolean;
  preference: MobilePreference;
}

/** Parse a stored preference, falling back to `auto` for anything unexpected. */
export function parsePreference(raw: string | null | undefined): MobilePreference {
  return raw === 'mobile' || raw === 'desktop' ? raw : 'auto';
}

/** Read `?desktop=1` / `?mobile=1` out of a query string, if present. */
export function preferenceFromSearch(search: string): MobilePreference | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (params.get('desktop') === '1') return 'desktop';
  if (params.get('mobile') === '1') return 'mobile';
  return null;
}

/**
 * Whether this client should be on `/mobile`.
 *
 * Only the app entry (`/`) and `/mobile` itself are candidates: tile routes are
 * iframes inside whichever shell and must never be redirected, and the desktop
 * view must not be bounced when someone navigates back to `/mobile` deliberately.
 */
export function shouldUseMobileView(env: MobileEnv): boolean {
  if (env.pathname !== '/' && env.pathname !== '/mobile') return false;
  if (env.preference === 'desktop') return false;
  if (env.preference === 'mobile') return true;
  const touchFirst = env.coarsePointer || (env.hasTouch && !env.hover);
  return touchFirst && env.width <= MOBILE_MAX_WIDTH;
}

/** The next/previous tile id in display order, wrapping both ways. */
export function cycleTile(ids: readonly string[], current: string, delta: number): string {
  if (ids.length === 0) return '';
  if (delta === 0) return ids.includes(current) ? current : ids[0];
  const at = ids.indexOf(current);
  if (at < 0) return delta < 0 ? ids[ids.length - 1] : ids[0];
  const n = ids.length;
  return ids[(((at + delta) % n) + n) % n];
}

/** Last path segment, without pulling in a path polyfill. */
export function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/**
 * The one-line secondary text on an overview card, in order of usefulness: the
 * tile's own path (a file browser's directory, a code tab's file), then the
 * persisted session hint, then the plugin's description. Never empty when a
 * description exists, because a card with no info line looks broken.
 */
export function tileInfoLine(input: {
  initialPath?: string;
  sessionHint?: string;
  description?: string;
}): string {
  const path = input.initialPath?.trim();
  if (path) {
    const base = basename(path);
    return base || path;
  }
  const hint = input.sessionHint?.trim();
  if (hint) return hint;
  return input.description?.trim() ?? '';
}

/**
 * Whether this document looks like a phone or tablet: a coarse primary pointer.
 * A touch-screen laptop still reports `fine`, so this does not punish them. Used
 * both for the phone shell's detection and for the terminal's soft-input keypad.
 */
export function isTouchFirst(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/**
 * Whether this document is the phone shell. Desktop-only settings (the header
 * docking position) are hidden here rather than silently ignored: a switch that
 * does nothing is worse than no switch.
 */
export function isMobileShell(pathname: string = window.location.pathname): boolean {
  return pathname === '/mobile' || pathname.startsWith('/mobile/');
}

/**
 * Whether this document is a tile hosted by the phone shell.
 *
 * Tile iframes are same-origin, so the hosting page's path is readable; a bare
 * tile tab has no parent and a desktop shell is not `/mobile`. Used for the
 * phone-only affordances a right button would otherwise provide.
 */
export function hostedByMobileShell(): boolean {
  try {
    if (window.parent === window) return false;
    return isMobileShell(window.parent.location.pathname);
  } catch {
    return false;
  }
}

/**
 * The tile to select after `closedId` disappears: the next one in the order the
 * header arrows walk, else the previous, else nothing. Using the arrow order
 * keeps the visible behaviour consistent — the tile that slides into the closed
 * one's place is the one `` would have shown next.
 */
export function tileAfterClose(ids: readonly string[], closedId: string): string {
  if (ids.length === 0) return '';
  const at = ids.indexOf(closedId);
  if (at < 0) return ids[0];
  return ids[at + 1] ?? ids[at - 1] ?? '';
}

/**
 * A short hint from a tile's persisted session state, for the overview cards.
 *
 * Each plugin keeps its own shape (`currentPath`, a git tab, a code file…), and
 * the overview has no business knowing all of them, so this picks the first
 * string under the field names the plugins actually use. Unknown shapes yield ''
 * and the card falls back to the plugin description.
 */
export function sessionHint(state: Record<string, unknown> | undefined): string {
  if (!state) return '';
  for (const key of ['currentPath', 'path', 'filePath', 'file', 'repoPath', 'dir', 'directory']) {
    const value = state[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    // Only path-shaped values: some plugins keep short flags under ordinary
    // names, and a card that says "s" is worse than a card that says nothing.
    if (trimmed.startsWith('/') || trimmed.startsWith('~')) return trimmed;
  }
  return '';
}

// ── browser helpers ────────────────────────────────────────────────────────

/** The viewport's mobile-relevant capabilities. Desktop defaults when there is no window. */
export function detectMobileEnv(): Omit<MobileEnv, 'pathname' | 'search' | 'preference'> {
  if (typeof window === 'undefined') {
    return { width: 1024, height: 768, coarsePointer: false, hover: true, hasTouch: false };
  }
  const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const hover = window.matchMedia?.('(hover: hover)').matches ?? true;
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    coarsePointer,
    hover,
    hasTouch: (navigator.maxTouchPoints ?? 0) > 0,
  };
}

export function readStoredPreference(): MobilePreference {
  try {
    return parsePreference(localStorage.getItem(MOBILE_PREFERENCE_KEY));
  } catch {
    return 'auto';
  }
}

export function writeStoredPreference(preference: MobilePreference): void {
  try {
    if (preference === 'auto') localStorage.removeItem(MOBILE_PREFERENCE_KEY);
    else localStorage.setItem(MOBILE_PREFERENCE_KEY, preference);
  } catch {
    // Private mode / storage disabled: the URL parameter still works.
  }
}

/**
 * Where this client should be, or null to stay.
 *
 * Called twice: once at module load in `router.tsx` (before `createRouter` reads
 * `window.location`, so the desktop shell never paints on a phone) and once from
 * the index route's `beforeLoad` (so an in-app navigation to `/` cannot land on
 * the desktop shell either). An explicit `?desktop=1` / `?mobile=1` is persisted
 * on the way through, which is what makes the choice survive the redirect.
 */
export function mobileRedirectTarget(pathname: string, search: string): string | null {
  if (typeof window === 'undefined') return null;
  const explicit = preferenceFromSearch(search);
  if (explicit) writeStoredPreference(explicit);
  const preference = explicit ?? readStoredPreference();
  const env: MobileEnv = { ...detectMobileEnv(), pathname, search, preference };
  if (!shouldUseMobileView(env)) return null;
  return '/mobile';
}
