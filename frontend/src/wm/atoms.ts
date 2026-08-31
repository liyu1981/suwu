import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { createSpace, type LayoutNode, type Space } from './layout'
import { FONT_DEFAULT } from '../store/fonts'

/** Migrate legacy layout leaves that lack tileType / font params. */
function migrateLayout(root: LayoutNode | null): LayoutNode | null {
  if (!root) return root
  if (root.type === 'leaf') {
    if (root.tileType !== undefined) return root
    return {
      ...root,
      tileType: 'term',
      fontSize: root.fontSize ?? FONT_DEFAULT,
      fontDefault: root.fontDefault ?? FONT_DEFAULT,
    }
  }
  return {
    ...root,
    children: root.children.map((c) => ({
      ...c,
      node: migrateLayout(c.node) as LayoutNode,
    })),
  }
}

// ── Space storage ──────────────────────────────────────────────────

const SPACES_KEY = 'tiling-spaces'
const ACTIVE_SPACE_KEY = 'tiling-active-space'
const LEGACY_LAYOUT_KEY = 'tiling-layout'

/**
 * Custom storage for spaces that migrates the old single-layout key.
 * On first load the legacy `tiling-layout` value is wrapped into a single
 * space and the old key is removed.
 */
const migratingSpacesStorage = {
  getItem: (key: string): Space[] => {
    const raw = localStorage.getItem(key)
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Space[]
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((s) => ({
            ...s,
            layout: migrateLayout(s.layout),
          }))
        }
      } catch {
        // fall through to legacy migration
      }
    }

    // Legacy migration: read old tiling-layout key and wrap in a space.
    const legacyRaw = localStorage.getItem(LEGACY_LAYOUT_KEY)
    if (legacyRaw !== null) {
      try {
        const layout = migrateLayout(JSON.parse(legacyRaw) as LayoutNode | null)
        localStorage.removeItem(LEGACY_LAYOUT_KEY)
        return [createSpace('Space 1')]
          .map((s) => ({ ...s, layout }))
      } catch {
        // ignore
      }
    }

    return [createSpace('Space 1')]
  },
  setItem: (_key: string, value: Space[]) => {
    localStorage.setItem(SPACES_KEY, JSON.stringify(value))
  },
  removeItem: (_key: string) => {
    localStorage.removeItem(SPACES_KEY)
  },
}

/**
 * All spaces. Each space has its own independent tiling layout tree.
 * Persisted across reloads; always at least one entry.
 */
export const spacesAtom = atomWithStorage<Space[]>(
  SPACES_KEY,
  [createSpace('Space 1')],
  migratingSpacesStorage,
)

/**
 * Index of the currently visible space. Persisted but clamped to valid
 * range whenever spacesAtom changes.
 */
export const activeSpaceAtom = atomWithStorage<number>(ACTIVE_SPACE_KEY, 0)

/**
 * Derived read/write atom that targets the active space's layout.
 *
 * Read: returns the active space's LayoutNode | null.
 * Write: accepts a direct LayoutNode | null, or an updater function
 *        (prev: LayoutNode | null) => LayoutNode | null.
 *
 * This keeps all existing code (split, close, focusOffset, computeTiling,
 * etc.) working unchanged — they read/write layoutAtom which transparently
 * targets the active space.
 */
export const layoutAtom = atom(
  (get) => {
    const spaces = get(spacesAtom)
    const idx = get(activeSpaceAtom)
    return spaces[idx]?.layout ?? null
  },
  (get, set, update: LayoutNode | null | ((prev: LayoutNode | null) => LayoutNode | null)) => {
    const spaces = get(spacesAtom)
    const idx = get(activeSpaceAtom)
    if (idx < 0 || idx >= spaces.length) return
    const current = spaces[idx].layout
    const nextLayout = typeof update === 'function' ? update(current) : update
    const next = spaces.map((s, i) => (i === idx ? { ...s, layout: nextLayout } : s))
    set(spacesAtom, next)
  },
)

/** The id of the currently focused terminal leaf. */
export const focusedIdAtom = atom('')

/** Which screen the unified Suwu menu dialog is showing. */
export type MenuView = 'menu' | 'shortcuts' | 'settings' | 'appSettings' | 'about'

/**
 * Whether the unified Suwu menu dialog is open. Owns the burger menu, the
 * keyboard-shortcuts help, settings, and about screens so all entry points
 * share a single dialog.
 */
export const menuOpenAtom = atom(false)

/** The currently visible screen inside the unified menu dialog. */
export const menuViewAtom = atom<MenuView>('menu')

/** Swap mode state: null = inactive, otherwise tracks which tile initiated the swap. */
export const swapModeAtom = atom<string | null>(null)
