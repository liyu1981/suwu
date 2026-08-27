import { useAtom } from 'jotai'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { FONT_MAX, FONT_MIN, clampFont, fontDefaultAtom, fontSizeAtom } from '../store/fonts'

const stepBtn =
  'h-7 w-7 place-items-center rounded text-slate-300 transition glass-btn disabled:cursor-not-allowed disabled:opacity-40'
const actionBtn =
  'rounded px-3 py-1.5 text-xs font-semibold glass-btn bg-white/10 text-popover-foreground hover:text-white'

/**
 * System settings dialog. Font-size steppers act on the live shared size
 * immediately (visible in every open pane); "Save as default" persists it as
 * the size new sessions and Reset start from.
 */
export default function SettingsDialog(props: React.ComponentProps<typeof Dialog>) {
  const [fontSize, setFontSize] = useAtom(fontSizeAtom)
  const [defaultSize, setDefaultSize] = useAtom(fontDefaultAtom)
  const { onOpenChange } = props

  return (
    <Dialog {...props}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>Terminal preferences for this workspace.</DialogDescription>

        <div className="mt-4 rounded-[6px] border border-white/10 bg-black/20 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Font size</span>
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
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            Applied instantly to all terminal panes. Currently the default is{' '}
            {defaultSize}px; save to make this size the default too.
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
