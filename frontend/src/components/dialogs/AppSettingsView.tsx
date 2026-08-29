import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { FONT_MAX, FONT_MIN, clampFont, fontDefaultAtom, fontSizeAtom } from '../../store/fonts'
import {
  FILE_BROWSER_BG_DEFAULT,
  FONT_FAMILIES,
  TERMINAL_THEME_DEFAULT,
  type TerminalTheme,
  fileBrowserBgAtom,
  fontFamilyAtom,
  termThemeAtom,
} from '../../store/appearance'
import { alphaOf, hex6Of, withAlpha } from '../../lib/color'

const stepBtn =
  'h-7 w-7 place-items-center rounded text-slate-300 transition glass-btn disabled:cursor-not-allowed disabled:opacity-40'
const actionBtn =
  'rounded px-3 py-1.5 text-xs font-semibold glass-btn bg-white/10 text-popover-foreground hover:text-white'
const section = 'rounded-[6px] border border-white/10 bg-black/20 p-3'
const sectionLabel = 'text-xs font-medium text-muted-foreground'
const sectionHint = 'mt-2 text-[10px] leading-relaxed text-muted-foreground'

const tabBtn =
  'rounded px-2.5 py-1.5 text-left text-xs text-muted-foreground outline-none transition-colors ' +
  'hover:bg-white/5 hover:text-popover-foreground focus-visible:ring-1 focus-visible:ring-sky-400/60 ' +
  'data-[state=active]:bg-white/10 data-[state=active]:text-popover-foreground'

function ColorRow(props: { label: string; value: string; onChange: (next: string) => void }) {
  const { label, value, onChange } = props
  const hex6 = hex6Of(value, TERMINAL_THEME_DEFAULT.background)
  const alpha = alphaOf(value)
  const pct = Math.round(alpha * 100)
  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <input
        type="color"
        value={hex6}
        onChange={(e) => onChange(withAlpha(e.target.value, alpha))}
        aria-label={`${label} color`}
        className="h-7 w-9 shrink-0 cursor-pointer rounded border border-white/10 bg-transparent p-0.5"
      />
      <input
        type="range"
        min={0}
        max={100}
        value={pct}
        onChange={(e) => onChange(withAlpha(hex6, Number(e.target.value) / 100))}
        aria-label={`${label} opacity`}
        className="h-1 flex-1 cursor-pointer appearance-none rounded bg-white/15 accent-sky-400"
      />
      <span className="w-9 shrink-0 text-right font-mono text-xs text-popover-foreground">{pct}%</span>
    </div>
  )
}

/**
 * Application Settings screen: Term Settings and File Browser settings,
 * with font-size Reset / Save as default actions.
 */
export default function AppSettingsView(props: { onClose: () => void }) {
  const { onClose } = props
  const { t } = useTranslation()
  const [fontSize, setFontSize] = useAtom(fontSizeAtom)
  const [defaultSize, setDefaultSize] = useAtom(fontDefaultAtom)
  const [fontFamily, setFontFamily] = useAtom(fontFamilyAtom)
  const [termTheme, setTermTheme] = useAtom(termThemeAtom)
  const [fileBrowserBg, setFileBrowserBg] = useAtom(fileBrowserBgAtom)

  const setThemeColor = (key: keyof TerminalTheme) => (next: string) =>
    setTermTheme({ ...termTheme, [key]: next })
  const knownFamily = FONT_FAMILIES.some((f) => f.value === fontFamily)

  return (
    <div>
      <TabsPrimitive.Root
        defaultValue="term"
        orientation="vertical"
        className="flex items-start gap-3"
      >
        <TabsPrimitive.List
          aria-label="Application Settings sections"
          className="flex w-28 shrink-0 flex-col gap-1"
        >
          <TabsPrimitive.Trigger value="term" className={tabBtn}>
            {t('settings.termTab')}
          </TabsPrimitive.Trigger>
          <TabsPrimitive.Trigger value="filebrowser" className={tabBtn}>
            {t('settings.fileBrowserTab')}
          </TabsPrimitive.Trigger>
        </TabsPrimitive.List>

        <TabsPrimitive.Content value="term" className="min-w-0 flex-1">
          <div className={section}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.fontSize')}</span>
              <span className="font-mono text-xs text-popover-foreground">{fontSize}px</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                className={stepBtn}
                disabled={fontSize <= FONT_MIN}
                onClick={() => setFontSize(clampFont(fontSize - 1))}
                aria-label="Decrease font size"
              >
                <svg
                  className="mx-auto h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M5 12h14" />
                </svg>
              </button>
              <input
                type="range"
                min={FONT_MIN}
                max={FONT_MAX}
                value={fontSize}
                onChange={(e) => setFontSize(clampFont(Number(e.target.value)))}
                aria-label="Terminal font size"
                className="h-1 flex-1 cursor-pointer appearance-none rounded bg-white/15 accent-sky-400"
              />
              <button
                type="button"
                className={stepBtn}
                disabled={fontSize >= FONT_MAX}
                onClick={() => setFontSize(clampFont(fontSize + 1))}
                aria-label="Increase font size"
              >
                <svg
                  className="mx-auto h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
            <p className={sectionHint}>
              {t('settings.fontSizeHint', { defaultSize })}
            </p>
          </div>

          <div className={`${section} mt-3`}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.fontFamily')}</span>
            </div>
            <select
              value={fontFamily}
              onChange={(e) => setFontFamily(e.target.value)}
              aria-label="Terminal font family"
              className="mt-2 h-8 w-full rounded border border-white/10 bg-black/30 px-2 text-xs text-popover-foreground focus:border-sky-400/60 focus:outline-none"
            >
              {!knownFamily && <option value={fontFamily}>{t('settings.custom')}</option>}
              {FONT_FAMILIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <p className={sectionHint}>{t('settings.fontFamilyHint')}</p>
          </div>

          <div className={`${section} mt-3`}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.themeColors')}</span>
              <button
                type="button"
                onClick={() => setTermTheme(TERMINAL_THEME_DEFAULT)}
                className="text-[10px] text-muted-foreground underline-offset-2 hover:text-white hover:underline"
              >
                {t('settings.resetColors')}
              </button>
            </div>
            <ColorRow
              label={t('settings.background')}
              value={termTheme.background}
              onChange={setThemeColor('background')}
            />
            <ColorRow
              label={t('settings.foreground')}
              value={termTheme.foreground}
              onChange={setThemeColor('foreground')}
            />
            <ColorRow
              label={t('settings.cursor')}
              value={termTheme.cursor}
              onChange={setThemeColor('cursor')}
            />
            <p className={sectionHint}>
              {t('settings.themeHint')}
            </p>
          </div>
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="filebrowser" className="min-w-0 flex-1">
          <div className={section}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.bgColor')}</span>
              <button
                type="button"
                onClick={() => setFileBrowserBg(FILE_BROWSER_BG_DEFAULT)}
                className="text-[10px] text-muted-foreground underline-offset-2 hover:text-white hover:underline"
              >
                {t('settings.reset')}
              </button>
            </div>
            <ColorRow
              label={t('settings.background')}
              value={fileBrowserBg}
              onChange={setFileBrowserBg}
            />
            <p className={sectionHint}>
              {t('settings.fileBrowserHint')}
            </p>
          </div>
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setFontSize(defaultSize)}
          className={`${actionBtn} text-muted-foreground hover:text-white`}
        >
          {t('settings.resetBtn', { size: defaultSize })}
        </button>
        <button
          type="button"
          onClick={() => {
            setDefaultSize(fontSize)
            onClose()
          }}
          className={actionBtn}
        >
          {t('settings.saveAsDefault')}
        </button>
      </div>
    </div>
  )
}
