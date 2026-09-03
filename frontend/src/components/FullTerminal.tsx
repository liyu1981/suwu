import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { fontFamilyAtom, termThemeAtom, themeToXtermTheme } from '../store/appearance'
import { connectionMessageAtom, connectionStatusAtom } from '../store/connection'
import { FONT_DEFAULT, lineHeightAtom } from '../store/fonts'
import { useTerminal } from './hooks/useTerminal'
import { usePtySession } from './hooks/usePtySession'
import { useTermCopy } from './hooks/useTermCopy'
import { useBell } from './hooks/useBell'
import { CommonTileContainer, useReportTileState } from './CommonTileContainer'
import { CloseIcon, CopyIcon } from './icons'
import { Toast } from './Toast'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
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
  const fontFamily = useAtomValue(fontFamilyAtom)
  const theme = useAtomValue(termThemeAtom)
  const lineHeight = useAtomValue(lineHeightAtom)

  // Font size comes exclusively from the parent via postMessage (tile-font-size).
  // Use a placeholder until the message arrives.
  const [tileFontSize, setTileFontSize] = useState(FONT_DEFAULT)

  const { containerRef, term, setFontSize, setFontFamily, setLineHeight, setTheme } = useTerminal(
    {
      cursorBlink: true,
      fontSize: tileFontSize,
      fontFamily,
      lineHeight,
      scrollback: 5000,
      // The pane wrapper paints the configurable background (alpha included);
      // the terminal grid itself stays transparent so the color is composited
      // exactly once, over the wrapper.
      allowTransparency: true,
      theme: { ...themeToXtermTheme(theme), background: '#00000000' },
    },
    { cols: 80, rows: 24 },
  )

  // ── Selection mode ──
  const [selectionMode, setSelectionMode] = useState(false)
  const toggleSelectionMode = useCallback(() => setSelectionMode((v) => !v), [])

  // ── Selection cache (only meaningful in selection mode) ──
  const [cachedText, setCachedText] = useState('')
  const [cachedLength, setCachedLength] = useState(0)
  const [showCacheDialog, setShowCacheDialog] = useState(false)
  // Ref so the dialog copy handler always reads the latest cache.
  const cachedTextRef = useRef('')
  const onCacheUpdate = useCallback((text: string, length: number) => {
    setCachedText(text)
    setCachedLength(length)
    cachedTextRef.current = text
  }, [])

  // ── Copy toast ──
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const showToast = useCallback((msg: string) => {
    setToastMsg(null) // reset to re-key the component
    requestAnimationFrame(() => setToastMsg(msg))
  }, [])

  // Copy cached text, exit selection mode, show toast.
  const copyCacheAndExit = useCallback(() => {
    const text = cachedTextRef.current
    if (!text) return
    void navigator.clipboard.writeText(text).then(() => {
      showToast(t('terminal.copied'))
      setCachedText('')
      setCachedLength(0)
      cachedTextRef.current = ''
      setSelectionMode(false)
      setShowCacheDialog(false)
    })
  }, [showToast, t])

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
  usePtySession(term, savedState, reportState, paneId)
  useTermCopy(term, selectionMode, toggleSelectionMode, () => showToast(t('terminal.copied')), onCacheUpdate)
  useBell(term, containerRef)

  // Focus the terminal when this iframe gains focus.
  useEffect(() => {
    const onFocus = () => term?.focus()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [term])

  // Apply shared appearance settings from parent (font family, line height, theme).
  useEffect(() => {
    setFontFamily(fontFamily)
  }, [fontFamily, setFontFamily])
  useEffect(() => {
    setLineHeight(lineHeight)
  }, [lineHeight, setLineHeight])
  useEffect(() => {
    setTheme({ ...themeToXtermTheme(theme), background: '#00000000' })
  }, [theme, setTheme])

  // Font size is received from the parent via postMessage. The parent
  // derives it from space.paneData and sends it on mount + every layout
  // change. Until the first message arrives we use the initial state
  // (FONT_DEFAULT).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; fontSize?: number } | undefined
      if (d?.type === 'tile-font-size' && typeof d.fontSize === 'number') {
        setTileFontSize(d.fontSize)
      }
    }
    window.addEventListener('message', onMsg)
    // Request font size from parent — fixes the race where the parent
    // sends postMessage before this iframe's listener is registered.
    window.parent?.postMessage({ type: 'request-font-size', paneId: paneId ?? '' }, '*')
    return () => window.removeEventListener('message', onMsg)
  }, [paneId])
  useEffect(() => {
    setFontSize(tileFontSize)
  }, [tileFontSize, setFontSize])

  return (
    <CommonTileContainer paneId={paneId}>
      <div
        className="flex h-screen flex-col overflow-hidden rounded-[6px]"
        style={{ backgroundColor: theme.background }}
      >
        <div className="min-h-0 flex-1 p-2">
          <div ref={containerRef} className="terminal-canvas relative h-full w-full" />
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
          {/* Clickable char-count badge — only in selection mode */}
          {selectionMode && (
            <button
              type="button"
              onClick={() => setShowCacheDialog(true)}
              className="ml-auto shrink-0 rounded bg-sky-800/60 px-1.5 py-0.5 text-[10px] font-medium text-sky-200 transition hover:bg-sky-700/60 hover:text-white"
              title={t('terminal.showCachePreview')}
            >
              {cachedLength > 0
                ? t('terminal.cachedChars', { count: cachedLength })
                : t('terminal.cacheEmpty')}
            </button>
          )}
          <button
            type="button"
            onClick={toggleSelectionMode}
            className="shrink-0 rounded p-0.5 hover:bg-white/10"
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

      {/* Cache preview dialog — shows the cached selection and allows
          copy-to-clipboard in one step. */}
      <Dialog open={showCacheDialog} onOpenChange={setShowCacheDialog}>
        <DialogContent>
          <DialogTitle>{t('terminal.cachePreview')}</DialogTitle>
          <div className="mt-3 max-h-[50dvh] overflow-auto scrollbar-thin rounded bg-black/40 p-3 font-mono text-xs text-white/80 whitespace-pre-wrap break-all">
            {cachedText || t('terminal.cacheEmpty')}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCacheDialog(false)}
              className="rounded px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
            >
              {t('dialog.close')}
            </button>
            <button
              type="button"
              onClick={copyCacheAndExit}
              disabled={!cachedText}
              className="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('terminal.copyAndExit')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </CommonTileContainer>
  )
}
