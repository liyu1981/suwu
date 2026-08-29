import { useCallback, useEffect, useState } from 'react'
import { Outlet, useLocation } from '@tanstack/react-router'
import { useAtom, useStore } from 'jotai'
import { AmbientBackground } from '../components/AmbientBackground'
import { AuthDialog } from '../components/dialogs/AuthDialog'
import SuwuDialog from '../components/dialogs/SuwuDialog'
import { AuthRequiredError, fetchToken } from '../lib/api'
import { focusedIdAtom, layoutAtom, menuOpenAtom, menuViewAtom } from '../wm/atoms'
import {
  splitAndFocus,
  type Direction,
  type SplitSide,
} from '../wm/layout'

const wmBase =
  'grid h-7 w-7 place-items-center rounded transition glass-btn disabled:cursor-not-allowed disabled:opacity-40'
const wmBtn = `${wmBase} text-slate-300 hover:bg-white/10 hover:text-white`

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
  const [, setMenuOpen] = useAtom(menuOpenAtom)
  const [, setMenuView] = useAtom(menuViewAtom)

  // Auth: check if server requires a password.
  const [authRequired, setAuthRequired] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchToken().catch((e) => {
      if (!cancelled && e instanceof AuthRequiredError) {
        setAuthRequired(true)
      }
    })
    return () => { cancelled = true }
  }, [])

  const handleAuthenticated = useCallback(() => {
    setAuthRequired(false)
  }, [])

  // The burger opens the unified Suwu dialog at its root menu screen.
  const openMenu = useCallback(() => {
    setMenuView('menu')
    setMenuOpen(true)
  }, [setMenuOpen, setMenuView])

  const split = useCallback(
    (dir: Direction, side: SplitSide = 'after') => {
      const { next, focus } = splitAndFocus(store.get(layoutAtom), store.get(focusedIdAtom), dir, side)
      store.set(layoutAtom, next)
      store.set(focusedIdAtom, focus)
    },
    [store],
  )

  return (
    <div className="ambient-bg min-h-screen w-full overflow-x-clip text-slate-100">
      <AmbientBackground />
      <div className="relative z-10 grid h-dvh grid-rows-[auto_1fr] gap-2 px-3 pt-2">
        <header className="apple-panel rounded-[6px]">
          <div className="flex items-center gap-2 px-2 py-1">
            <button type="button" aria-label="Open menu" aria-haspopup="dialog" className={wmBtn} onClick={openMenu}>
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
      <SuwuDialog />
      <AuthDialog open={authRequired} onAuthenticated={handleAuthenticated} />
    </div>
  )
}
