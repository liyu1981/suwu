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
 * About screen for the unified Suwu menu dialog. Version comes from the root
 * package.json via the __SUWU_VERSION__ define in vite.config.ts.
 */
export default function AboutView() {
  return (
    <>
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-[6px] border border-white/10 bg-white/5 text-xl">
          🚀
        </span>
        <div className="text-sm font-semibold tracking-tight text-popover-foreground">
          Suwu · v{__SUWU_VERSION__}
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
          Press{' '}
          <kbd className="rounded border border-white/15 bg-white/10 px-1 font-mono text-[10px]">
            Alt
          </kbd>{' '}
          <kbd className="rounded border border-white/15 bg-white/10 px-1 font-mono text-[10px]">
            /
          </kbd>{' '}
          for the menu,{' '}
          <kbd className="rounded border border-white/15 bg-white/10 px-1 font-mono text-[10px]">
            Alt
          </kbd>{' '}
          <kbd className="rounded border border-white/15 bg-white/10 px-1 font-mono text-[10px]">
            ⇧
          </kbd>{' '}
          <kbd className="rounded border border-white/15 bg-white/10 px-1 font-mono text-[10px]">
            /
          </kbd>{' '}
          for shortcuts
        </span>
      </div>
    </>
  )
}
