import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { createLeaf, type LayoutNode } from './layout'
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

const LAYOUT_KEY = 'tiling-layout'

/** Custom storage that migrates legacy leaves on read. */
const migratingStorage = {
  getItem: (key: string): LayoutNode | null => {
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    try {
      return migrateLayout(JSON.parse(raw) as LayoutNode | null)
    } catch {
      return null
    }
  },
  setItem: (_key: string, value: LayoutNode | null) => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(value))
  },
  removeItem: (_key: string) => {
    localStorage.removeItem(LAYOUT_KEY)
  },
}

/**
 * The tiling layout tree, persisted across reloads. null = empty (no tiles).
 * On load, legacy leaves are migrated to include tileType='term'.
 */
export const layoutAtom = atomWithStorage<LayoutNode | null>(
  LAYOUT_KEY,
  createLeaf(),
  migratingStorage,
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
