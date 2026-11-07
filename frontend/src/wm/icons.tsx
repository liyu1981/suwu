// Re-export shared icons used by WM components.
export { CloseIcon, ResetFontSizeIcon, SwapIcon } from '../components/icons';

/** Grip handle for dragging a tile into a new layout position. */
export function GripIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

/** Focus icon: expand arrows pointing outward. */
export function FocusIcon() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

/** Exit focus icon: collapse arrows pointing inward. */
export function ExitFocusIcon() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

/** Move to space icon: arrow with multiple destinations. */
export function MoveToSpaceIcon() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 9l4-4 4 4" />
      <path d="M9 5v14" />
      <path d="M19 15l-4 4-4-4" />
      <path d="M15 19V5" />
    </svg>
  );
}

/** Hide the tile toolbar: an eye with a slash — "not now, please". */
export function HideToolsIcon() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 3l18 18" />
      <path d="M10.6 5.6A9.9 9.9 0 0112 5.5c5 0 9 6.5 9 6.5a15 15 0 01-3 3.6" />
      <path d="M6.2 7.4A15.6 15.6 0 003 12s4 6.5 9 6.5a9.3 9.3 0 003.4-.7" />
      <path d="M9.9 9.9a3 3 0 004.2 4.2" />
    </svg>
  );
}
