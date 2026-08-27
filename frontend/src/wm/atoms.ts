import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { createLeaf, type LayoutNode } from './layout'

/** The tiling layout tree, persisted across reloads. null = empty (no tiles). */
export const layoutAtom = atomWithStorage<LayoutNode | null>('tiling-layout', createLeaf())

/** The id of the currently focused terminal leaf. */
export const focusedIdAtom = atom('')

/** Whether the keyboard-shortcuts help dialog is open. */
export const shortcutsOpenAtom = atom(false)