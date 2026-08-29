import { useCallback, useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import { fontFamilyAtom, termThemeAtom } from '../store/appearance'
import { connectionMessageAtom, connectionStatusAtom, type ConnectionStatus } from '../store/connection'
import { fontSizeAtom } from '../store/fonts'
import { wmAction } from '../wm/shortcuts'
import { useTerminal } from './useTerminal'
import { usePtySession } from './usePtySession'
import { useTermCopy } from './useTermCopy'
import { Toast } from './Toast'

const STATUS_DOT = {
  connecting: 'bg-amber-400 animate-pulse',
  connected: 'bg-green-500',
  disconnected: 'bg-red-500',
} as const

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
}

/**
 * An xterm terminal that fills the entire viewport. This is the page each
 * tiling pane loads in an iframe (`/term`); every iframe gets its own
 * WebSocket PTY session on the server.
 */
export default function FullTerminal() {
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

  usePtySession(term)
  useTermCopy(term, selectionMode, toggleSelectionMode, () => showToast('Copied!'))

  // Clicks inside an iframe never reach the parent, and Chrome does not fire
  // focusin in the parent when focus moves directly between two iframes — so
  // tell the window manager this pane is focused whenever the iframe gains
  // focus, and hand keyboard focus to the terminal right away.
  useEffect(() => {
    const onFocus = () => {
      window.parent?.postMessage(
        { type: 'pane-focus', pane: window.frameElement?.getAttribute('data-pane') },
        '*',
      )
      term?.focus()
    }
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

  // Relay window-manager shortcuts to the parent page, and stop them from
  // reaching the shell (these keys are chosen to be harmless to readline).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = wmAction(e)
      if (!a) return
      e.preventDefault()
      e.stopPropagation()
      window.parent?.postMessage({ type: 'wm-shortcut', action: a }, '*')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
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
          <span className="truncate">Selection mode — Alt+C to exit</span>
        ) : (
          <span className="truncate">{status === 'connected' ? STATUS_LABEL.connected : message || STATUS_LABEL[status]}</span>
        )}
        <button
          type="button"
          onClick={toggleSelectionMode}
          className="ml-auto shrink-0 rounded p-0.5 hover:bg-white/10"
          title={selectionMode ? 'Exit selection mode (Alt+C)' : 'Enter selection mode (Alt+C)'}
        >
          {selectionMode ? (
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          ) : (
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </footer>
      {/* Toast overlay for copy confirmation */}
      {toastMsg && <Toast message={toastMsg} />}
    </div>
  )
}
