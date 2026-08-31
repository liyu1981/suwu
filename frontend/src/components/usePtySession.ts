import { useEffect, useRef } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import type { Terminal } from '@xterm/xterm'
import i18n from 'i18next'
import { connectionMessageAtom, connectionStatusAtom } from '../store/connection'
import { fetchToken } from '../lib/api'
import type { TermSessionState } from '../wm/sessionState'

const RECONNECT_DELAY_MS = 2000
const COUNTDOWN_TICK_MS = 1000
const POLL_INTERVAL_MS = 2000

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

async function pollSessionState(sk: string, token: string): Promise<{ cwd: string; foreground: string } | null> {
  try {
    const params = new URLSearchParams({ session: sk, token })
    const res = await fetch(`/api/session-state?${params}`, { cache: 'no-store' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
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
export function usePtySession(
  term: Terminal | null,
  savedState: TermSessionState | null,
  reportState: (state: Record<string, unknown>) => void,
) {
  const [, setStatus] = useAtom(connectionStatusAtom)
  const setMessage = useSetAtom(connectionMessageAtom)

  const wsRef = useRef<WebSocket | null>(null)
  const tokenRef = useRef('')

  useEffect(() => {
    if (!term) return

    let reconnectTimer: number | undefined
    let pollTimer: number | undefined
    let disposed = false
    let shellExited = false
    let cachedRestoreState: TermSessionState | null = savedState

    const startPolling = () => {
      const key = sessionKey()
      pollTimer = window.setInterval(async () => {
        const token = tokenRef.current
        if (!token) return
        const state = await pollSessionState(key, token)
        if (state) {
          reportState({ cwd: state.cwd, foreground: state.foreground })
        }
      }, POLL_INTERVAL_MS)
    }

    const open = (token: string) => {
      tokenRef.current = token
      setStatus('connecting')
      setMessage(i18n.t('pty.connecting'))

      const restore = cachedRestoreState
      const params = new URLSearchParams({
        cols: String(term.cols),
        rows: String(term.rows),
        token,
        session: sessionKey(),
      })
      if (restore?.cwd) {
        params.set('cwd', restore.cwd)
      }
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?${params}`)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        setStatus('connected')
        setMessage(i18n.t('pty.connected'))

        if (restore?.foreground) {
          setTimeout(() => {
            ws.send(restore.foreground + '\r')
          }, 500)
          setTimeout(() => startPolling(), 3500)
        } else {
          startPolling()
        }

        const initCmd = new URLSearchParams(window.location.search).get('cmd')
        if (initCmd) {
          setTimeout(() => ws.send(initCmd + '\r'), 200)
        }
      }

      ws.onmessage = (event) => {
        const data = event.data
        if (typeof data === 'string') {
          term.write(data)
          return
        }
        const text = new TextDecoder().decode(new Uint8Array(data))
        term.write(text)
        if (text.includes('Shell exited')) {
          shellExited = true
        }
      }

      ws.onclose = () => {
        if (disposed) return
        if (pollTimer) {
          window.clearInterval(pollTimer)
          pollTimer = undefined
        }
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

    const scheduleReconnect = (reason: string) => {
      // Cache the current session state from localStorage before reconnecting.
      try {
        const paneId = new URLSearchParams(window.location.search).get('pane')
        if (paneId) {
          const raw = localStorage.getItem('tiling-session-state')
          if (raw) {
            const store = JSON.parse(raw)
            // Find the latest timestamp's entry for this pane.
            const keys = Object.keys(store).sort()
            if (keys.length > 0) {
              const latest = store[keys[keys.length - 1]]
              if (latest?.[paneId]?.state) {
              cachedRestoreState = latest[paneId].state as TermSessionState
            }
            }
          }
        }
      } catch {
        // ignore
      }

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
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(data)
    })

    const onResize = term.onResize(({ cols, rows }) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    })

    void connect()

    return () => {
      disposed = true
      if (reconnectTimer) window.clearInterval(reconnectTimer)
      if (pollTimer) window.clearInterval(pollTimer)
      wsRef.current?.close()
      wsRef.current = null
      onData.dispose()
      onResize.dispose()
    }
  }, [term, setStatus, setMessage, savedState, reportState])
}
