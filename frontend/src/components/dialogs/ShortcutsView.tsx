import { useMemo, useState } from 'react'
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

interface ShortcutItem {
  label: string
  keys: string[][]
  search?: string
}

interface ShortcutSection {
  title: string
  items: ShortcutItem[]
}

/**
 * Keyboard-shortcuts help screen of the unified Suwu menu dialog. Opened with
 * Alt+/ from anywhere (parent window or a focused terminal pane) or from the
 * menu list; bindings apply to the focused tile.
 */
export default function ShortcutsView() {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')

  const allSections: ShortcutSection[] = useMemo(() => [
    {
      title: t('shortcuts.tiles'),
      items: [
        { label: t('shortcuts.splitRight'), keys: [['Alt', '⏎']] },
        { label: t('shortcuts.splitBelow'), keys: [['Alt', '⇧', '⏎']] },
        { label: t('shortcuts.closeTile'), keys: [['Alt', 'Q']] },
      ],
    },
    {
      title: t('shortcuts.focus'),
      items: [
        { label: t('shortcuts.focusLeft'), keys: [['Alt', '←']], search: 'focus left' },
        { label: t('shortcuts.focusRight'), keys: [['Alt', '→']], search: 'focus right' },
        { label: t('shortcuts.focusUp'), keys: [['Alt', '↑']], search: 'focus up' },
        { label: t('shortcuts.focusDown'), keys: [['Alt', '↓']], search: 'focus down' },
      ],
    },
    {
      title: t('shortcuts.movement'),
      items: [
        { label: t('shortcuts.moveLeft'), keys: [['Alt', '⇧', '←']], search: 'move left swap' },
        { label: t('shortcuts.moveRight'), keys: [['Alt', '⇧', '→']], search: 'move right swap' },
        { label: t('shortcuts.moveUp'), keys: [['Alt', '⇧', '↑']], search: 'move up swap' },
        { label: t('shortcuts.moveDown'), keys: [['Alt', '⇧', '↓']], search: 'move down swap' },
      ],
    },
    {
      title: t('shortcuts.clipboard'),
      items: [
        { label: t('shortcuts.copySelection'), keys: [['Ctrl', '⇧', 'C'], ['⌘', 'C']] },
        { label: t('shortcuts.paste'), keys: [['Ctrl', 'V'], ['Ctrl', '⇧', 'V'], ['⌘', 'V']] },
      ],
    },
    {
      title: t('shortcuts.help'),
      items: [
        { label: t('shortcuts.openList'), keys: [['Alt', '⇧', '/']] },
        { label: t('shortcuts.openMenu'), keys: [['Alt', '/']] },
      ],
    },
  ], [t])

  const filtered = useMemo(() => {
    if (!query.trim()) return allSections
    const q = query.toLowerCase()
    return allSections
      .map((s) => ({
        ...s,
        items: s.items.filter(
          (r) =>
            r.label.toLowerCase().includes(q) ||
            (r.search && r.search.includes(q)) ||
            r.keys.some((combo) => combo.some((k) => k.toLowerCase().includes(q))),
        ),
      }))
      .filter((s) => s.items.length > 0)
  }, [query, allSections])

  return (
    <>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t('shortcuts.description')}
      </p>

      <div className="relative mt-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('shortcuts.search')}
          className="w-full rounded border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-popover-foreground placeholder:text-muted-foreground outline-none focus:border-white/20"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white"
          >
            ×
          </button>
        )}
      </div>

      {filtered.map((s) => (
        <div key={s.title}>
          <div className={sectionTitle}>{s.title}</div>
          <div className={sectionBox}>
            {s.items.map((r) => (
              <Row key={r.label} {...r} />
            ))}
          </div>
        </div>
      ))}

      {filtered.length === 0 && (
        <div className="py-8 text-center text-xs text-muted-foreground">
          {t('shortcuts.noResults')}
        </div>
      )}
    </>
  )
}
