import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from '@tanstack/react-router'
import { useAtom, useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { AmbientBackground } from '../components/AmbientBackground'
import { AuthDialog } from '../components/dialogs/AuthDialog'
import SuwuDialog from '../components/dialogs/SuwuDialog'
import { NotificationBell } from '../components/NotificationBell'
import { NotificationPanel } from '../components/NotificationPanel'
import { useNotifications } from './hooks/useNotifications'
import { useUpdateCheck } from './hooks/useUpdateCheck'
import { AuthRequiredError, fetchToken } from '../lib/api'
import { focusedIdAtom, layoutAtom, menuOpenAtom, menuViewAtom, spacesAtom, activeSpaceAtom, FOCUS_SPACE_NAME } from '../wm/atoms'
import {
  addSpace,
  findLeaf,
  leaves,
  moveLeafBetweenSpaces,
  removeSpace,
  splitAndFocus,
  type Direction,
  type SplitSide,
} from '../wm/layout'
import { getTilePlugin } from '../wm/tilePlugins'

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
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const isTiling = pathname === '/'
  const store = useStore()
  const [, setMenuOpen] = useAtom(menuOpenAtom)
  const [, setMenuView] = useAtom(menuViewAtom)
  const [spaces] = useAtom(spacesAtom)
  const [activeSpace] = useAtom(activeSpaceAtom)
  const [focusedId] = useAtom(focusedIdAtom)

  useNotifications()
  useUpdateCheck()

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

  const addNewSpace = useCallback(() => {
    const { spaces: next, index } = addSpace(store.get(spacesAtom))
    store.set(spacesAtom, next)
    store.set(activeSpaceAtom, index)
    store.set(focusedIdAtom, '')
  }, [store])

  const deleteSpace = useCallback(
    (idx: number) => {
      const sp = store.get(spacesAtom)
      if (sp.length <= 1) return
      const { spaces: next, index } = removeSpace(sp, idx)
      store.set(spacesAtom, next)
      store.set(activeSpaceAtom, index)
      store.set(focusedIdAtom, '')
      setHoveredSpace(null)
    },
    [store],
  )

  const moveTileToSpace = useCallback(
    (leafId: string, fromIdx: number, toIdx: number) => {
      const sp = store.get(spacesAtom)
      // Adjust indices if focus space exists at index 0.
      const hasFocus = sp[0]?.name === FOCUS_SPACE_NAME
      const adjustedFrom = hasFocus ? fromIdx + 1 : fromIdx
      const adjustedTo = hasFocus ? toIdx + 1 : toIdx
      const next = moveLeafBetweenSpaces(sp, leafId, adjustedFrom, adjustedTo)
      store.set(spacesAtom, next)
      store.set(activeSpaceAtom, adjustedTo)
      store.set(focusedIdAtom, leafId)
      setHoveredSpace(null)
    },
    [store],
  )

  // Hover dropdown state: which space button is hovered.
  const [hoveredSpace, setHoveredSpace] = useState<number | null>(null)
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onSpaceEnter = useCallback((idx: number) => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
    setHoveredSpace(idx)
  }, [])

  const onSpaceLeave = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => setHoveredSpace(null), 150)
  }, [])

  return (
    <div className="ambient-bg min-h-screen w-full overflow-x-clip text-slate-100">
      <AmbientBackground />
      <div className="relative z-10 grid h-dvh grid-rows-[auto_1fr] gap-2 px-3 pt-2">
        <header className="apple-panel rounded-[6px]">
          <div className="flex items-center gap-2 px-2 py-1">
            <button type="button" aria-label={t('app.openMenu')} aria-haspopup="dialog" className={wmBtn} onClick={openMenu}>
              <MenuIcon />
            </button>

            <span className="text-xs font-semibold tracking-tight">{t('app.title')}</span>

            {isTiling && (
              <>
                {/* Space indicator: numbered buttons */}
                <div className="ml-2 flex items-center gap-0.5">
                  {spaces
                    .filter((s) => s.name !== FOCUS_SPACE_NAME)
                    .map((space, displayIdx) => {
                      const i = spaces.indexOf(space)
                      return (
                    <div key={space.id} className="relative">
                      <button
                        type="button"
                        className={`grid h-6 w-6 place-items-center rounded text-[11px] font-medium transition ${
                          i === activeSpace
                            ? 'bg-white/15 text-white'
                            : 'text-white/40 hover:bg-white/10 hover:text-white/70'
                        }`}
                        onClick={() => {
                          store.set(activeSpaceAtom, i)
                          store.set(focusedIdAtom, '')
                        }}
                        onMouseEnter={() => onSpaceEnter(i)}
                        onMouseLeave={onSpaceLeave}
                      >
                        {displayIdx + 1}
                      </button>
                      {/* Hover dropdown: tile list for this space */}
                      {hoveredSpace === i && (() => {
                        const ids = leaves(space.layout)
                        return (
                          <div
                            className="absolute left-0 top-full z-50 mt-6 whitespace-nowrap rounded-[6px] border border-white/10 bg-[#1a1a2e]/95 px-2.5 py-2 shadow-[0_8px_32px_rgb(0_0_0/0.45)] backdrop-blur-xl"
                            onMouseEnter={() => onSpaceEnter(i)}
                            onMouseLeave={onSpaceLeave}
                          >
                            {ids.length === 0 ? (
                              <div className="py-0.5 text-xs text-white/40">{t('wm.emptySpace')}</div>
                            ) : (
                              ids.map((id) => {
                                const leaf = findLeaf(space.layout, id)
                                const tileType = leaf?.type === 'leaf' ? leaf.tileType : undefined
                                const label = tileType ? getTilePlugin(tileType)?.label ?? tileType : 'Empty'
                                return (
                                  <div key={id} className="flex items-center gap-1.5 py-0.5 text-xs text-white/60">
                                    <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-white/25" />
                                    <span>{label}</span>
                                  </div>
                                )
                              })
                            )}
                            {/* Move focused tile here */}
                            {focusedId && i !== activeSpace && space.layout && (
                              <>
                                <div className="my-1.5 border-t border-white/10" />
                                <button
                                  type="button"
                                  className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-xs text-white/60 transition hover:bg-white/10 hover:text-white"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    moveTileToSpace(focusedId, activeSpace, i)
                                  }}
                                >
                                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M5 9l4-4 4 4" />
                                    <path d="M9 5v14" />
                                    <path d="M19 15l-4 4-4-4" />
                                    <path d="M15 19V5" />
                                  </svg>
                                  <span>{t('wm.moveToSpace', { space: i + 1 })}</span>
                                </button>
                              </>
                            )}
                            {spaces.length > 1 && (
                              <>
                                <div className="my-1.5 border-t border-white/10" />
                                <button
                                  type="button"
                                  className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-xs text-red-400/80 transition hover:bg-red-500/15 hover:text-red-300"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    deleteSpace(i)
                                  }}
                                >
                                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 6h18" />
                                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                                  </svg>
                                  <span>{t('wm.deleteSpace')}</span>
                                </button>
                              </>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                    )
                  })}
                  <button
                    type="button"
                    className="grid h-6 w-6 place-items-center rounded text-[11px] text-white/30 transition hover:bg-white/10 hover:text-white/60"
                    onClick={addNewSpace}
                    title={t('wm.addSpace')}
                  >
                    +
                  </button>
                </div>

                <div className="ml-auto flex items-center gap-0.5">
                  <button type="button" onClick={() => split('horizontal', 'before')} aria-label={t('wm.splitLeft')} title={t('wm.splitLeftTitle')} className={wmBtn}>
                    <PanelLeftIcon />
                  </button>
                  <button type="button" onClick={() => split('vertical')} aria-label={t('wm.splitDown')} title={t('wm.splitDownTitle')} className={wmBtn}>
                    <PanelBottomIcon />
                  </button>
                  <button type="button" onClick={() => split('horizontal')} aria-label={t('wm.splitRight')} title={t('wm.splitRightTitle')} className={wmBtn}>
                    <PanelRightIcon />
                  </button>
                  <NotificationBell />
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
      <NotificationPanel />
      <AuthDialog open={authRequired} onAuthenticated={handleAuthenticated} />
    </div>
  )
}
