import { useEffect } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import type { Terminal } from '@xterm/xterm'
import i18n from 'i18next'
import { connectionMessageAtom, connectionStatusAtom } from '../../store/connection'
import { fetchToken } from '../../lib/api'

const RECONNECT_DELAY_MS = 2000
const COUNTDOWN_TICK_MS = 1000
const KEEPALIVE_MS = 30_000

/** Session state tracked by the backend and mirrored in localStorage. */
interface SessionState {
  cwd?: string
  foreground?: string
  updatedAt?: number
}

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

/** localStorage key for persisted session state. */
function stateKey(): string {
  return `suwu-session-state:${sessionKey()}`
}

/** Load the last-known session state from localStorage. */
function loadStoredState(): SessionState | null {
  try {
    const raw = localStorage.getItem(stateKey())
    if (!raw) return null
    return JSON.parse(raw) as SessionState
  } catch {
    return null
  }
}

/** Persist session state to localStorage. */
function saveState(state: SessionState): void {
  try {
    localStorage.setItem(stateKey(), JSON.stringify(state))
  } catch {
    // storage full or unavailable — non-fatal
  }
}

/** Compare two session states and decide whether restore is needed. */
function needsRestore(stored: SessionState, current: SessionState): boolean {
  // CWD mismatch → restore
  if (stored.cwd && current.cwd && stored.cwd !== current.cwd) return true
  // Foreground app mismatch (compare base command, not args) → restore
  const storedApp = stored.foreground?.split(' ')[0]
  const currentApp = current.foreground?.split(' ')[0]
  if (storedApp && currentApp && storedApp !== currentApp) return true
  return false
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
 * forwarding input. The browser terminal is disposable; the PTY and VT
 * state owned by the server are authoritative.
 *
 * Session state (cwd, foreground app) is periodically synced from the server
 * via pong responses and persisted in localStorage. On reattach, if the
 * stored state differs from the server state, restore commands are sent
 * to bring the shell back to the expected state.
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
    let shellExited = false
    let initialCommandSent = false
    let lastSize = { cols: term.cols, rows: term.rows }
    let lastServerState: SessionState | null = null
    let inputDebugCount = 0

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

    /**
     * Attempt to restore the shell to the previously stored state.
     * Sends cd + foreground app commands with a delay between each.
     */
    const attemptRestore = (ws: WebSocket, stored: SessionState, server: SessionState) => {
      if (disposed || ws.readyState !== WebSocket.OPEN) return
      const commands: string[] = []
      // Restore CWD if different
      if (stored.cwd && server.cwd && stored.cwd !== server.cwd) {
        commands.push(`cd ${JSON.stringify(stored.cwd)}`)
      }
      // Restore foreground app if different
      const storedApp = stored.foreground?.split(' ')[0]
      const currentApp = server.foreground?.split(' ')[0]
      if (storedApp && currentApp && storedApp !== currentApp && stored.foreground) {
        commands.push(stored.foreground)
      }
      if (commands.length === 0) return
      // Send commands sequentially with delay
      commands.forEach((cmd, i) => {
        setTimeout(() => {
          if (disposed || ws.readyState !== WebSocket.OPEN) return
          ws.send(cmd + '\r')
        }, i * 100)
      })
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
        if (!attachReceived || !serverReady || !snapshotWritten) {
          console.debug('[term ready] waiting', {
            attachReceived,
            serverReady,
            snapshotWritten,
            wsState: ws.readyState,
            generation,
            currentGeneration,
          })
          return
        }
        if (!readyAckSent && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ready', attachment }))
          readyAckSent = true
          console.debug('[term ready] client acknowledgement sent', { attachment, generation })
        }
        setInputEnabled(true)
        console.debug('[term ready] input enabled', { attachment, generation })
        setStatus('connected')
        setMessage(i18n.t('pty.connected'))
        sendResize(ws)

        // On reattach (not created), check if state restoration is needed.
        if (!created && lastServerState) {
          const stored = loadStoredState()
          if (stored && needsRestore(stored, lastServerState)) {
            attemptRestore(ws, stored, lastServerState)
          }
        }

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

      // Client-initiated keepalive: sends a ping every KEEPALIVE_MS so the
      // server knows this browser tab is alive. The server piggybacks session
      // state on the pong response, which we persist in localStorage.
      const keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, KEEPALIVE_MS)

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
            console.debug('[term ready] attach received', {
              attachment,
              created,
              hasSnapshot: control.snapshot === true,
              generation,
            })
            maybeReady()
            return
          }
          if (control?.type === 'ready') {
            serverReady = true
            console.debug('[term ready] server ready received', { attachment, generation })
            maybeReady()
            return
          }
          if (control?.type === 'pong') {
            // Extract session state from pong response if present.
            const pongData = control as unknown as { state?: SessionState }
            if (pongData.state) {
              lastServerState = pongData.state
              saveState(pongData.state)
            }
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
          console.debug('[term ready] binary Blob frame received', { size: event.data.size, attachment, generation })
          void event.data.arrayBuffer().then((buffer: ArrayBuffer) => {
            if (currentWs !== ws || generation !== currentGeneration || disposed) return
            const data = new Uint8Array(buffer)
            const preview = new TextDecoder().decode(data.slice(0, 512)).trimStart()
            if (preview.startsWith('{')) {
              console.debug('[term ready] JSON-looking Blob frame treated as terminal data', {
                preview: preview.slice(0, 200),
                attachment,
                generation,
              })
            }
            snapshotWritten = false
            term.write(data, () => {
              snapshotWritten = true
              console.debug('[term ready] snapshot applied', { attachment, generation })
              maybeReady()
            })
          })
          return
        }

        const text = decoder.decode(bytes, { stream: true })
        const preview = text.trimStart()
        if (preview.startsWith('{')) {
          console.debug('[term ready] JSON-looking binary frame treated as terminal data', {
            preview: preview.slice(0, 200),
            attachment,
            generation,
          })
        }
        if (text.includes('Shell exited')) shellExited = true

        if (!snapshotWritten) {
          term.write(bytes, () => {
            snapshotWritten = true
            console.debug('[term ready] snapshot applied', { attachment, generation })
            maybeReady()
          })
        } else {
          term.write(bytes)
        }
      }

      ws.onclose = () => {
        clearInterval(keepalive)
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
        clearInterval(keepalive)
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
      if (!inputReady || !ws || ws.readyState !== WebSocket.OPEN) {
        if (inputDebugCount < 10) {
          inputDebugCount++
          console.debug('[term input] dropped', {
            inputReady,
            wsState: ws?.readyState,
            generation: currentGeneration,
          })
        }
        return
      }
      if (inputDebugCount < 10) {
        inputDebugCount++
        console.debug('[term input] sending', { length: data.length, wsState: ws.readyState, generation: currentGeneration })
      }
      ws.send(data)
    })

    const onResize = term.onResize(({ cols, rows }) => {
      lastSize = { cols, rows }
      const ws = currentWs
      if (inputReady && ws?.readyState === WebSocket.OPEN) sendResize(ws)
    })

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
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [term, paneId, setStatus, setMessage])
}
