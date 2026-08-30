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
