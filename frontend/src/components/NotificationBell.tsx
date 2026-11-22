import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { panelOpenAtom, unreadCountAtom } from '../store/notifications';
import { BellIcon } from './icons';

const wmBase =
  'relative grid h-7 w-7 place-items-center rounded transition glass-btn disabled:cursor-not-allowed disabled:opacity-40';
const wmBtn = `${wmBase} text-slate-300 hover:bg-white/10 hover:text-white`;

export function NotificationBell() {
  const { t } = useTranslation();
  const [open, setOpen] = useAtom(panelOpenAtom);
  const [unread] = useAtom(unreadCountAtom);

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
        <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-0.5 text-[10px] font-bold leading-none text-black">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}
