import { useEffect } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import type { Terminal } from '@xterm/xterm'
import i18n from 'i18next'
import { connectionMessageAtom, connectionStatusAtom } from '../store/connection'
import { fetchToken } from '../lib/api'

const RECONNECT_DELAY_MS = 2000
const COUNTDOWN_TICK_MS = 1000

/**
 * The reattach key sent as the `session` query param. Tiling panes load
 * `/term?pane=<id>` with a stable pane id (persisted across reloads), so a
 * page refresh reattaches to the same server-side PTY session and gets its
 * screen replayed. Standalone /term visits fall back to a per-tab random key
 * in sessionStorage, which also survives refresh.
 */
function sessionKey(): string {
  const pane = new URLSearchParams(window.location.search).get('pane')
  if (pane) return pane
  let key = sessionStorage.getItem('suwu-session-key')
  if (!key) {
    key =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    sessionStorage.setItem('suwu-session-key', key)
  }
  return key
}

/**
 * Bridges an xterm.js Terminal to the Go server's WebSocket PTY endpoint.
 * Input/output forwarding, resize, automatic reconnection, and keyed session
 * reattach: the server keeps the shell and a libghostty-vt model of its
 * screen alive across disconnects, so reconnecting (after refresh or a
 * dropped socket) replays the current screen state before live output
 * resumes. Connection state (including the reconnect countdown) lives in
 * Jotai atoms and is rendered by the pane's status bar — the terminal
 * content itself stays untouched, since the server replays the screen on
 * reconnect. Mouse reporting sequences arrive via onData as well (xterm
 * encodes them natively).
 *
 * Every attempt (initial connect or reconnect) fetches a fresh token via
 * /api/token first: the server mints a new token on each start, so reusing a
 * cached one after a dev restart would be rejected with HTTP 401.
 */
export function usePtySession(term: Terminal | null) {
  const [, setStatus] = useAtom(connectionStatusAtom)
  const setMessage = useSetAtom(connectionMessageAtom)

  useEffect(() => {
    if (!term) return

    let ws: WebSocket | null = null
    let reconnectTimer: number | undefined
    let disposed = false
    let shellExited = false

    const open = (token: string) => {
      setStatus('connecting')
      setMessage(i18n.t('pty.connecting'))

      const params = new URLSearchParams({
        cols: String(term.cols),
        rows: String(term.rows),
        token,
        session: sessionKey(),
      })
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${protocol}//${window.location.host}/ws?${params}`)
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        setStatus('connected')
        setMessage(i18n.t('pty.connected'))
        const initCmd = new URLSearchParams(window.location.search).get('cmd')
        if (initCmd) {
          setTimeout(() => ws?.send(initCmd + '\r'), 200)
        }
      }

      ws.onmessage = (event) => {
        const data = event.data
        const text = typeof data === 'string' ? data : new TextDecoder().decode(new Uint8Array(data))
        term.write(text)
        if (text.includes('Shell exited')) {
          shellExited = true
        }
      }

      ws.onclose = () => {
        if (disposed) return
        if (shellExited) {
          const pane = window.frameElement?.getAttribute('data-pane')
          if (pane) {
            window.parent?.postMessage({ type: 'wm-close-pane', pane }, '*')
          }
          return
        }
        scheduleReconnect('Connection closed')
      }

      ws.onerror = () => {
        if (disposed) return
        setStatus('disconnected')
        setMessage(i18n.t('pty.error'))
      }
    }

    // Countdown in the status bar (red dot + message) instead of writing
    // into the terminal: the server replays the screen on reconnect, so the
    // scrollback would otherwise accumulate retry noise on every drop.
    const scheduleReconnect = (reason: string) => {
      setStatus('disconnected')
      const msg = (s: number) => i18n.t('pty.reconnecting', { reason, seconds: s })
      let remaining = Math.max(1, Math.round(RECONNECT_DELAY_MS / COUNTDOWN_TICK_MS))
      setMessage(msg(remaining))
      reconnectTimer = window.setInterval(() => {
        remaining -= 1
        if (remaining <= 0) {
          window.clearInterval(reconnectTimer)
          void connect()
        } else {
          setMessage(msg(remaining))
        }
      }, COUNTDOWN_TICK_MS)
    }

    const connect = async () => {
      if (disposed) return
      setStatus('connecting')
      setMessage(i18n.t('pty.authenticating'))
      try {
        const token = await fetchToken()
        if (!disposed) open(token)
      } catch {
        if (disposed) return
        scheduleReconnect('Auth failed')
      }
    }

    const onData = term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data)
    })

    const onResize = term.onResize(({ cols, rows }) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    })

    void connect()

    return () => {
      disposed = true
      if (reconnectTimer) window.clearInterval(reconnectTimer)
      ws?.close()
      onData.dispose()
      onResize.dispose()
    }
  }, [term, setStatus, setMessage])
}
