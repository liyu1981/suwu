import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { createLeaf, type LayoutNode } from './layout'

/** The tiling layout tree, persisted across reloads. */
export const layoutAtom = atomWithStorage<LayoutNode>('tiling-layout', createLeaf())

/** The id of the currently focused terminal leaf. */
export const focusedIdAtom = atom('')