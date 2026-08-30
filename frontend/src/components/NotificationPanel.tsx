import { useEffect, useRef } from 'react'
import { useAtom, useSetAtom, useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { executeAction } from '../lib/actionResolver'
import { maxEntriesAtom, notificationsAtom, panelOpenAtom, unreadCountAtom, type Notification } from '../store/notifications'

function relativeTime(ts: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return t('notifications.justNow')
  const min = Math.floor(sec / 60)
  if (min < 60) return t('notifications.minutesAgo', { count: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('notifications.hoursAgo', { count: hr })
  const d = Math.floor(hr / 24)
  return t('notifications.daysAgo', { count: d })
}

function MessageRow({ n }: { n: Notification }) {
  const { t } = useTranslation()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = useStore() as any
  const setOpen = useSetAtom(panelOpenAtom)

  const handleAction = () => {
    if (n.data) {
      executeAction(n.data, store)
      setOpen(false)
    }
  }

  const actionLabel = n.data?.payload.type === 'dir'
    ? t('notifications.openInFileBrowser')
    : t('notifications.openInViewr')

  return (
    <div className="rounded px-3 py-2 transition hover:bg-white/5">
      <p className="break-words text-xs leading-relaxed text-popover-foreground">{n.message}</p>
      {n.data && (
        <button
          type="button"
          onClick={handleAction}
          className="mt-1.5 rounded bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-300 transition hover:bg-sky-500/25 hover:text-sky-200"
        >
          {actionLabel}
        </button>
      )}
      <p className="mt-0.5 text-[10px] text-muted-foreground">{relativeTime(n.timestamp, t)}</p>
    </div>
  )
}

function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
      <svg className="h-8 w-8 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      <p className="text-xs">{t('notifications.empty')}</p>
    </div>
  )
}

export function NotificationPanel() {
  const { t } = useTranslation()
  const [open, setOpen] = useAtom(panelOpenAtom)
  const [notifications, setNotifications] = useAtom(notificationsAtom)
  const [, setUnread] = useAtom(unreadCountAtom)
  const [maxEntries] = useAtom(maxEntriesAtom)
  const listRef = useRef<HTMLDivElement>(null)



  // Escape closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  const clearAll = () => {
    setNotifications([])
    setUnread(0)
  }

  if (!open) return null

  return (
    <>
      {/* Backdrop — same styling as the dialog overlay */}
      <div
        aria-hidden="true"
        className="fixed inset-0 z-40 bg-black/45 backdrop-blur-md"
        onClick={() => setOpen(false)}
        data-state="open"
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-label={t('notifications.title')}
        data-state="open"
        className="fixed right-4 top-4 bottom-4 z-50 flex w-[min(90vw,20rem)] flex-col rounded-xl border border-white/10 menu-glass animate-panel-in"
      >
        {/* Header */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-3">
          <span className="min-w-0 flex-1 text-xs font-semibold tracking-tight text-popover-foreground">
            {t('notifications.title')}
          </span>
          {notifications.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="text-[10px] text-muted-foreground transition hover:text-white"
            >
              {t('notifications.clearAll')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t('notifications.close')}
            className="grid h-6 w-6 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* Message list */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          {notifications.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="flex flex-col gap-0.5">
              {[...notifications].reverse().map((n) => (
                <MessageRow key={n.id} n={n} />
              ))}
            </div>
          )}
        </div>

        {/* Footer with entry count */}
        <div className="flex h-8 shrink-0 items-center justify-center border-t border-white/10">
          <span className="text-[10px] text-muted-foreground">
            {notifications.length} / {maxEntries}
          </span>
        </div>
      </div>
    </>
  )
}
