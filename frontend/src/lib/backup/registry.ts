/**
 * Backup — the key registry.
 *
 * Backup is an **allowlist**, never a blanket dump of `localStorage`. Every
 * backed-up key must appear in exactly one category below, and
 * `frontend/scripts/check-backup-registry.mjs` fails the build when a `suwu*`
 * key shows up in `frontend/src` that is neither listed here nor explicitly
 * denied. That way a future setting that happens to hold something sensitive
 * cannot leak into a backup by default — adding it is a conscious act.
 *
 * Three categories, matching the UI checkboxes:
 *   settings — what the user configured (appearance, actions, notifications…)
 *   ext      — per-extension records, read from IndexedDB, not localStorage
 *   layout   — the window-manager's spaces, panes, and per-tile session state
 */

import type { Category } from './types.ts';

/** A backed-up key and the category it belongs to. */
interface Entry {
  category: Category;
  /** The exact localStorage key. */
  key?: string;
  /** A prefix match, for keys with a dynamic tail. */
  prefix?: string;
}

/**
 * The allowlist. Grouped by category with the owning module named in a
 * comment, so a moved or renamed key is a one-line edit here.
 */
export const REGISTRY: readonly Entry[] = [
  // ── settings ────────────────────────────────────────────────────────────
  // store/settings.ts
  { category: 'settings', key: 'suwu:auto-resolve' },
  { category: 'settings', key: 'suwu:header-position' },
  { category: 'settings', key: 'suwu:background' },
  { category: 'settings', key: 'suwu:background-params' },
  { category: 'settings', key: 'suwu:webgpu-background' },
  { category: 'settings', key: 'suwu:avatar' },
  { category: 'settings', key: 'suwu:username' },
  { category: 'settings', key: 'suwu:spaces-idle' },
  // store/notifications.ts — history is the user's data and is backed up with
  // the rest of the settings (see the Backup tab for the toggle).
  { category: 'settings', key: 'suwu:notifications' },
  { category: 'settings', key: 'suwu:max-entries' },
  // store/appearance.ts + store/fonts.ts — shared with every pane iframe.
  { category: 'settings', key: 'suwu.term-font-family' },
  { category: 'settings', key: 'suwu.term-font-size' },
  { category: 'settings', key: 'suwu.term-font-default' },
  { category: 'settings', key: 'suwu.term-line-height' },
  { category: 'settings', key: 'suwu.term-line-height-default' },
  { category: 'settings', key: 'suwu.term-theme' },
  { category: 'settings', key: 'suwu.filebrowser-bg' },
  { category: 'settings', key: 'suwu.diff-font-family' },
  // store/zoom.ts — per-tile zoom, incl. the nested default key.
  { category: 'settings', prefix: 'suwu.' },
  // store/appMenu.ts — the app menu layout and custom apps.
  { category: 'settings', key: 'suwu:app-menu' },
  // store/resthelper.ts — request options (the cookie jar is in-memory only).
  { category: 'settings', key: 'suwu:rest-options' },
  // store/foldersync.ts — configured folder-sync jobs (the "active" flag is
  // deliberately not synced: see the FOLDER_SYNC plan, requirement 4).
  { category: 'settings', key: 'suwu:folder-sync' },
  // components/background/external.ts — cached external (WebGPU) backgrounds.
  { category: 'settings', key: 'suwu:external-backgrounds' },
  // store/codeExplorer.ts — Monaco font/line-height, shared with the pane.
  { category: 'settings', key: 'suwu.code-editor-settings' },
  // store/dbbrowser.ts — saved DB connection labels (no passwords are stored).
  { category: 'settings', key: 'suwu_db_saved_connections' },

  // ── layout ──────────────────────────────────────────────────────────────
  // wm/atoms.ts — spaces (layout tree + pane data) and the active space index.
  { category: 'layout', key: 'tiling-spaces' },
  { category: 'layout', key: 'tiling-active-space' },
  // wm/sessionState.ts — per-tile UI state (open tabs, selection, scroll…).
  { category: 'layout', key: 'tiling-session-state' },
  // hooks/usePtySession.ts — per-pane PTY/terminal state, merged into one key.
  { category: 'layout', key: 'suwu-session-states' },
];

/**
 * Keys that must never leave the device even if a future prefix rule would
 * match them. Checked before the allowlist, so a deny always wins.
 */
export const DENY: readonly string[] = [
  // Developer debug toggle for the background picker — meaningless elsewhere.
  'suwu.bg',
  // Machine-local bookkeeping: "when did we last poll for an update".
  'suwu:last-update-check',
  // Backup's own bookkeeping: the mtime/fingerprint shadow map. Backing it up
  // would make every restore look like a change to every key.
  'suwu:backup-mtimes',
  // Backup's own configuration (enabled, slot, categories, interval, and the
  // passphrase-derived salt). The passphrase itself is never stored; the
  // interval is deliberately per-device.
  'suwu:backup-config',
  // Transient UI geometry, not a user setting: the DB browser's column width
  // is a pane-local layout tweak with no cross-device meaning.
  'suwu_db_schema_width',
  // The pre-migration single-layout key. wm/atoms.ts wraps it into the first
  // space and removes it on load, so restoring it would resurrect dead data.
  'tiling-layout',
];

/** Whether a localStorage key is backed up, and under which category. */
export function categoryForKey(key: string): Category | null {
  if (DENY.includes(key)) return null;
  let prefixMatch: Category | null = null;
  for (const entry of REGISTRY) {
    if (entry.key !== undefined && entry.key === key) return entry.category;
    if (entry.prefix !== undefined && key.startsWith(entry.prefix)) prefixMatch = entry.category;
  }
  return prefixMatch;
}

/** Whether a localStorage key participates in the backup. */
export function isBackedUp(key: string): boolean {
  return categoryForKey(key) !== null;
}

/**
 * The storage key prefix under which each extension's records live in
 * IndexedDB (`suwu:ext/<id>/<key>`, forced by ExtensionPage.tsx). Mirrors the
 * bridge in docs/EXTENSION_TILE_PLAN.md §4.8.
 */
export const EXT_KEY_PREFIX = 'suwu:ext/';

/** The categories, in display order. */
export const CATEGORY_ORDER: readonly Category[] = ['settings', 'ext', 'layout'] as const;
