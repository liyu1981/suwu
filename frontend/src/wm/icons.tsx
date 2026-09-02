import type { MoveDir } from './layout'

// Re-export shared icons used by WM components.
export { CloseIcon, CopyIcon, ResetFontSizeIcon, SwapIcon } from '../components/icons'

/** Chevron pointing in a tile-move direction (for the hover toolbar). */
export function ChevronIcon({ dir }: { dir: MoveDir }) {
  const d =
    dir === 'left'
      ? 'M15 6l-6 6 6 6'
      : dir === 'right'
        ? 'M9 6l6 6-6 6'
        : dir === 'up'
          ? 'M6 15l6-6 6 6'
          : 'M6 9l6 6 6-6'
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  )
}

/** Focus icon: expand arrows pointing outward. */
export function FocusIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  )
}

/** Exit focus icon: collapse arrows pointing inward. */
export function ExitFocusIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
  )
}

/** Move to space icon: arrow with multiple destinations. */
export function MoveToSpaceIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 9l4-4 4 4" />
      <path d="M9 5v14" />
      <path d="M19 15l-4 4-4-4" />
      <path d="M15 19V5" />
    </svg>
  )
}
