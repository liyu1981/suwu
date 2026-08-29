import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { panelOpenAtom, unreadCountAtom } from '../store/notifications'

const wmBase =
  'relative grid h-7 w-7 place-items-center rounded transition glass-btn disabled:cursor-not-allowed disabled:opacity-40'
const wmBtn = `${wmBase} text-slate-300 hover:bg-white/10 hover:text-white`

function BellIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}

export function NotificationBell() {
  const { t } = useTranslation()
  const [open, setOpen] = useAtom(panelOpenAtom)
  const [unread] = useAtom(unreadCountAtom)

  return (
    <button
      type="button"
      aria-label={open ? t('notifications.close') : t('notifications.open')}
      aria-expanded={open}
      className={wmBtn}
      onClick={() => setOpen((v) => !v)}
    >
      <BellIcon />
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-0.5 text-[8px] font-bold leading-none text-black">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  )
}
