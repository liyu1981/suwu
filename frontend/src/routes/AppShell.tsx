import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation } from '@tanstack/react-router'
import { useAtomValue, useStore } from 'jotai'
import { AmbientBackground } from '../components/AmbientBackground'
import { focusedIdAtom, layoutAtom } from '../wm/atoms'
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

const menuItem =
  'block rounded px-3 py-1.5 text-sm font-medium transition text-slate-400 hover:bg-white/10 hover:text-white'
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

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  // Close the menu whenever navigation happens through any link inside it.
  const closeMenu = useCallback(() => setMenuOpen(false), [])

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
            <div ref={menuRef} className="relative">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="Open menu"
                onClick={() => setMenuOpen((o) => !o)}
                className={`${wmBtn} ${menuOpen ? 'bg-white/10 text-white' : ''}`}
              >
                <MenuIcon />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="menu-pop absolute left-0 top-full z-50 mt-1.5 flex min-w-44 flex-col bg-clip-padding p-1 glass-control"
                >
                  <Link role="menuitem" to="/" onClick={closeMenu} activeProps={{ className: `${menuItem} ${menuActive}` }}>
                    Tiling
                  </Link>
                  <Link role="menuitem" to="/colors" onClick={closeMenu} activeProps={{ className: `${menuItem} ${menuActive}` }}>
                    Colors
                  </Link>
                </div>
              )}
            </div>

            <span className="text-xs font-semibold tracking-tight">Suwu</span>

            {isTiling && (
              <>
                <span className="hidden text-[10px] text-slate-500 sm:inline sm:ml-2">
                  Alt+Enter split right · Alt+Shift+Enter split down · Alt+Q close · Alt+J/K focus
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
    </div>
  )
}
