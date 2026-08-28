import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { createLeaf, type LayoutNode } from './layout'

/** The tiling layout tree, persisted across reloads. null = empty (no tiles). */
export const layoutAtom = atomWithStorage<LayoutNode | null>('tiling-layout', createLeaf())

/** The id of the currently focused terminal leaf. */
export const focusedIdAtom = atom('')

/** Which screen the unified Suwu menu dialog is showing. */
export type MenuView = 'menu' | 'shortcuts' | 'settings' | 'about'

/**
 * Whether the unified Suwu menu dialog is open. Owns the burger menu, the
 * keyboard-shortcuts help, settings, and about screens so all entry points
 * share a single dialog.
 */
export const menuOpenAtom = atom(false)

/** The currently visible screen inside the unified menu dialog. */
export const menuViewAtom = atom<MenuView>('menu')