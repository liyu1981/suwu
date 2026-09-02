import { useEffect, useRef } from 'react'
import { useAtom, useSetAtom, useStore } from 'jotai'
import { fetchToken } from '../../lib/api'
import { lastUpdateCheckAtom } from '../../store/update'
import { maxEntriesAtom, notificationsAtom, panelOpenAtom, unreadCountAtom, type Notification } from '../../store/notifications'

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

interface UpdateCheckResponse {
  current: string
  latest: string
  updateAvailable: boolean
  releaseNotes?: string
  error?: string
}

/**
 * Periodically checks the server for updates (once per 24 hours).
 * When an update is available, injects a notification with action type
 * "upgrade" into the notification store.
 */
export function useUpdateCheck() {
  const [lastCheck, setLastCheck] = useAtom(lastUpdateCheckAtom)
  const store = useStore()
  const [, setNotifications] = useAtom(notificationsAtom)
  const setUnread = useSetAtom(unreadCountAtom)
  const [panelOpen] = useAtom(panelOpenAtom)
  const [maxEntries] = useAtom(maxEntriesAtom)
  const panelOpenRef = useRef(panelOpen)

  panelOpenRef.current = panelOpen

  useEffect(() => {
    const check = async () => {
      // Skip if checked within the last 24 hours.
      if (Date.now() - lastCheck < CHECK_INTERVAL_MS) return

      try {
        const token = await fetchToken()
        const res = await fetch(`/api/update/check?token=${token}`)
        if (!res.ok) return

        const info: UpdateCheckResponse = await res.json()
        if (!info.updateAvailable || info.error) return

        // Check if we already have this notification (avoid duplicates).
        const existing = store.get(notificationsAtom) as Notification[]
        const notifId = `update-${info.latest}`
        if (existing.some((n) => n.id === notifId)) return

        // Inject update notification.
        const notification: Notification = {
          id: notifId,
          message: `New version ${info.latest} available (current: ${info.current})`,
          timestamp: Date.now(),
          data: {
            action: 'upgrade',
            payload: { type: 'upgrade', latest: info.latest } as never,
          },
        }

        setNotifications((prev) => {
          const next = [...prev, notification]
          return next.length > maxEntries ? next.slice(-maxEntries) : next
        })
        if (!panelOpenRef.current) {
          setUnread((c) => c + 1)
        }

        setLastCheck(Date.now())
      } catch {
        // Silent fail — will retry next interval.
      }
    }

    check()
    const interval = setInterval(check, CHECK_INTERVAL_MS)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxEntries])
}
