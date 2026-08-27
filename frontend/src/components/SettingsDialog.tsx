import { useAtom } from 'jotai'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { FONT_MAX, FONT_MIN, clampFont, fontDefaultAtom, fontSizeAtom } from '../store/fonts'
import {
  FONT_FAMILIES,
  TERMINAL_THEME_DEFAULT,
  type TerminalTheme,
  fontFamilyAtom,
  termThemeAtom,
} from '../store/appearance'
import { alphaOf, hex6Of, withAlpha } from '../lib/color'

const stepBtn =
  'h-7 w-7 place-items-center rounded text-slate-300 transition glass-btn disabled:cursor-not-allowed disabled:opacity-40'
const actionBtn =
  'rounded px-3 py-1.5 text-xs font-semibold glass-btn bg-white/10 text-popover-foreground hover:text-white'
const section = 'rounded-[6px] border border-white/10 bg-black/20 p-3'
const sectionLabel = 'text-xs font-medium text-muted-foreground'
const sectionHint = 'mt-2 text-[10px] leading-relaxed text-muted-foreground'

/** One theme color: a hex picker plus an opacity slider, stored as #RRGGBBAA. */
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
 * System settings dialog. Font-size steppers act on the live shared size
 * immediately (visible in every open pane); "Save as default" persists it as
 * the size new sessions and Reset start from. Font family and theme colors
 * apply and persist instantly, syncing to every pane via storage events.
 */
export default function SettingsDialog(props: React.ComponentProps<typeof Dialog>) {
  const [fontSize, setFontSize] = useAtom(fontSizeAtom)
  const [defaultSize, setDefaultSize] = useAtom(fontDefaultAtom)
  const [fontFamily, setFontFamily] = useAtom(fontFamilyAtom)
  const [termTheme, setTermTheme] = useAtom(termThemeAtom)
  const { onOpenChange } = props

  const setThemeColor = (key: keyof TerminalTheme) => (next: string) =>
    setTermTheme({ ...termTheme, [key]: next })
  const knownFamily = FONT_FAMILIES.some((f) => f.value === fontFamily)

  return (
    <Dialog {...props}>
      <DialogContent aria-describedby={undefined} className="overflow-y-auto">
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>Terminal preferences for this workspace.</DialogDescription>

        <div className={`${section} mt-4`}>
          <div className="flex items-center justify-between">
            <span className={sectionLabel}>Font size</span>
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
            Applied instantly to all terminal panes. Currently the default is{' '}
            {defaultSize}px; save to make this size the default too.
          </p>
        </div>

        <div className={`${section} mt-3`}>
          <div className="flex items-center justify-between">
            <span className={sectionLabel}>Font family</span>
          </div>
          <select
            value={fontFamily}
            onChange={(e) => setFontFamily(e.target.value)}
            aria-label="Terminal font family"
            className="mt-2 h-8 w-full rounded border border-white/10 bg-black/30 px-2 text-xs text-popover-foreground focus:border-sky-400/60 focus:outline-none"
          >
            {!knownFamily && <option value={fontFamily}>Custom</option>}
            {FONT_FAMILIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <p className={sectionHint}>Applied instantly to all terminal panes.</p>
        </div>

        <div className={`${section} mt-3`}>
          <div className="flex items-center justify-between">
            <span className={sectionLabel}>Theme colors</span>
            <button
              type="button"
              onClick={() => setTermTheme(TERMINAL_THEME_DEFAULT)}
              className="text-[10px] text-muted-foreground underline-offset-2 hover:text-white hover:underline"
            >
              Reset colors
            </button>
          </div>
          <ColorRow label="Background" value={termTheme.background} onChange={setThemeColor('background')} />
          <ColorRow label="Foreground" value={termTheme.foreground} onChange={setThemeColor('foreground')} />
          <ColorRow label="Cursor" value={termTheme.cursor} onChange={setThemeColor('cursor')} />
          <p className={sectionHint}>
            Colors apply instantly to all terminal panes. Lower the background opacity to let the
            workspace show through.
          </p>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setFontSize(defaultSize)}
            className={`${actionBtn} text-muted-foreground hover:text-white`}
          >
            Reset ({defaultSize}px)
          </button>
          <button
            type="button"
            onClick={() => {
              setDefaultSize(fontSize)
              onOpenChange?.(false)
            }}
            className={actionBtn}
          >
            Save as default
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
