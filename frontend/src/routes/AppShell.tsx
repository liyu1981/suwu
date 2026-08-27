import { useCallback, useState } from 'react'
import { Link, Outlet, useLocation } from '@tanstack/react-router'
import { useAtomValue, useAtom, useStore } from 'jotai'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AmbientBackground } from '../components/AmbientBackground'
import SettingsDialog from '../components/SettingsDialog'
import ShortcutsDialog from '../components/ShortcutsDialog'
import { focusedIdAtom, layoutAtom, shortcutsOpenAtom } from '../wm/atoms'
import { FONT_MIN, FONT_MAX, clampFont, fontDefaultAtom, fontSizeAtom } from '../store/fonts'
import {
  closeAt,
  createLeaf,
  leaves,
  splitAt,
  type Direction,
  type SplitSide,
} from '../wm/layout'

const wmBase =
  'grid h-7 w-7 place-items-center rounded transition glass-btn disabled:cursor-not-allowed disabled:opacity-40'
const wmBtn = `${wmBase} text-slate-300 hover:bg-white/10 hover:text-white`
const wmClose = `${wmBase} text-slate-300 hover:bg-rose-500/20 hover:text-rose-300`

const menuActive = 'bg-white/10 text-white'

function MenuIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  )
}

function PanelLeftIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9.5 3v18" />
    </svg>
  )
}

function PanelRightIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M14.5 3v18" />
    </svg>
  )
}

function PanelBottomIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 14.5h18" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export default function AppShell() {
  const { pathname } = useLocation()
  const isTiling = pathname === '/'
  const store = useStore()
  const layout = useAtomValue(layoutAtom)
  const paneCount = leaves(layout).length
  const [fontSize, setFontSize] = useAtom(fontSizeAtom)
  const defaultSize = useAtomValue(fontDefaultAtom)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useAtom(shortcutsOpenAtom)

  const split = useCallback(
    (dir: Direction, side: SplitSide = 'after') => {
      const cur = store.get(layoutAtom)
      if (!cur) {
        const leaf = createLeaf()
        store.set(layoutAtom, leaf)
        store.set(focusedIdAtom, leaf.id)
        return
      }
      const f = store.get(focusedIdAtom)
      const target = f && leaves(cur).includes(f) ? f : leaves(cur)[0]
      if (!target) return
      const next = splitAt(cur, target, dir, side)
      store.set(layoutAtom, next)
      const ids = leaves(next).filter((id) => id !== target)
      store.set(focusedIdAtom, ids[ids.length - 1] ?? target)
    },
    [store],
  )

  const close = useCallback(() => {
    const cur = store.get(layoutAtom)
    if (!cur) return
    const f = store.get(focusedIdAtom)
    if (!f) return
    const next = closeAt(cur, f)
    store.set(layoutAtom, next)
    store.set(focusedIdAtom, leaves(next)[0] ?? '')
  }, [store])

  return (
    <div className="ambient-bg min-h-screen w-full overflow-x-clip text-slate-100">
      <AmbientBackground />
      <div className="relative z-10 grid h-dvh grid-rows-[auto_1fr] gap-2 px-3 pt-2">
        <header className="apple-panel rounded-[6px]">
          <div className="flex items-center gap-2 px-2 py-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label="Open menu" className={wmBtn}>
                  <MenuIcon />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {/* Item asChild: the Link renders as the menuitem anchor; items auto-close on select */}
                <DropdownMenuItem asChild>
                  <Link to="/" activeProps={{ className: menuActive }}>
                    Tiling
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/colors" activeProps={{ className: menuActive }}>
                    Colors
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={fontSize >= FONT_MAX}
                  onSelect={() => setFontSize(clampFont(fontSize + 1))}
                >
                  Increase font size
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={fontSize <= FONT_MIN}
                  onSelect={() => setFontSize(clampFont(fontSize - 1))}
                >
                  Decrease font size
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={fontSize === defaultSize}
                  onSelect={() => setFontSize(defaultSize)}
                >
                  Reset font ({defaultSize}px)
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setShortcutsOpen(true)}>
                  Keyboard shortcuts…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                  Settings…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <span className="text-xs font-semibold tracking-tight">Suwu</span>

            {isTiling && (
              <>
                <span className="hidden text-[10px] text-slate-500 sm:inline sm:ml-2">
                  Alt+Enter split · Alt+Shift+Enter split down · Alt+Q close · Alt+J/K focus · Alt+Arrows move ·
                  Alt+/ shortcuts
                </span>
                <div className="ml-auto flex items-center gap-0.5">
                  <button type="button" onClick={() => split('horizontal', 'before')} aria-label="Split left" title="Split left of focused pane" className={wmBtn}>
                    <PanelLeftIcon />
                  </button>
                  <button type="button" onClick={() => split('vertical')} aria-label="Split down" title="Split below focused pane (Alt+Shift+Enter)" className={wmBtn}>
                    <PanelBottomIcon />
                  </button>
                  <button type="button" onClick={() => split('horizontal')} aria-label="Split right" title="Split right of focused pane (Alt+Enter)" className={wmBtn}>
                    <PanelRightIcon />
                  </button>
                  <span className="mx-1 h-3 w-px bg-white/10" />
                  <button
                    type="button"
                    onClick={close}
                    disabled={paneCount === 0}
                    aria-label="Close pane"
                    title="Close focused pane (Alt+Q)"
                    className={wmClose}
                  >
                    <CloseIcon />
                  </button>
                </div>
              </>
            )}
          </div>
        </header>
        <main className="min-h-0 overflow-hidden pb-3">
          <Outlet />
        </main>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  )
}
