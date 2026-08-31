import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { fontFamilyAtom, termThemeAtom } from '../store/appearance'
import { connectionMessageAtom, connectionStatusAtom } from '../store/connection'
import { fontSizeAtom } from '../store/fonts'
import { useTerminal } from './useTerminal'
import { usePtySession } from './usePtySession'
import { useTermCopy } from './useTermCopy'
import { CommonTileContainer, useReportTileState } from './CommonTileContainer'
import { CloseIcon, CopyIcon } from './icons'
import { Toast } from './Toast'
import type { TermSessionState } from '../wm/sessionState'

const STATUS_DOT = {
  connecting: 'bg-amber-400 animate-pulse',
  connected: 'bg-green-500',
  disconnected: 'bg-red-500',
} as const

/**
 * An xterm terminal that fills the entire viewport. This is the page each
 * tiling pane loads in an iframe (`/term`); every iframe gets its own
 * WebSocket PTY session on the server.
 */
export default function FullTerminal() {
  const { t } = useTranslation()
  const status = useAtomValue(connectionStatusAtom)
  const message = useAtomValue(connectionMessageAtom)
  const fontSize = useAtomValue(fontSizeAtom)
  const fontFamily = useAtomValue(fontFamilyAtom)
  const theme = useAtomValue(termThemeAtom)

  const { containerRef, term, setFontSize, setFontFamily, setTheme } = useTerminal(
    {
      cursorBlink: true,
      // Options are consumed on mount; live changes flow through the setters
      // in the effects below.
      fontSize,
      fontFamily,
      scrollback: 5000,
      // The pane wrapper paints the configurable background (alpha included);
      // the terminal grid itself stays transparent so the color is composited
      // exactly once, over the wrapper.
      allowTransparency: true,
      theme: { background: '#00000000', foreground: theme.foreground, cursor: theme.cursor },
    },
    { cols: 80, rows: 24 },
  )

  // ── Selection mode ──
  const [selectionMode, setSelectionMode] = useState(false)
  const toggleSelectionMode = useCallback(() => setSelectionMode((v) => !v), [])

  // ── Copy toast ──
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const showToast = useCallback((msg: string) => {
    setToastMsg(null) // reset to re-key the component
    requestAnimationFrame(() => setToastMsg(msg))
  }, [])

  // Read pane ID from URL for session state loading.
  const paneId = useMemo(() => new URLSearchParams(window.location.search).get('pane') ?? undefined, [])

  // Read saved session state directly from localStorage (bypasses context
  // timing issue where hooks run before provider renders).
  const savedState = useMemo<TermSessionState | null>(() => {
    if (!paneId) return null
    try {
      const raw = localStorage.getItem('tiling-session-state')
      if (!raw) return null
      const all = JSON.parse(raw)
      return all[paneId]?.state ?? null
    } catch {
      return null
    }
  }, [paneId])

  const reportState = useReportTileState()
  usePtySession(term, savedState, reportState)
  useTermCopy(term, selectionMode, toggleSelectionMode, () => showToast(t('terminal.copied')))

  // Focus the terminal when this iframe gains focus.
  useEffect(() => {
    const onFocus = () => term?.focus()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [term])

  // Track the shared appearance settings (parent page edits them; panes
  // receive the change via storage events).
  useEffect(() => {
    setFontSize(fontSize)
  }, [fontSize, setFontSize])
  useEffect(() => {
    setFontFamily(fontFamily)
  }, [fontFamily, setFontFamily])
  useEffect(() => {
    setTheme({ foreground: theme.foreground, cursor: theme.cursor })
  }, [theme, setTheme])

  // Per-tile font size override: the parent sends this via postMessage
  // whenever the leaf's fontSize changes in the layout tree.
  const [tileFontSize, setTileFontSize] = useState<number | null>(null)
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; fontSize?: number; fontDefault?: number } | undefined
      if (d?.type === 'tile-font-size' && typeof d.fontSize === 'number') {
        setTileFontSize(d.fontSize)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])
  useEffect(() => {
    if (tileFontSize !== null) setFontSize(tileFontSize)
  }, [tileFontSize, setFontSize])

  return (
    <CommonTileContainer paneId={paneId}>
      <div
        className="flex h-screen w-screen flex-col overflow-hidden rounded-[6px]"
        style={{ backgroundColor: theme.background }}
      >
        <div className="min-h-0 flex-1 p-2">
          <div ref={containerRef} className="terminal-canvas h-full w-full" />
        </div>
        {/* Thin per-pane status bar: connection state lives here instead of
            floating over the terminal content. */}
        <footer
          className={`flex h-5 shrink-0 items-center gap-1.5 border-t px-2 text-[10px] tracking-wide ${
            selectionMode
              ? 'border-sky-400/30 bg-sky-900/50 text-sky-300'
              : 'border-white/10 bg-black/40 text-white/60'
          }`}
          title={message}
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${selectionMode ? 'bg-sky-400' : STATUS_DOT[status]}`} />
          {selectionMode ? (
            <span className="truncate">{t('terminal.selectionMode')}</span>
          ) : (
            <span className="truncate">{status === 'connected' ? t('terminal.connected') : message || t(`terminal.${status}`)}</span>
          )}
          <button
            type="button"
            onClick={toggleSelectionMode}
            className="ml-auto shrink-0 rounded p-0.5 hover:bg-white/10"
            title={selectionMode ? t('terminal.exitSelectionMode') : t('terminal.enterSelectionMode')}
          >
            {selectionMode ? (
              <CloseIcon className="h-3 w-3" />
            ) : (
              <CopyIcon className="h-3 w-3" />
            )}
          </button>
        </footer>
        {/* Toast overlay for copy confirmation */}
        {toastMsg && <Toast message={toastMsg} />}
      </div>
    </CommonTileContainer>
  )
}
