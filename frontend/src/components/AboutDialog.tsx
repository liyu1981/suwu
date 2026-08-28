import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

const row = 'flex items-baseline justify-between gap-4 py-1.5'
const rowLabel = 'text-xs text-muted-foreground'
const rowValue = 'text-xs text-popover-foreground'
const featureDot = 'mt-1.5 h-1 w-1 shrink-0 rounded-full bg-sky-400/70'

const features = [
  'Real shell sessions — the Go server bridges xterm.js panes to actual PTYs over WebSocket',
  'Session restore — server-side terminal state (libghostty-vt) survives page refreshes',
  'Tiling workspace — split, move, focus, and resize tiles by keyboard or hover tools',
  'Per-pane terminals — every tile is an isolated xterm.js instance with its own shell',
]

/**
 * About dialog for Suwu. Opened from the app menu; version comes from the
 * root package.json via the __SUWU_VERSION__ define in vite.config.ts.
 */
export default function AboutDialog(props: React.ComponentProps<typeof Dialog>) {
  return (
    <Dialog {...props}>
      <DialogContent aria-describedby={undefined}>
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-[6px] border border-white/10 bg-white/5 text-xl">
            🚀
          </span>
          <div>
            <DialogTitle>Suwu</DialogTitle>
            <DialogDescription>Browser terminal workspace · v{__SUWU_VERSION__}</DialogDescription>
          </div>
        </div>

        <div className="mt-4 divide-y divide-white/5 rounded-[6px] border border-white/10 bg-black/20 px-3 py-1">
          {features.map((f) => (
            <div key={f} className="flex gap-2.5 py-2">
              <span className={featureDot} />
              <p className="text-xs leading-relaxed text-popover-foreground">{f}</p>
            </div>
          ))}
        </div>

        <div className={`${row} mt-2`}>
          <span className={rowLabel}>Built with</span>
          <span className={rowValue}>Go · libghostty-vt (WASM) · React · xterm.js</span>
        </div>
        <div className={row}>
          <span className={rowLabel}>Shortcuts</span>
          <span className={rowValue}>
            Press <kbd className="rounded border border-white/15 bg-white/10 px-1 font-mono text-[10px]">Alt</kbd>{' '}
            <kbd className="rounded border border-white/15 bg-white/10 px-1 font-mono text-[10px]">/</kbd> anywhere
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
