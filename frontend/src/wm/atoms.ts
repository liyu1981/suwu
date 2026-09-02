import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { createSpace, type LayoutNode, type PaneData, type Space } from './layout'

/**
 * Migrate legacy layout leaves:
 * 1. Leaves without tileType → default to 'term'
 * 2. Leaves with fontSize/fontDefault → move to paneData, strip from leaf
 *
 * Returns { layout, paneData } so the caller can attach paneData to the Space.
 */
function migrateLayout(root: LayoutNode | null): { layout: LayoutNode | null; paneData: Record<string, PaneData> } {
  const collected: Record<string, PaneData> = {}

  const walk = (node: LayoutNode | null): LayoutNode | null => {
    if (!node) return null
    if (node.type === 'leaf') {
      // Collect any font props that were stored on the leaf (legacy data).
      const raw = node as unknown as { fontSize?: number; fontDefault?: number; tileType?: string }
      if (raw.fontSize !== undefined || raw.fontDefault !== undefined) {
        collected[node.id] = {
          ...(raw.fontSize !== undefined ? { fontSize: raw.fontSize } : {}),
          ...(raw.fontDefault !== undefined ? { fontDefault: raw.fontDefault } : {}),
        }
      }
      // Strip old font props and ensure tileType exists.
      const { fontSize: _fs, fontDefault: _fd, ...stripped } = raw
      if (stripped.tileType !== undefined) {
        return stripped as unknown as LayoutNode
      }
      // Legacy leaf with no tileType — default to term.
      return { ...stripped, tileType: 'term' } as unknown as LayoutNode
    }
    return {
      ...node,
      children: node.children.map((c) => ({
        ...c,
        node: walk(c.node) as LayoutNode,
      })),
    }
  }

  const layout = walk(root)
  return { layout, paneData: collected }
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
          return parsed.map((s) => {
            const { layout, paneData } = migrateLayout(s.layout)
            // Merge migrated paneData with any existing paneData.
            const existing = s.paneData ?? {}
            const merged = Object.keys(paneData).length > 0 ? { ...existing, ...paneData } : existing
            return { ...s, layout, paneData: Object.keys(merged).length > 0 ? merged : undefined }
          })
        }
      } catch {
        // fall through to legacy migration
      }
    }

    // Legacy migration: read old tiling-layout key and wrap in a space.
    const legacyRaw = localStorage.getItem(LEGACY_LAYOUT_KEY)
    if (legacyRaw !== null) {
      try {
        const { layout, paneData } = migrateLayout(JSON.parse(legacyRaw) as LayoutNode | null)
        localStorage.removeItem(LEGACY_LAYOUT_KEY)
        return [createSpace('Space 1')]
          .map((s) => ({ ...s, layout, paneData: Object.keys(paneData).length > 0 ? paneData : undefined }))
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

// ── Focus mode ──────────────────────────────────────────────────────

/** Focus space is always at index 0 in spacesAtom. */
export const FOCUS_SPACE_NAME = '__focus__'

/** Metadata for the currently focused tile. */
export interface FocusState {
  paneId: string
  sourceSpaceIndex: number
  sourceLayoutSnapshot: LayoutNode | null
}

/** null = no tile focused; otherwise tracks the focused tile. */
export const focusAtom = atom<FocusState | null>(null)
