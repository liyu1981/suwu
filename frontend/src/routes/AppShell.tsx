import { useCallback, useState } from 'react'
import { Outlet, useLocation } from '@tanstack/react-router'
import { useAtom, useStore } from 'jotai'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { AmbientBackground } from '../components/AmbientBackground'
import AboutDialog from '../components/AboutDialog'
import SettingsDialog from '../components/SettingsDialog'
import ShortcutsDialog from '../components/ShortcutsDialog'
import { focusedIdAtom, layoutAtom, aboutOpenAtom, shortcutsOpenAtom } from '../wm/atoms'
import {
  createLeaf,
  leaves,
  splitAt,
  type Direction,
  type SplitSide,
} from '../wm/layout'

const wmBase =
  'grid h-7 w-7 place-items-center rounded transition glass-btn disabled:cursor-not-allowed disabled:opacity-40'
const wmBtn = `${wmBase} text-slate-300 hover:bg-white/10 hover:text-white`

const menuItem =
  'flex w-full cursor-pointer select-none items-center rounded px-3 py-2 text-left text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-white/10 hover:text-popover-foreground active:bg-white/15 active:text-popover-foreground'

/**
 * Burger menu: clicking the burger opens a narrow dialog holding an
 * omarchy-style action list (one row per entry). Rows close the menu dialog
 * and open their target dialog; Escape/scrim clicks close it like any dialog.
 */
function MenuDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onShortcuts: () => void
  onSettings: () => void
  onAbout: () => void
}) {
  const { open, onOpenChange } = props
  const close = () => onOpenChange(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="w-[min(92vw,14rem)] p-1.5">
        <DialogTitle className="sr-only">Menu</DialogTitle>
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={() => {
            close()
            props.onShortcuts()
          }}
        >
          Keyboard shortcuts…
        </button>
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={() => {
            close()
            props.onSettings()
          }}
        >
          Settings…
        </button>
        <button
          type="button"
          role="menuitem"
          className={menuItem}
          onClick={() => {
            close()
            props.onAbout()
          }}
        >
          About Suwu…
        </button>
      </DialogContent>
    </Dialog>
  )
}


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

export default function AppShell() {
  const { pathname } = useLocation()
  const isTiling = pathname === '/'
  const store = useStore()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useAtom(shortcutsOpenAtom)
  const [aboutOpen, setAboutOpen] = useAtom(aboutOpenAtom)
  const [menuOpen, setMenuOpen] = useState(false)

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

  return (
    <div className="ambient-bg min-h-screen w-full overflow-x-clip text-slate-100">
      <AmbientBackground />
      <div className="relative z-10 grid h-dvh grid-rows-[auto_1fr] gap-2 px-3 pt-2">
        <header className="apple-panel rounded-[6px]">
          <div className="flex items-center gap-2 px-2 py-1">
            <button type="button" aria-label="Open menu" aria-haspopup="dialog" className={wmBtn} onClick={() => setMenuOpen(true)}>
              <MenuIcon />
            </button>

            <span className="text-xs font-semibold tracking-tight">Suwu</span>

            {isTiling && (
              <>
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
                </div>
              </>
            )}
          </div>
        </header>
        <main className="min-h-0 overflow-hidden pb-3">
          <Outlet />
        </main>
      </div>
      <MenuDialog
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onShortcuts={() => setShortcutsOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onAbout={() => setAboutOpen(true)}
      />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </div>
  )
}
