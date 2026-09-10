import { useEffect } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import type { Terminal } from '@xterm/xterm'
import i18n from 'i18next'
import { connectionMessageAtom, connectionStatusAtom } from '../../store/connection'
import { fetchToken } from '../../lib/api'

const RECONNECT_DELAY_MS = 2000
const COUNTDOWN_TICK_MS = 1000

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

type AttachMessage = {
  type?: string
  created?: boolean
  snapshot?: boolean
  attachment?: number
}

/**
 * Connects a disposable browser xterm to a server-owned PTY session.
 *
 * The session key identifies the server PTY, not this WebSocket. Every
 * reconnect creates a new attachment, resets the browser terminal, replays
 * the server VT snapshot, and waits for an explicit ready message before
 * forwarding input. No terminal cwd, foreground command, or screen state is
 * stored in browser storage.
 */
export function usePtySession(term: Terminal | null, paneId?: string) {
  const [, setStatus] = useAtom(connectionStatusAtom)
  const setMessage = useSetAtom(connectionMessageAtom)

  useEffect(() => {
    if (!term) return

    let disposed = false
    let currentWs: WebSocket | null = null
    let currentGeneration = 0
    let reconnectTimer: number | undefined
    let reconnectInterval: number | undefined
    let connectInFlight = false
    let inputReady = false
    let hiddenBeforeResume = false
    let shellExited = false
    let initialCommandSent = false
    let lastSize = { cols: term.cols, rows: term.rows }

    const setInputEnabled = (enabled: boolean) => {
      inputReady = enabled
      // disableStdin prevents xterm from generating new keyboard/mouse data
      // while the browser terminal is detached or being replayed. The onData
      // guard below remains necessary because an event can already be queued.
      term.options.disableStdin = !enabled
    }

    const clearReconnectTimers = () => {
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      if (reconnectInterval !== undefined) {
        window.clearInterval(reconnectInterval)
        reconnectInterval = undefined
      }
    }

    const invalidateSocket = () => {
      const ws = currentWs
      currentWs = null
      currentGeneration += 1
      setInputEnabled(false)
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'reattaching')
      } else if (ws && ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }

    const scheduleReconnect = (reason: string) => {
      if (disposed || reconnectTimer !== undefined || connectInFlight) return
      setInputEnabled(false)
      setStatus('disconnected')

      const message = (seconds: number) => i18n.t('pty.reconnecting', { reason, seconds })
      let remaining = Math.max(1, Math.round(RECONNECT_DELAY_MS / COUNTDOWN_TICK_MS))
      setMessage(message(remaining))
      reconnectTimer = window.setTimeout(() => {
        if (reconnectInterval !== undefined) window.clearInterval(reconnectInterval)
        reconnectInterval = undefined
        reconnectTimer = undefined
        void connect()
      }, RECONNECT_DELAY_MS)
      reconnectInterval = window.setInterval(() => {
        remaining -= 1
        if (remaining > 0) setMessage(message(remaining))
      }, COUNTDOWN_TICK_MS)
    }

    const sendResize = (ws: WebSocket) => {
      if (lastSize.cols <= 0 || lastSize.rows <= 0) return
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: lastSize.cols, rows: lastSize.rows }))
      }
    }

    const open = (token: string) => {
      if (disposed) return

      // The browser xterm is a disposable projection. Reset its parser,
      // modes, screen, and cursor before applying the server snapshot.
      term.reset()
      setInputEnabled(false)
      setStatus('connecting')
      setMessage(i18n.t('pty.connecting'))
      shellExited = false

      const generation = ++currentGeneration
      let attachReceived = false
      let snapshotWritten = true
      let serverReady = false
      let readyAckSent = false
      let created = false
      let attachment = 0
      const decoder = new TextDecoder()

      const maybeReady = () => {
        if (disposed || currentWs !== ws || generation !== currentGeneration) return
        if (!attachReceived || !serverReady || !snapshotWritten) return
        if (!readyAckSent && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ready', attachment }))
          readyAckSent = true
        }
        setInputEnabled(true)
        setStatus('connected')
        setMessage(i18n.t('pty.connected'))
        sendResize(ws)

        if (created && !initialCommandSent) {
          initialCommandSent = true
          const initCmd = new URLSearchParams(window.location.search).get('cmd')
          if (initCmd) {
            window.setTimeout(() => {
              if (currentWs === ws && inputReady && ws.readyState === WebSocket.OPEN) {
                ws.send(initCmd + '\r')
              }
            }, 50)
          }
        }
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const params = new URLSearchParams({
        cols: String(Math.max(1, term.cols)),
        rows: String(Math.max(1, term.rows)),
        token,
        session: sessionKey(),
      })
      const cwd = new URLSearchParams(window.location.search).get('cwd')
      if (cwd) params.set('cwd', cwd)

      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?${params}`)
      ws.binaryType = 'arraybuffer'
      currentWs = ws

      ws.onopen = () => {
        if (currentWs !== ws || generation !== currentGeneration) return
        setStatus('connecting')
        setMessage(i18n.t('pty.connecting'))
      }

      ws.onmessage = (event) => {
        if (currentWs !== ws || generation !== currentGeneration || disposed) return

        if (typeof event.data === 'string') {
          let control: AttachMessage | null = null
          try {
            control = JSON.parse(event.data) as AttachMessage
          } catch {
            // Server terminal output is binary. Keep this fallback for future
            // control-less servers and unusual text frames.
          }

          if (control?.type === 'attach') {
            attachReceived = true
            created = control.created === true
            if (created) initialCommandSent = false
            attachment = control.attachment ?? 0
            snapshotWritten = control.snapshot !== true
            return
          }
          if (control?.type === 'ready') {
            serverReady = true
            maybeReady()
            return
          }

          term.write(event.data)
          return
        }

        const bytes = event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : event.data instanceof Blob
            ? null
            : event.data

        if (bytes === null) {
          void event.data.arrayBuffer().then((buffer: ArrayBuffer) => {
            if (currentWs !== ws || generation !== currentGeneration || disposed) return
            const data = new Uint8Array(buffer)
            snapshotWritten = false
            term.write(data, () => {
              snapshotWritten = true
              maybeReady()
            })
          })
          return
        }

        const text = decoder.decode(bytes, { stream: true })
        if (text.includes('Shell exited')) shellExited = true

        if (!snapshotWritten) {
          term.write(bytes, () => {
            snapshotWritten = true
            maybeReady()
          })
        } else {
          term.write(bytes)
        }
      }

      ws.onclose = () => {
        if (currentWs !== ws || generation !== currentGeneration || disposed) return
        currentWs = null
        setInputEnabled(false)
        if (shellExited) {
          const pane = window.frameElement?.getAttribute('data-pane')
          if (pane) window.parent?.postMessage({ type: 'wm-close-pane', pane }, '*')
          return
        }
        scheduleReconnect('Connection closed')
      }

      ws.onerror = () => {
        if (currentWs !== ws || generation !== currentGeneration || disposed) return
        setInputEnabled(false)
        setStatus('disconnected')
        setMessage(i18n.t('pty.error'))
      }
    }

    const connect = async () => {
      if (disposed || connectInFlight || currentWs || reconnectTimer !== undefined) return
      connectInFlight = true
      setInputEnabled(false)
      setStatus('connecting')
      setMessage(i18n.t('pty.authenticating'))
      try {
        const { token } = await fetchToken()
        if (!disposed) open(token)
      } catch {
        // Clear the guard before scheduling; scheduleReconnect intentionally
        // refuses to create a second attempt while one is in flight.
        connectInFlight = false
        if (!disposed) scheduleReconnect('Auth failed')
      } finally {
        connectInFlight = false
      }
    }

    const forceReconnect = (reason: string) => {
      if (disposed) return
      clearReconnectTimers()
      invalidateSocket()
      scheduleReconnect(reason)
    }

    const onData = term.onData((data) => {
      const ws = currentWs
      if (!inputReady || !ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(data)
    })

    const onResize = term.onResize(({ cols, rows }) => {
      lastSize = { cols, rows }
      const ws = currentWs
      if (inputReady && ws?.readyState === WebSocket.OPEN) sendResize(ws)
    })

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenBeforeResume = true
        setInputEnabled(false)
        return
      }
      if (hiddenBeforeResume) {
        hiddenBeforeResume = false
        forceReconnect('Browser resumed')
      }
    }

    const onOnline = () => {
      if (!inputReady) forceReconnect('Network restored')
    }

    const onPageHide = () => {
      setInputEnabled(false)
      invalidateSocket()
    }

    const onPageShow = () => {
      if (!disposed && !currentWs && !connectInFlight) void connect()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)

    setInputEnabled(false)
    void connect()

    return () => {
      disposed = true
      clearReconnectTimers()
      invalidateSocket()
      onData.dispose()
      onResize.dispose()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [term, paneId, setStatus, setMessage])
}
