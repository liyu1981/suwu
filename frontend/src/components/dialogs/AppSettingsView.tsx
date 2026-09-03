import { useCallback, useMemo, useState } from 'react'
import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { FONT_MAX, FONT_MIN, LINE_HEIGHT_DEFAULT, LINE_HEIGHT_MAX, LINE_HEIGHT_MIN, LINE_HEIGHT_STEP, clampFont, clampLineHeight, fontDefaultAtom, fontSizeAtom, lineHeightAtom, lineHeightDefaultAtom } from '../../store/fonts'
import {
  FILE_BROWSER_BG_DEFAULT,
  FONT_FAMILIES,
  TERMINAL_THEME_DEFAULT,
  type TerminalTheme,
  fileBrowserBgAtom,
  fontFamilyAtom,
  termThemeAtom,
} from '../../store/appearance'
import { dropboxZoomAtom, fileBrowserZoomAtom, forwardZoomAtom, gitGraphZoomAtom, clampZoom, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from '../../store/zoom'
import { ZoomControls } from '../ZoomControls'
import { THEME_PRESETS, matchPresetId } from '../../store/themePresets'
import { alphaOf, hex6Of, withAlpha } from '../../lib/color'
import { Combobox } from '../ui/combobox'
import { ThemeSelect } from '../ui/theme-select'

// ── Style constants ──────────────────────────────────────────────────

const stepBtn =
  'h-7 w-7 place-items-center rounded text-slate-300 transition glass-btn disabled:cursor-not-allowed disabled:opacity-40'
const actionBtn =
  'rounded px-3 py-1.5 text-xs font-semibold glass-btn bg-white/10 text-popover-foreground hover:text-white'
const section = 'rounded-[6px] border border-white/10 bg-black/20 p-3'
const sectionLabel = 'text-xs font-medium text-muted-foreground'
const sectionHint = 'mt-2 text-[10px] leading-relaxed text-muted-foreground'
const groupHeader =
  'flex items-center justify-between select-none cursor-pointer rounded px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-popover-foreground'

const tabBtn =
  'rounded px-2.5 py-1.5 text-left text-xs text-muted-foreground outline-none transition-colors ' +
  'hover:bg-white/5 hover:text-popover-foreground focus-visible:ring-1 focus-visible:ring-sky-400/60 ' +
  'data-[state=active]:bg-white/10 data-[state=active]:text-popover-foreground'

// ── Reusable sub-components ──────────────────────────────────────────

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

/** Collapsible group header with a chevron. */
function GroupToggle(props: { label: string; open: boolean; onToggle: () => void }) {
  const { label, open, onToggle } = props
  return (
    <button type="button" className={groupHeader} onClick={onToggle}>
      {label}
      <svg
        className={`h-3 w-3 shrink-0 opacity-50 transition-transform ${open ? 'rotate-90' : ''}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m9 6 6 6-6 6" />
      </svg>
    </button>
  )
}

/**
 * Zoom setting for an app: A− / % / A+ buttons plus a slider (100%–500%).
 */
function ZoomSetting(props: { zoom: number; onChange: (z: number) => void; hint: string }) {
  const { zoom, onChange, hint } = props
  const { t } = useTranslation()
  const pct = Math.round(zoom * 100)
  return (
    <div className={section}>
      <div className="flex items-center justify-between">
        <span className={sectionLabel}>{t('settings.zoom')}</span>
        <span className="font-mono text-xs text-popover-foreground">{pct}%</span>
      </div>
      <div className="mt-2">
        <ZoomControls zoom={zoom} onChange={onChange} />
      </div>
      <div className="mt-2">
        <input
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          value={zoom}
          onChange={(e) => onChange(clampZoom(Number(e.target.value)))}
          aria-label="Zoom level"
          className="h-1 w-full cursor-pointer appearance-none rounded bg-white/15 accent-sky-400"
        />
      </div>
      <p className={sectionHint}>{hint}</p>
    </div>
  )
}

// ── ANSI color key lists ─────────────────────────────────────────────

const ANSI_NORMAL: (keyof TerminalTheme)[] = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
]
const ANSI_BRIGHT: (keyof TerminalTheme)[] = [
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
]
const ANSI_LABELS: Record<string, string> = {
  black: 'Black', red: 'Red', green: 'Green', yellow: 'Yellow',
  blue: 'Blue', magenta: 'Magenta', cyan: 'Cyan', white: 'White',
  brightBlack: 'Bright black', brightRed: 'Bright red', brightGreen: 'Bright green',
  brightYellow: 'Bright yellow', brightBlue: 'Bright blue', brightMagenta: 'Bright magenta',
  brightCyan: 'Bright cyan', brightWhite: 'Bright white',
}

// ── Font combobox items ──────────────────────────────────────────────

const FONT_ITEMS = FONT_FAMILIES.map((f) => ({ label: f.label, value: f.value }))

// ── Main component ───────────────────────────────────────────────────

/**
 * Application Settings screen. Each app gets a tab; the Term tab owns the
 * font-size Reset / Save-as-default footer actions, other tabs expose their
 * own settings (background color, zoom level) with no footer.
 */
export default function AppSettingsView(props: { onClose: () => void }) {
  const { onClose } = props
  const { t } = useTranslation()
  const [tab, setTab] = useState('term')

  // Term
  const [fontSize, setFontSize] = useAtom(fontSizeAtom)
  const [defaultSize, setDefaultSize] = useAtom(fontDefaultAtom)
  const [lineHeight, setLineHeight] = useAtom(lineHeightAtom)
  const [lineHeightDefault, setLineHeightDefault] = useAtom(lineHeightDefaultAtom)
  const [fontFamily, setFontFamily] = useAtom(fontFamilyAtom)
  const [termTheme, setTermTheme] = useAtom(termThemeAtom)

  // File Browser
  const [fileBrowserBg, setFileBrowserBg] = useAtom(fileBrowserBgAtom)
  const [fileBrowserZoom, setFileBrowserZoom] = useAtom(fileBrowserZoomAtom)

  // Dropbox / Port Forwarding / Git Graph
  const [dropboxZoom, setDropboxZoom] = useAtom(dropboxZoomAtom)
  const [forwardZoom, setForwardZoom] = useAtom(forwardZoomAtom)
  const [gitGraphZoom, setGitGraphZoom] = useAtom(gitGraphZoomAtom)

  // ── Collapsible groups state ────────────────────────────────────
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    core: true,
    selection: false,
    ansi: false,
  })
  const toggleGroup = useCallback(
    (key: string) => setOpenGroups((g) => ({ ...g, [key]: !g[key] })),
    [],
  )

  // ── Theme helpers ───────────────────────────────────────────────
  const setThemeColor = useCallback(
    (key: keyof TerminalTheme) => (next: string) =>
      setTermTheme((prev) => ({ ...prev, [key]: next })),
    [setTermTheme],
  )

  /** Apply a full preset, preserving the current background alpha. */
  const applyPreset = useCallback(
    (presetId: string) => {
      const preset = THEME_PRESETS.find((p) => p.id === presetId)
      if (!preset) return
      // Preserve user's background alpha when switching presets.
      const currentAlpha = alphaOf(termTheme.background)
      const newBg = withAlpha(preset.theme.background.slice(0, 7), currentAlpha)
      setTermTheme({ ...preset.theme, background: newBg })
    },
    [termTheme.background, setTermTheme],
  )

  /** Global background opacity change — strip alpha from preset bg, apply new alpha. */
  const bgAlpha = alphaOf(termTheme.background)
  const bgPct = Math.round(bgAlpha * 100)
  const onBgOpacityChange = useCallback(
    (pct: number) => {
      const hex6 = hex6Of(termTheme.background, TERMINAL_THEME_DEFAULT.background)
      setTermTheme((prev) => ({ ...prev, background: withAlpha(hex6, pct / 100) }))
    },
    [termTheme.background, setTermTheme],
  )

  /** Reset everything to defaults. */
  const resetAll = useCallback(() => {
    setTermTheme(TERMINAL_THEME_DEFAULT)
    setLineHeight(LINE_HEIGHT_DEFAULT)
  }, [setTermTheme, setLineHeight])

  const activePresetId = useMemo(() => matchPresetId(termTheme), [termTheme])

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <TabsPrimitive.Root
          value={tab}
          onValueChange={setTab}
          orientation="vertical"
          className="flex h-full w-full"
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
          <TabsPrimitive.Trigger value="dropbox" className={tabBtn}>
            {t('settings.dropboxTab')}
          </TabsPrimitive.Trigger>
          <TabsPrimitive.Trigger value="forward" className={tabBtn}>
            {t('settings.forwardTab')}
          </TabsPrimitive.Trigger>
          <TabsPrimitive.Trigger value="gitgraph" className={tabBtn}>
            {t('settings.gitGraphTab')}
          </TabsPrimitive.Trigger>
        </TabsPrimitive.List>

        <TabsPrimitive.Content value="term" className="min-h-0 min-w-0 flex-1 overflow-y-auto pl-3">
          {/* ── Font size ──────────────────────────────────────────── */}
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
                <svg className="mx-auto h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
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
                <svg className="mx-auto h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
            <p className={sectionHint}>{t('settings.fontSizeHint', { defaultSize })}</p>
          </div>

          {/* ── Font family (combobox with custom input) ───────────── */}
          <div className={`${section} mt-4`}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.fontFamily')}</span>
            </div>
            <div className="mt-2">
              <Combobox
                items={FONT_ITEMS}
                value={fontFamily}
                onChange={setFontFamily}
                placeholder={t('settings.fontFamily')}
                editable
              />
            </div>
            <p className={sectionHint}>{t('settings.fontFamilyHint')}</p>
          </div>

          {/* ── Line height ────────────────────────────────────────── */}
          <div className={`${section} mt-4`}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.lineHeight')}</span>
              <span className="font-mono text-xs text-popover-foreground">{lineHeight.toFixed(1)}</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                className={stepBtn}
                disabled={lineHeight <= LINE_HEIGHT_MIN}
                onClick={() => setLineHeight(clampLineHeight(lineHeight - LINE_HEIGHT_STEP))}
                aria-label="Decrease line height"
              >
                <svg className="mx-auto h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M5 12h14" />
                </svg>
              </button>
              <input
                type="range"
                min={LINE_HEIGHT_MIN * 10}
                max={LINE_HEIGHT_MAX * 10}
                step={LINE_HEIGHT_STEP * 10}
                value={lineHeight * 10}
                onChange={(e) => setLineHeight(clampLineHeight(Number(e.target.value) / 10))}
                aria-label="Terminal line height"
                className="h-1 flex-1 cursor-pointer appearance-none rounded bg-white/15 accent-sky-400"
              />
              <button
                type="button"
                className={stepBtn}
                disabled={lineHeight >= LINE_HEIGHT_MAX}
                onClick={() => setLineHeight(clampLineHeight(lineHeight + LINE_HEIGHT_STEP))}
                aria-label="Increase line height"
              >
                <svg className="mx-auto h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
            <p className={sectionHint}>{t('settings.lineHeightHint', { default: lineHeightDefault.toFixed(1) })}</p>
          </div>

          {/* ── Theme presets (dropdown with color swatches) ────────── */}
          <div className={`${section} mt-4`}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.themePresets')}</span>
              <button
                type="button"
                onClick={resetAll}
                className="text-[10px] text-muted-foreground underline-offset-2 hover:text-white hover:underline"
              >
                {t('settings.resetColors')}
              </button>
            </div>
            <div className="mt-2">
              <ThemeSelect
                presets={THEME_PRESETS}
                value={activePresetId}
                onChange={applyPreset}
              />
            </div>
            <p className={sectionHint}>{t('settings.themePresetHint')}</p>
          </div>

          {/* ── Global background opacity ──────────────────────────── */}
          <div className={`${section} mt-4`}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.bgOpacity')}</span>
              <span className="font-mono text-xs text-popover-foreground">{bgPct}%</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                value={bgPct}
                onChange={(e) => onBgOpacityChange(Number(e.target.value))}
                aria-label="Background opacity"
                className="h-1 flex-1 cursor-pointer appearance-none rounded bg-white/15 accent-sky-400"
              />
            </div>
            <p className={sectionHint}>{t('settings.bgOpacityHint')}</p>
          </div>

          {/* ── Theme color editors (collapsible groups) ───────────── */}
          {/* Core */}
          <div className={`${section} mt-4`}>
            <GroupToggle
              label={t('settings.coreColors')}
              open={openGroups.core}
              onToggle={() => toggleGroup('core')}
            />
            {openGroups.core && (
              <>
                <ColorRow label={t('settings.background')} value={termTheme.background} onChange={setThemeColor('background')} />
                <ColorRow label={t('settings.foreground')} value={termTheme.foreground} onChange={setThemeColor('foreground')} />
                <ColorRow label={t('settings.cursor')} value={termTheme.cursor} onChange={setThemeColor('cursor')} />
                <ColorRow label={t('settings.cursorAccent')} value={termTheme.cursorAccent} onChange={setThemeColor('cursorAccent')} />
              </>
            )}
          </div>

          {/* Selection */}
          <div className={`${section} mt-4`}>
            <GroupToggle
              label={t('settings.selectionColors')}
              open={openGroups.selection}
              onToggle={() => toggleGroup('selection')}
            />
            {openGroups.selection && (
              <>
                <ColorRow label={t('settings.selectionBg')} value={termTheme.selectionBackground} onChange={setThemeColor('selectionBackground')} />
                <ColorRow label={t('settings.selectionFg')} value={termTheme.selectionForeground} onChange={setThemeColor('selectionForeground')} />
              </>
            )}
          </div>

          {/* ANSI colors */}
          <div className={`${section} mt-4`}>
            <GroupToggle
              label={t('settings.ansiColors')}
              open={openGroups.ansi}
              onToggle={() => toggleGroup('ansi')}
            />
            {openGroups.ansi && (
              <p className={sectionHint}>{t('settings.ansiColorsHint')}</p>
            )}
            {openGroups.ansi && (
              <div className="mt-2 space-y-0">
                <div className="mb-1 text-[10px] text-muted-foreground/60">{t('settings.ansiNormal')}</div>
                {ANSI_NORMAL.map((k) => (
                  <ColorRow key={k} label={ANSI_LABELS[k]} value={termTheme[k]} onChange={setThemeColor(k)} />
                ))}
                <div className="mb-1 mt-3 text-[10px] text-muted-foreground/60">{t('settings.ansiBright')}</div>
                {ANSI_BRIGHT.map((k) => (
                  <ColorRow key={k} label={ANSI_LABELS[k]} value={termTheme[k]} onChange={setThemeColor(k)} />
                ))}
              </div>
            )}
          </div>
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="filebrowser" className="min-h-0 min-w-0 flex-1 overflow-y-auto pl-3">
          <ZoomSetting
            zoom={fileBrowserZoom}
            onChange={setFileBrowserZoom}
            hint={t('settings.zoomHint', { app: t('settings.fileBrowserTab') })}
          />
          <div className={`${section} mt-4`}>
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
            <ColorRow label={t('settings.background')} value={fileBrowserBg} onChange={setFileBrowserBg} />
            <p className={sectionHint}>{t('settings.fileBrowserHint')}</p>
          </div>
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="dropbox" className="min-h-0 min-w-0 flex-1 overflow-y-auto pl-3">
          <ZoomSetting
            zoom={dropboxZoom}
            onChange={setDropboxZoom}
            hint={t('settings.zoomHint', { app: t('settings.dropboxTab') })}
          />
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="forward" className="min-h-0 min-w-0 flex-1 overflow-y-auto pl-3">
          <ZoomSetting
            zoom={forwardZoom}
            onChange={setForwardZoom}
            hint={t('settings.zoomHint', { app: t('settings.forwardTab') })}
          />
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="gitgraph" className="min-h-0 min-w-0 flex-1 overflow-y-auto pl-3">
          <ZoomSetting
            zoom={gitGraphZoom}
            onChange={setGitGraphZoom}
            hint={t('settings.zoomHint', { app: t('settings.gitGraphTab') })}
          />
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>
      </div>

      {/* Footer: Term tab only — restore default */}
      {tab === 'term' && (
        <div className="flex shrink-0 justify-end pt-2">
          <button
            type="button"
            onClick={() => {
              setFontSize(defaultSize)
              setLineHeight(lineHeightDefault)
            }}
            className="rounded px-3 py-1.5 text-xs font-semibold glass-btn bg-white/10 text-popover-foreground text-muted-foreground hover:text-white"
          >
            {t('settings.restoreDefault')}
          </button>
        </div>
      )}
    </div>
  )
}