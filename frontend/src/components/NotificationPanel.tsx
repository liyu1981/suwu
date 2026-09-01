import { useEffect, useRef, useState } from 'react'
import { useAtom, useSetAtom, useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { executeAction } from '../lib/actionResolver'
import { fetchToken } from '../lib/api'
import { maxEntriesAtom, notificationsAtom, panelOpenAtom, unreadCountAtom, type Notification } from '../store/notifications'
import { upgradingAtom } from '../store/update'
import { BellIcon, CheckIcon, CloseIcon, CopyIcon } from './icons'

const TRUNCATE_LEN = 140

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

function MessageRow({ n, onRead }: { n: Notification; onRead: (n: Notification) => void }) {
  const { t } = useTranslation()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = useStore() as any
  const setOpen = useSetAtom(panelOpenAtom)
  const setUpgrading = useSetAtom(upgradingAtom)
  const setNotifications = useSetAtom(notificationsAtom)
  const [upgradingLocal, setUpgradingLocal] = useState(false)
  const needsTruncation = n.message.length > TRUNCATE_LEN

  const handleDismiss = () => {
    setNotifications((prev) => prev.filter((x) => x.id !== n.id))
  }

  const isUpgrade = n.data?.action === 'upgrade'

  const handleAction = () => {
    if (n.data && !isUpgrade) {
      executeAction(n.data, store)
      setOpen(false)
    }
  }

  const handleUpgrade = async () => {
    setUpgradingLocal(true)
    setUpgrading(true)
    try {
      const token = await fetchToken()
      const res = await fetch(`/api/update/upgrade?token=${token}`, { method: 'POST' })
      if (res.ok) {
        // Remove the update notification.
        setNotifications((prev) => prev.filter((x) => x.id !== n.id))
        // Show a brief "upgrading" message then the server will restart.
        setTimeout(() => {
          // The server is restarting — the page will auto-reconnect.
        }, 1000)
      } else {
        setUpgradingLocal(false)
        setUpgrading(false)
      }
    } catch {
      setUpgradingLocal(false)
      setUpgrading(false)
    }
  }

  const actionLabel = isUpgrade
    ? t('notifications.upgrade')
    : n.data?.payload.type === 'dir'
      ? t('notifications.openInFileBrowser')
      : t('notifications.openInViewr')

  return (
    <div className="group relative rounded px-3 py-2 transition hover:bg-white/5">
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t('notifications.dismiss')}
        className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded text-muted-foreground opacity-0 transition hover:bg-white/10 hover:text-white group-hover:opacity-100"
      >
        <CloseIcon className="h-3 w-3" />
      </button>
      <p className="break-words pr-4 text-xs leading-relaxed text-popover-foreground">
        {needsTruncation ? n.message.slice(0, TRUNCATE_LEN) + '…' : n.message}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {n.data && (
          <button
            type="button"
            onClick={isUpgrade ? handleUpgrade : handleAction}
            disabled={upgradingLocal}
            className={`rounded px-2 py-0.5 text-[10px] font-medium transition ${
              isUpgrade
                ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 hover:text-emerald-200 disabled:opacity-50'
                : 'bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 hover:text-sky-200'
            }`}
          >
            {upgradingLocal ? t('notifications.upgrading') : actionLabel}
          </button>
        )}
        {needsTruncation && (
          <button
            type="button"
            onClick={() => onRead(n)}
            className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-medium text-white/60 transition hover:bg-white/15 hover:text-white/80"
          >
            {t('notifications.read')}
          </button>
        )}
      </div>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{relativeTime(n.timestamp, t)}</p>
    </div>
  )
}

function TextReader({ message, onClose }: { message: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      role="dialog"
      aria-label={t('notifications.reader')}
      className="flex h-full flex-col rounded-xl border border-white/10 menu-glass animate-panel-in"
    >
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-3">
        <span className="min-w-0 flex-1 text-xs font-semibold tracking-tight text-popover-foreground">
          {t('notifications.reader')}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="grid h-6 w-6 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white"
          title={t('notifications.copy')}
        >
          {copied ? (
            <CheckIcon className="h-3.5 w-3.5 text-green-400" />
          ) : (
            <CopyIcon className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('notifications.closeReader')}
          className="grid h-6 w-6 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-popover-foreground">{message}</pre>
      </div>
    </div>
  )
}

function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
      <BellIcon className="h-8 w-8 opacity-30" />
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
  const [readerMsg, setReaderMsg] = useState<string | null>(null)

  // Escape closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (readerMsg) {
          setReaderMsg(null)
        } else {
          setOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen, readerMsg])

  const clearAll = () => {
    setNotifications([])
    setUnread(0)
    setReaderMsg(null)
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

      <div className="fixed right-4 top-4 bottom-4 z-50 flex gap-2" data-state="open">
        {/* Text reader (left of panel) */}
        {readerMsg !== null && (
          <div className="hidden h-full w-[min(90vw,28rem)] md:block">
            <TextReader message={readerMsg} onClose={() => setReaderMsg(null)} />
          </div>
        )}

        {/* Notification panel */}
        <div
          role="dialog"
          aria-label={t('notifications.title')}
          className="flex w-[min(90vw,20rem)] flex-col rounded-xl border border-white/10 menu-glass animate-panel-in"
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
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Message list */}
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
            {notifications.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="flex flex-col gap-0.5">
                {[...notifications].reverse().map((n) => (
                  <MessageRow key={n.id} n={n} onRead={(msg) => setReaderMsg(msg.message)} />
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
      </div>
    </>
  )
}
