import { useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { connectionMessageAtom, connectionStatusAtom } from '../store/connection'
import { fontSizeAtom } from '../store/fonts'
import { wmAction } from '../wm/shortcuts'
import { useTerminal } from './useTerminal'
import { usePtySession } from './usePtySession'
import { useTermCopy } from './useTermCopy'

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
  const status = useAtomValue(connectionStatusAtom)
  const message = useAtomValue(connectionMessageAtom)
  const fontSize = useAtomValue(fontSizeAtom)

  const { containerRef, term, setFontSize } = useTerminal(
    {
      cursorBlink: true,
      // Only consumed on mount; live changes flow through setFontSize below.
      fontSize,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
      scrollback: 5000,
      theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4' },
    },
    { cols: 80, rows: 24 },
  )
  usePtySession(term)
  useTermCopy(term)

  // Track the shared font-size setting (parent page edits it; panes receive
  // the change via storage events).
  useEffect(() => {
    setFontSize(fontSize)
  }, [fontSize, setFontSize])

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
    <div className="relative h-screen w-screen overflow-hidden rounded-[6px] bg-[#1e1e1e]/80 p-2">
      <div ref={containerRef} className="terminal-canvas h-full w-full" />
      <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-1.5 rounded-md bg-black/40 px-2 py-1 text-[10px] text-white/70" title={message}>
        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
      </div>
    </div>
  )
}