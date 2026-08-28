const kbd =
  'inline-flex h-5 min-w-5 items-center justify-center rounded border border-white/15 bg-white/10 px-1.5 font-mono text-[10px] leading-none text-popover-foreground'
const rowLabel = 'text-xs text-popover-foreground'
const rowKeys = 'flex items-center justify-end gap-1'

/** One shortcut row: action label on the left, key caps on the right. */
function Row(props: { label: string; keys: string[][] }) {
  const { label, keys } = props
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className={rowLabel}>{label}</span>
      <span className={rowKeys}>
        {keys.map((combo, i) => (
          <span key={i} className={rowKeys}>
            {i > 0 && <span className="px-0.5 text-[10px] text-muted-foreground">or</span>}
            {combo.map((k) => (
              <kbd key={k} className={kbd}>
                {k}
              </kbd>
            ))}
          </span>
        ))}
      </span>
    </div>
  )
}

const tileSection = [
  { label: 'Split right', keys: [['Alt', '⏎']] },
  { label: 'Split below', keys: [['Alt', '⇧', '⏎']] },
  { label: 'Close tile', keys: [['Alt', 'Q']] },
]

const navSection = [
  { label: 'Focus next tile', keys: [['Alt', 'J']] },
  { label: 'Focus previous tile', keys: [['Alt', 'K']] },
  { label: 'Move tile left', keys: [['Alt', '←']] },
  { label: 'Move tile right', keys: [['Alt', '→']] },
  { label: 'Move tile up', keys: [['Alt', '↑']] },
  { label: 'Move tile down', keys: [['Alt', '↓']] },
]

const metaSection = [
  { label: 'Open this list', keys: [['Alt', '⇧', '/']] },
  { label: 'Open the menu', keys: [['Alt', '/']] },
]

const clipboardSection = [
  { label: 'Copy selection', keys: [['Ctrl', '⇧', 'C'], ['⌘', 'C']] },
  { label: 'Paste', keys: [['Ctrl', 'V'], ['Ctrl', '⇧', 'V'], ['⌘', 'V']] },
]

const sectionTitle = 'mt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground'
const sectionBox = 'mt-1 divide-y divide-white/5'

/**
 * Keyboard-shortcuts help screen of the unified Suwu menu dialog. Opened with
 * Alt+/ from anywhere (parent window or a focused terminal pane) or from the
 * menu list; bindings apply to the focused tile.
 */
export default function ShortcutsView() {
  return (
    <>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Work on any tile from the keyboard; actions apply to the focused tile.
      </p>

      <div className={sectionTitle}>Tiles</div>
      <div className={sectionBox}>
        {tileSection.map((r) => (
          <Row key={r.label} {...r} />
        ))}
      </div>

      <div className={sectionTitle}>Focus &amp; movement</div>
      <div className={sectionBox}>
        {navSection.map((r) => (
          <Row key={r.label} {...r} />
        ))}
      </div>

      <div className={sectionTitle}>Clipboard</div>
      <div className={sectionBox}>
        {clipboardSection.map((r) => (
          <Row key={r.label} {...r} />
        ))}
      </div>

      <div className={sectionTitle}>Help</div>
      <div className={sectionBox}>
        {metaSection.map((r) => (
          <Row key={r.label} {...r} />
        ))}
      </div>
    </>
  )
}
