import { atomWithStorage } from 'jotai/utils'

/**
 * Per-pane selection mode toggle. When true the terminal blocks all keyboard
 * input so the user can freely select text with the mouse; Ctrl/Cmd+C copies
 * the selection and automatically exits selection mode. Pressing Alt+C also
 * toggles the mode. Persisted in localStorage so state survives page reloads.
 */
export const selectionModeAtom = atomWithStorage<boolean>('term-selection-mode', false)
