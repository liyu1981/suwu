import { useCallback } from 'react'
import { Link, Outlet, useLocation } from '@tanstack/react-router'
import { useAtomValue, useStore } from 'jotai'
import { AmbientBackground } from '../components/AmbientBackground'
import { focusedIdAtom, layoutAtom } from '../wm/atoms'
import { closeAt, createLeaf, leaves, splitAt, type Direction } from '../wm/layout'

const nav = 'rounded px-2 py-0.5 text-xs font-medium transition'
const navIdle = 'text-slate-400 hover:text-white hover:brightness-[1.06]'
const navActive = 'bg-white/10 text-white'

const actionBtn = 'rounded px-2 py-0.5 text-xs font-medium transition glass-btn'

export default function AppShell() {
  const { pathname } = useLocation()
  const isTiling = pathname === '/'
  const store = useStore()
  const layout = useAtomValue(layoutAtom)

  const paneCount = leaves(layout).length

  const split = useCallback(
    (dir: Direction) => {
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
      const next = splitAt(cur, target, dir)
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
          <div className="flex items-center gap-3 px-3 py-1">
            <span className="text-xs font-semibold tracking-tight">ghostty-web</span>

            {isTiling && (
              <>
                <div className="h-3 w-px bg-white/10" />
                <button type="button" onClick={() => split('horizontal')} className={`${actionBtn} bg-sky-600 text-white hover:bg-sky-500`}>
                  Split →
                </button>
                <button type="button" onClick={() => split('vertical')} className={`${actionBtn} bg-sky-600 text-white hover:bg-sky-500`}>
                  Split ↓
                </button>
                <button
                  type="button"
                  onClick={close}
                  disabled={paneCount === 0}
                  className={`${actionBtn} bg-rose-600 text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  Close
                </button>
                <span className="hidden text-[10px] text-slate-500 sm:inline">
                  Alt+Enter split · Alt+Q close · Alt+J/K focus
                </span>
              </>
            )}

            <nav className="ml-auto flex items-center gap-1">
              <Link to="/" className={`${nav} ${navIdle}`} activeProps={{ className: `${nav} ${navActive}` }}>
                Tiling
              </Link>
              <Link to="/colors" className={`${nav} ${navIdle}`} activeProps={{ className: `${nav} ${navActive}` }}>
                Colors
              </Link>
            </nav>
          </div>
        </header>
        <main className="min-h-0 overflow-hidden pb-3">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
