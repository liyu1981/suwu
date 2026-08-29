import { useEffect, useRef } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { fetchToken } from '../lib/api'
import {
  maxEntriesAtom,
  notificationsAtom,
  panelOpenAtom,
  unreadCountAtom,
  type Notification,
} from '../store/notifications'

const RECONNECT_DELAY_MS = 3000

/**
 * Connects to the server's /ws/notify endpoint and streams Notification
 * messages into the Jotai notification store. Connection failures are logged
 * to the console; no error UI is shown.
 */
export function useNotifications() {
  const [notifications, setNotifications] = useAtom(notificationsAtom)
  const setUnread = useSetAtom(unreadCountAtom)
  const [panelOpen] = useAtom(panelOpenAtom)
  const [maxEntries] = useAtom(maxEntriesAtom)
  const panelOpenRef = useRef(panelOpen)

  // Keep ref in sync so the WebSocket onmessage callback sees the latest.
  panelOpenRef.current = panelOpen

  // Mark all as read when panel opens.
  useEffect(() => {
    if (panelOpen) {
      setUnread(0)
    }
  }, [panelOpen, setUnread])

  useEffect(() => {
    let ws: WebSocket | null = null
    let reconnectTimer: number | undefined
    let disposed = false

    const open = (token: string) => {
      const params = new URLSearchParams({ token })
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${protocol}//${window.location.host}/ws/notify?${params}`)

      ws.onmessage = (event) => {
        try {
          const n: Notification = JSON.parse(event.data)
          setNotifications((prev) => {
            const next = [...prev, n]
            return next.length > maxEntries ? next.slice(-maxEntries) : next
          })
          // Increment unread only when the panel is closed.
          if (!panelOpenRef.current) {
            setUnread((c) => c + 1)
          }
        } catch {
          // Malformed frame — ignore.
        }
      }

      ws.onclose = () => {
        if (disposed) return
        scheduleReconnect()
      }

      ws.onerror = () => {
        console.error('[suwu] notification websocket error')
        // onclose always follows onerror; no extra work needed.
      }
    }

    const scheduleReconnect = () => {
      reconnectTimer = window.setTimeout(() => {
        void connect()
      }, RECONNECT_DELAY_MS)
    }

    const connect = async () => {
      if (disposed) return
      try {
        const token = await fetchToken()
        if (!disposed) open(token)
      } catch {
        if (disposed) return
        console.error('[suwu] notification auth failed, retrying...')
        scheduleReconnect()
      }
    }

    void connect()

    return () => {
      disposed = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      ws?.close()
    }
  // setNotifications and setUnread are stable Jotai setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxEntries])
}
