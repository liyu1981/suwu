import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'

/** The sub-screens reachable from the menu list. */
export type MenuSelection = 'shortcuts' | 'settings' | 'about'

const menuRow =
  'flex w-full cursor-pointer select-none items-center justify-between gap-2 rounded px-3 py-2 text-left ' +
  'text-sm font-medium text-muted-foreground outline-none transition-colors ' +
  'hover:bg-white/10 hover:text-popover-foreground active:bg-white/15 active:text-popover-foreground ' +
  'focus-visible:bg-white/10 focus-visible:text-popover-foreground'

/**
 * Root screen of the unified Suwu dialog: an iOS-settings-style vertical list
 * of rows. Selecting a row swaps the dialog body to that screen; the dialog
 * header (in SuwuDialog) shows the back and close buttons.
 *
 * Keyboard navigation: ArrowUp/ArrowDown move focus between rows (with
 * wrap-around), Home/End jump to the first/last row, Enter/Space activate the
 * focused row (native button behavior). Focus starts on the first row so the
 * dialog is fully operable from the keyboard the moment it opens.
 */
export default function MainMenuView(props: { onSelect: (view: MenuSelection) => void }) {
  const { onSelect } = props
  const navRef = useRef<HTMLElement>(null)

  // Focus the first row on mount so arrow keys work right away.
  useEffect(() => {
    navRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const rows = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    if (rows.length === 0) return
    const current = rows.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    switch (e.key) {
      case 'ArrowDown':
        next = current < 0 ? 0 : (current + 1) % rows.length
        break
      case 'ArrowUp':
        next = current < 0 ? rows.length - 1 : (current - 1 + rows.length) % rows.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = rows.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    rows[next].focus()
  }

  return (
    <nav ref={navRef} aria-label="Menu" onKeyDown={onKeyDown} className="flex flex-col gap-0.5">
      <button type="button" role="menuitem" className={menuRow} onClick={() => onSelect('shortcuts')}>
        Keyboard shortcuts
        <ChevronIcon />
      </button>
      <button type="button" role="menuitem" className={menuRow} onClick={() => onSelect('settings')}>
        Settings
        <ChevronIcon />
      </button>
      <button type="button" role="menuitem" className={menuRow} onClick={() => onSelect('about')}>
        About Suwu
        <ChevronIcon />
      </button>
    </nav>
  )
}

function ChevronIcon() {
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0 opacity-60"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}
