import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { appMenuAtom, bootstrapAppMenu } from '../../store/appMenu'
import { getAllTilePlugins } from '../../wm/tilePlugins'
import { getAllAppConfigs } from '../../wm/appConfigs'
import { getAppIconClasses, getAppIconLetter } from '../../wm/appIcons'

const toggle =
  'relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ' +
  'bg-white/15 data-[state=checked]:bg-sky-500/60'

const toggleThumb =
  'block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform ' +
  'data-[state=checked]:translate-x-4'

function Toggle({
  checked,
  onCheckedChange,
}: {
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? 'checked' : 'unchecked'}
      className={toggle}
      onClick={() => onCheckedChange(!checked)}
    >
      <span data-state={checked ? 'checked' : 'unchecked'} className={toggleThumb} />
    </button>
  )
}

/** Drag handle icon (three horizontal lines). */
function DragHandle({ onPointerDown }: { onPointerDown: (e: ReactPointerEvent) => void }) {
  return (
    <div
      className="flex h-8 w-5 shrink-0 cursor-grab items-center justify-center rounded text-white/25 hover:text-white/50 active:cursor-grabbing"
      onPointerDown={onPointerDown}
    >
      <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
        <path d="M3 4h10v1.5H3zm0 3.25h10v1.5H3zm0 3.25h10v1.5H3z" />
      </svg>
    </div>
  )
}

/** Chevron icon for expand/collapse. */
function ChevronIcon({ open }: { open: boolean }) {
  return (
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
  )
}

const row = 'flex items-center gap-3 rounded px-2 py-2 transition-colors'

/**
 * App Menu settings screen. Lists all registered apps with visibility
 * toggles, drag-to-reorder, and param editing for config-only apps.
 */
export default function AppMenuView() {
  const { t } = useTranslation()
  const [menuItems, setMenuItems] = useAtom(appMenuAtom)

  // Bootstrap from registry if needed.
  const plugins = useMemo(() => getAllTilePlugins(), [])
  const configs = useMemo(() => getAllAppConfigs(), [])

  const items = useMemo(() => {
    const bootstrapped = bootstrapAppMenu(plugins, configs, menuItems)
    // If bootstrapped differs from stored, update.
    if (JSON.stringify(bootstrapped) !== JSON.stringify(menuItems)) {
      setMenuItems(bootstrapped)
    }
    return bootstrapped
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins, configs])

  // Plugin/config lookup for labels/descriptions.
  const pluginMap = useMemo(() => new Map(plugins.map((p) => [p.id, p])), [plugins])
  const configMap = useMemo(() => new Map(configs.map((c) => [c.id, c])), [configs])

  // Sort items by order.
  const sorted = useMemo(() => [...items].sort((a, b) => a.order - b.order), [items])

  // ── Toggle visibility ──────────────────────────────────────────
  const toggleVisible = useCallback(
    (id: string) => {
      setMenuItems((prev: typeof menuItems) =>
        prev.map((item) => (item.id === id ? { ...item, visible: !item.visible } : item)),
      )
    },
    [setMenuItems],
  )

  // ── Show / Hide all ────────────────────────────────────────────
  const allVisible = sorted.every((i) => i.visible)
  const toggleAll = useCallback(() => {
    const next = !allVisible
    setMenuItems((prev: typeof menuItems) => prev.map((item) => ({ ...item, visible: next })))
  }, [allVisible, setMenuItems])

  // ── Drag to reorder ────────────────────────────────────────────
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const dragStartY = useRef(0)
  const dragStartIdx = useRef(0)
  const currentIdx = useRef(0)
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const onDragStart = useCallback(
    (id: string, e: ReactPointerEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const el = e.currentTarget.closest('[data-app-row]') as HTMLElement | null
      if (!el) return

      el.setPointerCapture(e.pointerId)
      setDraggingId(id)
      dragStartY.current = e.clientY
      dragStartIdx.current = sorted.findIndex((i) => i.id === id)
      currentIdx.current = dragStartIdx.current

      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientY - dragStartY.current
        const rowHeight = el.offsetHeight + 4 // gap
        const offset = Math.round(delta / rowHeight)
        const newIdx = Math.max(0, Math.min(sorted.length - 1, dragStartIdx.current + offset))

        if (newIdx !== currentIdx.current) {
          currentIdx.current = newIdx
          // Reorder items array.
          setMenuItems((prev: typeof menuItems) => {
            const sortedItems = [...prev].sort((a, b) => a.order - b.order)
            const fromIdx = sortedItems.findIndex((i) => i.id === id)
            if (fromIdx === -1) return prev
            const [moved] = sortedItems.splice(fromIdx, 1)
            sortedItems.splice(newIdx, 0, moved)
            // Reassign orders.
            return sortedItems.map((item, i) => ({ ...item, order: i }))
          })
        }
      }

      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        setDraggingId(null)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [sorted, setMenuItems],
  )

  // ── Param editing (config-only apps) ───────────────────────────
  const [expandedParams, setExpandedParams] = useState<Set<string>>(new Set())
  const toggleParams = useCallback((id: string) => {
    setExpandedParams((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const updateParam = useCallback(
    (appId: string, key: string, value: string) => {
      setMenuItems((prev: typeof menuItems) =>
        prev.map((item) => {
          if (item.id !== appId) return item
          return { ...item, params: { ...item.params, [key]: value } }
        }),
      )
    },
    [setMenuItems],
  )

  return (
    <div>
      {/* Header actions */}
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{t('appMenu.description')}</p>
        <button
          type="button"
          onClick={toggleAll}
          className="shrink-0 rounded px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-popover-foreground"
        >
          {allVisible ? t('appMenu.hideAll') : t('appMenu.showAll')}
        </button>
      </div>

      {/* App list */}
      <div className="divide-y divide-white/5 rounded-[6px] border border-white/10 bg-black/20">
        {sorted.map((item) => {
          const plugin = pluginMap.get(item.id)
          const config = configMap.get(item.id)
          const label = plugin?.label ?? config?.label ?? item.id
          const description = plugin?.description ?? config?.description
          const isConfig = !!config && !plugin
          const hasParams = isConfig && config && Object.keys(config.params).length > 0
          const paramsExpanded = expandedParams.has(item.id)
          const iconClasses = getAppIconClasses(item.id)
          const letter = getAppIconLetter(item.id, label)

          return (
            <div
              key={item.id}
              data-app-row
              ref={(el) => { if (el) rowRefs.current.set(item.id, el) }}
              className={`${row} ${draggingId === item.id ? 'bg-white/5' : ''}`}
            >
              <DragHandle onPointerDown={(e) => onDragStart(item.id, e)} />

              {/* Icon */}
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-xs font-bold ${iconClasses.bg} ${iconClasses.text}`}
              >
                {letter}
              </div>

              {/* Label + description + params toggle */}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-popover-foreground">{label}</div>
                {description && (
                  <div className="text-[11px] text-muted-foreground">{description}</div>
                )}
                {hasParams && (
                  <button
                    type="button"
                    onClick={() => toggleParams(item.id)}
                    className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                  >
                    <ChevronIcon open={paramsExpanded} />
                    {t('appMenu.configure')}
                  </button>
                )}
              </div>

              {/* Toggle */}
              <Toggle
                checked={item.visible}
                onCheckedChange={() => toggleVisible(item.id)}
              />

              {/* Params section (expandable) */}
              {hasParams && paramsExpanded && config && (
                <div className="col-span-full mt-2 ml-13 rounded border border-white/5 bg-black/20 p-2.5">
                  {Object.entries(config.params).map(([key]) => (
                    <div key={key} className="flex items-center gap-2 py-1.5">
                      <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{key}</span>
                      <input
                        type="text"
                        value={item.params?.[key] ?? ''}
                        onChange={(e) => updateParam(item.id, key, e.target.value)}
                        className="flex-1 rounded border border-white/10 bg-white/5 px-2 py-1 text-xs text-popover-foreground outline-none transition-colors focus:border-sky-400/50 focus:ring-1 focus:ring-sky-400/20"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Hint */}
      <p className="mt-2 text-[10px] text-muted-foreground/60">{t('appMenu.dragHint')}</p>
    </div>
  )
}
