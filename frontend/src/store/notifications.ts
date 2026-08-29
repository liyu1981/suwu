import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

export interface NotificationData {
  action: string
  payload: {
    type: 'dir' | 'file'
    path: string
  }
}

export interface Notification {
  id: string
  message: string
  timestamp: number
  data?: NotificationData
}

/** Persisted message history, capped at maxEntries. */
export const notificationsAtom = atomWithStorage<Notification[]>('suwu:notifications', [])

/** Number of unread notifications since the panel was last opened. */
export const unreadCountAtom = atom(0)

/** Max entries kept in localStorage (configurable in settings). */
export const maxEntriesAtom = atomWithStorage('suwu:max-entries', 999)

/** Whether the notification panel is open. */
export const panelOpenAtom = atom(false)
