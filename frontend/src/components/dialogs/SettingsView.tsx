import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { maxEntriesAtom } from '../../store/notifications'
import { autoResolveAtom } from '../../store/settings'
import { Select, SelectTrigger, SelectContent, SelectItem } from '../ui/select'

const section = 'rounded-[6px] border border-white/10 bg-black/20 p-3'
const sectionLabel = 'text-xs font-medium text-muted-foreground'
const sectionHint = 'mt-2 text-[10px] leading-relaxed text-muted-foreground'

const tabBtn =
  'rounded px-2.5 py-1.5 text-left text-xs text-muted-foreground outline-none transition-colors ' +
  'hover:bg-white/5 hover:text-popover-foreground focus-visible:ring-1 focus-visible:ring-sky-400/60 ' +
  'data-[state=active]:bg-white/10 data-[state=active]:text-popover-foreground'

const toggle =
  'relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ' +
  'bg-white/15 data-[state=checked]:bg-sky-500/60'

const toggleThumb =
  'block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform ' +
  'data-[state=checked]:translate-x-4'

function Toggle({
  checked,
  onCheckedChange,
}: {
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? 'checked' : 'unchecked'}
      className={toggle}
      onClick={() => onCheckedChange(!checked)}
    >
      <span data-state={checked ? 'checked' : 'unchecked'} className={toggleThumb} />
    </button>
  )
}

/**
 * Settings screen: Notifications, Actions, and Language preferences.
 */
export default function SettingsView() {
  const { t } = useTranslation()
  const [maxEntries, setMaxEntries] = useAtom(maxEntriesAtom)
  const [autoResolve, setAutoResolve] = useAtom(autoResolveAtom)

  return (
    <div>
      <TabsPrimitive.Root
        defaultValue="notifications"
        orientation="vertical"
        className="flex items-start gap-3"
      >
        <TabsPrimitive.List
          aria-label="Settings sections"
          className="flex w-28 shrink-0 flex-col gap-1"
        >
          <TabsPrimitive.Trigger value="notifications" className={tabBtn}>
            {t('settings.notificationsTab')}
          </TabsPrimitive.Trigger>
          <TabsPrimitive.Trigger value="actions" className={tabBtn}>
            {t('settings.actionsTab')}
          </TabsPrimitive.Trigger>
          <TabsPrimitive.Trigger value="language" className={tabBtn}>
            {t('settings.language')}
          </TabsPrimitive.Trigger>
        </TabsPrimitive.List>

        <TabsPrimitive.Content value="notifications" className="min-w-0 flex-1">
          <div className={section}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.maxMessageHistory')}</span>
              <span className="font-mono text-xs text-popover-foreground">{maxEntries}</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="range"
                min={10}
                max={9999}
                step={10}
                value={maxEntries}
                onChange={(e) => setMaxEntries(Number(e.target.value))}
                aria-label="Max notification entries"
                className="h-1 flex-1 cursor-pointer appearance-none rounded bg-white/15 accent-sky-400"
              />
            </div>
            <p className={sectionHint}>
              {t('settings.maxMessageHistoryHint')}
            </p>
          </div>
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="actions" className="min-w-0 flex-1">
          <div className={section}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.autoResolveTitle')}</span>
            </div>
            <p className={sectionHint}>
              {t('settings.autoResolveHint')}
            </p>

            <div className="mt-3 divide-y divide-white/5">
              <div className="flex items-center justify-between py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-popover-foreground">{t('plugin.fileBrowser')}</span>
                </div>
                <Toggle
                  checked={autoResolve.filebrowser}
                  onCheckedChange={(v) => setAutoResolve({ ...autoResolve, filebrowser: v })}
                />
              </div>
              <div className="flex items-center justify-between py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-popover-foreground">{t('plugin.viewer')}</span>
                </div>
                <Toggle
                  checked={autoResolve.fileviewer}
                  onCheckedChange={(v) => setAutoResolve({ ...autoResolve, fileviewer: v })}
                />
              </div>
              <div className="flex items-center justify-between py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-popover-foreground">{t('plugin.forward')}</span>
                </div>
                <Toggle
                  checked={autoResolve.forward}
                  onCheckedChange={(v) => setAutoResolve({ ...autoResolve, forward: v })}
                />
              </div>
            </div>
          </div>
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="language" className="min-w-0 flex-1">
          <div className={section}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.language')}</span>
            </div>
            <Select value={i18n.language} onValueChange={(v) => i18n.changeLanguage(v)}>
              <SelectTrigger aria-label={t('settings.language')} className="mt-2">
                <span>{i18n.language === 'en' ? t('lang.en') : t('lang.zh_CN')}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">{t('lang.en')}</SelectItem>
                <SelectItem value="zh_CN">{t('lang.zh_CN')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>
    </div>
  )
}
