const row = 'flex items-baseline justify-between gap-4 py-1.5'
const rowLabel = 'text-xs text-muted-foreground'
const rowValue = 'text-xs text-popover-foreground'
const featureDot = 'mt-1.5 h-1 w-1 shrink-0 rounded-full bg-sky-400/70'

const GITHUB_URL = 'https://github.com/liyu1981/suwu'

const kbd =
  'rounded border border-white/15 bg-white/10 px-1 font-mono text-[10px]'

const features = [
  'Real shell sessions — the Go server bridges xterm.js panes to actual PTYs over WebSocket',
  'Session restore — server-side terminal state (libghostty-vt) survives page refreshes',
  'Tiling workspace — split, move, focus, and resize tiles by keyboard or hover tools',
  'Per-pane terminals — every tile is an isolated xterm.js instance with its own shell',
]

/**
 * About screen for the unified Suwu menu dialog: a centered brand mark, the
 * app name, version, and a GitHub link, followed by the feature list and
 * meta rows. Version comes from the root package.json via the
 * __SUWU_VERSION__ define in vite.config.ts.
 */
export default function AboutView() {
  return (
    <>
      {/* Brand header: the logo artwork carries its own rounded background
          (56px at this size), so the CSS radius matches it exactly and the
          shadow lifts the tile off the glass. */}
      <div className="flex flex-col items-center pt-2">
        <img
          src="/logo.svg"
          alt="Suwu logo"
          width={256}
          height={256}
          className="h-64 w-64 rounded-[56px] shadow-[0_12px_40px_rgb(0_0_0/0.35)]"
        />
        <div className="mt-4 text-center">
          <div className="text-2xl font-semibold tracking-tight text-popover-foreground">Suwu</div>
          <div className="mt-0.5 text-xs text-muted-foreground">Version {__SUWU_VERSION__}</div>
        </div>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-muted-foreground glass-btn transition hover:text-popover-foreground"
        >
          <GitHubIcon />
          <span className="font-medium">liyu1981/suwu</span>
        </a>
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
          <kbd className={kbd}>Alt</kbd>{' '}
          <kbd className={kbd}>/</kbd>{' '}
          for the menu,{' '}
          <kbd className={kbd}>Alt</kbd>{' '}
          <kbd className={kbd}>⇧</kbd>{' '}
          <kbd className={kbd}>/</kbd>{' '}
          for shortcuts
        </span>
      </div>
    </>
  )
}

function GitHubIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}
