import { useState } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { Trans, useTranslation } from 'react-i18next'
import { fetchToken } from '../../lib/api'
import { maxEntriesAtom, notificationsAtom, panelOpenAtom, unreadCountAtom, type Notification } from '../../store/notifications'

const row = 'flex items-baseline justify-between gap-4 py-1.5'
const rowLabel = 'text-xs text-muted-foreground'
const rowValue = 'text-xs text-popover-foreground'

const GITHUB_URL = 'https://github.com/liyu1981/suwu'

const kbd =
  'rounded border border-white/15 bg-white/10 px-1 font-mono text-[10px]'

interface UpdateCheckResponse {
  current: string
  latest: string
  updateAvailable: boolean
  error?: string
}

/**
 * About screen for the unified Suwu menu dialog: a centered brand mark, the
 * app name, version, and a GitHub link, followed by the feature list and
 * meta rows. Version comes from the root package.json via the
 * __SUWU_VERSION__ define in vite.config.ts.
 */
export default function AboutView() {
  const { t } = useTranslation()
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<string | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = useStore() as any
  const setNotifications = useSetAtom(notificationsAtom)
  const setUnread = useSetAtom(unreadCountAtom)
  const panelOpen = useAtomValue(panelOpenAtom)
  const maxEntries = useAtomValue(maxEntriesAtom)

  const handleCheckUpdate = async () => {
    setChecking(true)
    setCheckResult(null)
    try {
      const token = await fetchToken()
      const res = await fetch(`/api/update/check?token=${token}`)
      if (!res.ok) {
        setCheckResult('Failed to check for updates')
        setChecking(false)
        return
      }
      const info: UpdateCheckResponse = await res.json()
      if (info.error) {
        setCheckResult('Update check failed')
        setChecking(false)
        return
      }
      if (info.updateAvailable) {
        // Inject notification.
        const notifId = `update-${info.latest}`
        const existing = store.get(notificationsAtom) as Notification[]
        if (!existing.some((n) => n.id === notifId)) {
          const notification: Notification = {
            id: notifId,
            message: `New version ${info.latest} available (current: ${info.current})`,
            timestamp: Date.now(),
            data: {
              action: 'upgrade',
              payload: { type: 'upgrade', latest: info.latest } as never,
            },
          }
          setNotifications((prev: Notification[]) => {
            const next = [...prev, notification]
            return next.length > maxEntries ? next.slice(-maxEntries) : next
          })
          if (!panelOpen) {
            setUnread((c: number) => c + 1)
          }
        }
        setCheckResult(`Update available: ${info.latest}`)
      } else {
        setCheckResult('Already up to date')
      }
    } catch {
      setCheckResult('Failed to check for updates')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      {/* Vertically centered brand content */}
      <div className="flex flex-1 flex-col items-center justify-center">
        <img
          src="/logo.svg"
          alt="Suwu logo"
          width={256}
          height={256}
          className="h-64 w-64 rounded-[56px] shadow-[0_12px_40px_rgb(0_0_0/0.35)]"
        />
        <div className="mt-4 text-center">
          <div className="text-2xl font-semibold tracking-tight text-popover-foreground">Suwu</div>
          <div className="mt-1 text-xs text-muted-foreground italic">Make the remote shell enjoyable in agentic AI time.</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{t('about.version', { version: __SUWU_VERSION__ })}</div>
        </div>
        <div className="mt-3 flex flex-col items-center gap-2">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-muted-foreground glass-btn transition hover:text-popover-foreground"
          >
            <GitHubIcon />
            <span className="font-medium">{t('about.github')}</span>
          </a>
          <button
            type="button"
            onClick={handleCheckUpdate}
            disabled={checking}
            className="text-[11px] text-muted-foreground transition hover:text-popover-foreground disabled:opacity-50"
          >
            {checking ? '...' : checkResult ?? t('notifications.checkForUpdates')}
          </button>
        </div>
      </div>

      {/* Shortcuts hint pinned to bottom */}
      <div className={`${row} shrink-0 pt-2`}>
        <span className={rowLabel}>{t('about.shortcuts')}</span>
        <span className={rowValue}>
          <Trans i18nKey="about.shortcutsHint" components={{ 1: <kbd className={kbd} />, 2: <kbd className={kbd} />, 3: <kbd className={kbd} />, 4: <kbd className={kbd} />, 5: <kbd className={kbd} /> }} />
        </span>
      </div>
    </div>
  )
}

function GitHubIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}
