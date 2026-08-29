import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { maxEntriesAtom } from '../../store/notifications'

const section = 'rounded-[6px] border border-white/10 bg-black/20 p-3'
const sectionLabel = 'text-xs font-medium text-muted-foreground'
const sectionHint = 'mt-2 text-[10px] leading-relaxed text-muted-foreground'

const tabBtn =
  'rounded px-2.5 py-1.5 text-left text-xs text-muted-foreground outline-none transition-colors ' +
  'hover:bg-white/5 hover:text-popover-foreground focus-visible:ring-1 focus-visible:ring-sky-400/60 ' +
  'data-[state=active]:bg-white/10 data-[state=active]:text-popover-foreground'

/**
 * Settings screen: Notifications and Language preferences.
 */
export default function SettingsView() {
  const { t } = useTranslation()
  const [maxEntries, setMaxEntries] = useAtom(maxEntriesAtom)

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

        <TabsPrimitive.Content value="language" className="min-w-0 flex-1">
          <div className={section}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.language')}</span>
            </div>
            <select
              value={i18n.language}
              onChange={(e) => i18n.changeLanguage(e.target.value)}
              aria-label={t('settings.language')}
              className="mt-2 h-8 w-full rounded border border-white/10 bg-black/30 px-2 text-xs text-popover-foreground focus:border-sky-400/60 focus:outline-none"
            >
              <option value="en">{t('lang.en')}</option>
              <option value="zh_CN">{t('lang.zh_CN')}</option>
            </select>
          </div>
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>
    </div>
  )
}
