import { type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { menuOpenAtom, menuViewAtom, type MenuView } from '../../wm/atoms'
import AboutView from './AboutView'
import AppSettingsView from './AppSettingsView'
import MainMenuView from './MainMenuView'
import SettingsView from './SettingsView'
import ShortcutsView from './ShortcutsView'
import { ChevronLeftIcon, CloseIcon } from '../icons'

const navBtn =
  'grid h-7 w-7 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-300'

/** True while the user is typing in a form control — keys must not navigate. */
function isFormField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable
}

/**
 * The unified Suwu menu dialog, iOS-settings style. The root screen is a
 * vertical list; selecting an item replaces the dialog content with that
 * screen. The header keeps global navigation: a Back button (on sub-screens)
 * and a Close button. Replaces the separate burger menu, shortcuts, settings,
 * and about dialogs; open state lives in menuOpenAtom so Alt+/ (TilingWM) and
 * the header burger share one entry point.
 *
 * Size is fixed across screens (the settings screen's size — the largest) so
 * switching screens never resizes the panel.
 *
 * Keyboard navigation: ArrowUp/ArrowDown move through the menu rows (Enter
 * opens), Backspace/ArrowLeft returns to the root from a sub-screen, Escape
 * closes the dialog (Radix).
 */
export default function SuwuDialog() {
  const { t } = useTranslation()
  const [open, setOpen] = useAtom(menuOpenAtom)
  const [view, setView] = useAtom(menuViewAtom)

  const isRoot = view === 'menu'
  const back = () => setView('menu')
  const close = () => setOpen(false)

  const TITLES: Record<MenuView, string> = {
    menu: t('app.title'),
    shortcuts: t('menu.shortcuts'),
    appSettings: t('menu.appSettings'),
    settings: t('menu.settings'),
    about: t('menu.about'),
  }

  // Global in-dialog keys: back from a sub-screen without grabbing focus
  // away from wherever the user is.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isRoot || e.altKey || e.ctrlKey || e.metaKey) return
    if ((e.key === 'Backspace' || e.key === 'ArrowLeft') && !isFormField(e.target)) {
      e.preventDefault()
      back()
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        aria-describedby={undefined}
        onKeyDown={onKeyDown}
        className="flex h-[682px] w-[576px] max-h-[95dvh] flex-col gap-0 overflow-hidden p-4"
      >
        <DialogTitle className="sr-only">{TITLES[view]}</DialogTitle>

        {/* Header: back (sub-screens only) · title · close */}
        <div className="flex h-8 shrink-0 items-center gap-2">
          {isRoot ? (
            <span className="h-7 w-7" aria-hidden="true" />
          ) : (
            <button type="button" onClick={back} aria-label={t('dialog.backToMenu')} className={navBtn}>
              <ChevronLeftIcon className="h-4 w-4" />
            </button>
          )}

          <span className="min-w-0 flex-1 truncate text-center text-sm font-semibold tracking-tight text-popover-foreground">
            {TITLES[view]}
          </span>

          <button type="button" onClick={close} aria-label={t('dialog.closeMenu')} className={navBtn}>
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Screen content; only the body scrolls under the fixed header */}
        {view !== 'appSettings' ? (
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-0.5">
            {view === 'menu' && <MainMenuView onSelect={setView} />}
            {view === 'shortcuts' && <ShortcutsView />}
            {view === 'settings' && <SettingsView />}
            {view === 'about' && <AboutView />}
          </div>
        ) : (
          <div className="mt-3 min-h-0 flex-1 overflow-hidden">
            <AppSettingsView onClose={close} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
