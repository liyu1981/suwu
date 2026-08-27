import { useEffect } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import type { Terminal } from '@xterm/xterm'
import { connectionMessageAtom, connectionStatusAtom } from '../store/connection'
import { useToken } from '../lib/api'

const RECONNECT_DELAY_MS = 2000

/**
 * Bridges an xterm.js Terminal to the Go server's WebSocket PTY endpoint.
 * Handles authentication via /api/token, input/output forwarding, resize, and
 * automatic reconnection. Connection state lives in Jotai atoms. Mouse
 * reporting sequences arrive via onData as well (xterm encodes them natively).
 */
export function usePtySession(term: Terminal | null) {
  const tokenQuery = useToken()
  const [, setStatus] = useAtom(connectionStatusAtom)
  const setMessage = useSetAtom(connectionMessageAtom)

  useEffect(() => {
    if (!term || !tokenQuery.data) return

    const token = tokenQuery.data
    let ws: WebSocket | null = null
    let reconnectTimer: number | undefined
    let disposed = false

    const connect = () => {
      if (disposed) return
      setStatus('connecting')
      setMessage('Authenticating...')

      const params = new URLSearchParams({
        cols: String(term.cols),
        rows: String(term.rows),
        token,
      })
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${protocol}//${window.location.host}/ws?${params}`)
      // PTY output arrives as binary frames (raw bytes, possibly invalid or
      // split UTF-8); xterm's write path reassembles partial sequences.
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        setStatus('connected')
        setMessage('Connected')
      }

      ws.onmessage = (event) => {
        const data = event.data
        term.write(typeof data === 'string' ? data : new Uint8Array(data))
      }

      ws.onclose = () => {
        if (disposed) return
        setStatus('disconnected')
        setMessage('Disconnected')
        term.write('\r\n\x1b[31mConnection closed. Reconnecting in 2s...\x1b[0m\r\n')
        reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS)
      }

      ws.onerror = () => {
        setStatus('disconnected')
        setMessage('Error')
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

    connect()

    return () => {
      disposed = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      ws?.close()
      onData.dispose()
      onResize.dispose()
    }
  }, [term, tokenQuery.data, setStatus, setMessage])

  return tokenQuery
}