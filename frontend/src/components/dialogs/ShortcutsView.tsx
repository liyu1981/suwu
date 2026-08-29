import { useTranslation } from 'react-i18next'

const kbd =
  'inline-flex h-5 min-w-5 items-center justify-center rounded border border-white/15 bg-white/10 px-1.5 font-mono text-[10px] leading-none text-popover-foreground'
const rowLabel = 'text-xs text-popover-foreground'
const rowKeys = 'flex items-center justify-end gap-1'

/** One shortcut row: action label on the left, key caps on the right. */
function Row(props: { label: string; keys: string[][] }) {
  const { label, keys } = props
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className={rowLabel}>{label}</span>
      <span className={rowKeys}>
        {keys.map((combo, i) => (
          <span key={i} className={rowKeys}>
            {i > 0 && <span className="px-0.5 text-[10px] text-muted-foreground">{t('shortcuts.or')}</span>}
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

const sectionTitle = 'mt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground'
const sectionBox = 'mt-1 divide-y divide-white/5'

/**
 * Keyboard-shortcuts help screen of the unified Suwu menu dialog. Opened with
 * Alt+/ from anywhere (parent window or a focused terminal pane) or from the
 * menu list; bindings apply to the focused tile.
 */
export default function ShortcutsView() {
  const { t } = useTranslation()

  const tileSection = [
    { label: t('shortcuts.splitRight'), keys: [['Alt', '⏎']] },
    { label: t('shortcuts.splitBelow'), keys: [['Alt', '⇧', '⏎']] },
    { label: t('shortcuts.closeTile'), keys: [['Alt', 'Q']] },
  ]

  const navSection = [
    { label: t('shortcuts.focusNext'), keys: [['Alt', 'J']] },
    { label: t('shortcuts.focusPrev'), keys: [['Alt', 'K']] },
    { label: t('shortcuts.moveLeft'), keys: [['Alt', '←']] },
    { label: t('shortcuts.moveRight'), keys: [['Alt', '→']] },
    { label: t('shortcuts.moveUp'), keys: [['Alt', '↑']] },
    { label: t('shortcuts.moveDown'), keys: [['Alt', '↓']] },
  ]

  const metaSection = [
    { label: t('shortcuts.openList'), keys: [['Alt', '⇧', '/']] },
    { label: t('shortcuts.openMenu'), keys: [['Alt', '/']] },
  ]

  const clipboardSection = [
    { label: t('shortcuts.copySelection'), keys: [['Ctrl', '⇧', 'C'], ['⌘', 'C']] },
    { label: t('shortcuts.paste'), keys: [['Ctrl', 'V'], ['Ctrl', '⇧', 'V'], ['⌘', 'V']] },
  ]

  return (
    <>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t('shortcuts.description')}
      </p>

      <div className={sectionTitle}>{t('shortcuts.tiles')}</div>
      <div className={sectionBox}>
        {tileSection.map((r) => (
          <Row key={r.label} {...r} />
        ))}
      </div>

      <div className={sectionTitle}>{t('shortcuts.focusMovement')}</div>
      <div className={sectionBox}>
        {navSection.map((r) => (
          <Row key={r.label} {...r} />
        ))}
      </div>

      <div className={sectionTitle}>{t('shortcuts.clipboard')}</div>
      <div className={sectionBox}>
        {clipboardSection.map((r) => (
          <Row key={r.label} {...r} />
        ))}
      </div>

      <div className={sectionTitle}>{t('shortcuts.help')}</div>
      <div className={sectionBox}>
        {metaSection.map((r) => (
          <Row key={r.label} {...r} />
        ))}
      </div>
    </>
  )
}
