import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { appMenuAtom, bootstrapAppMenu, createCustomApp } from '../../store/appMenu'
import { getAllTilePlugins } from '../../wm/tilePlugins'
import { getAllAppConfigs } from '../../wm/appConfigs'
import { getAppIconClasses, getAppIconLetter } from '../../wm/appIcons'
import { Select, SelectTrigger, SelectContent, SelectItem } from '../ui/select'
import type { PluginParamDoc } from '../../wm/tilePlugins'

// ── Style constants ──────────────────────────────────────────────────

const toggle =
  'relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ' +
  'bg-white/15 data-[state=checked]:bg-sky-500/60'

const toggleThumb =
  'block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform ' +
  'data-[state=checked]:translate-x-4'

const row = 'flex items-center gap-3 rounded px-2 py-2 transition-colors'

const inputBase =
  'flex-1 rounded border border-white/10 bg-white/5 px-2 py-1 text-xs text-popover-foreground outline-none transition-colors focus:border-sky-400/50 focus:ring-1 focus:ring-sky-400/20'

// ── Tiny sub-components ──────────────────────────────────────────────

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

/** Trash / delete icon. */
function TrashIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  )
}

// ── Param editor row ─────────────────────────────────────────────────

function ParamRow({
  doc,
  paramKey,
  value,
  onChangeKey,
  onChangeValue,
  onRemove,
}: {
  doc?: PluginParamDoc
  paramKey: string
  value: string
  onChangeKey: (next: string) => void
  onChangeValue: (next: string) => void
  onRemove: () => void
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={paramKey}
          onChange={(e) => onChangeKey(e.target.value)}
          placeholder="key"
          className="w-20 shrink-0 rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-mono text-popover-foreground outline-none transition-colors focus:border-sky-400/50"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChangeValue(e.target.value)}
          placeholder="value"
          className={inputBase}
        />
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded p-1 text-white/30 transition-colors hover:bg-white/10 hover:text-red-400"
          aria-label="Remove parameter"
        >
          <TrashIcon />
        </button>
      </div>
      {doc?.description && (
        <span className="pl-22 text-[10px] leading-tight text-muted-foreground/50">{doc.description}</span>
      )}
    </div>
  )
}

// ── Expanded editing form ────────────────────────────────────────────

function EditingForm({
  item,
  plugins,
  onUpdate,
  onDelete,
}: {
  item: { id: string; params?: Record<string, string>; customConfig?: { label: string; description?: string; pluginId: string } }
  plugins: ReturnType<typeof getAllTilePlugins>
  onUpdate: (patch: { params?: Record<string, string>; customConfig?: { label: string; description?: string; pluginId: string } }) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const cfg = item.customConfig ?? { label: item.id, pluginId: 'term' }
  const params = item.params ?? {}

  const activePlugin = useMemo(
    () => plugins.find((p) => p.id === cfg.pluginId),
    [plugins, cfg.pluginId],
  )

  const supportedKeys = useMemo(
    () => new Set((activePlugin?.supportedParams ?? []).map((d) => d.key)),
    [activePlugin],
  )

  // Keys in params that are NOT in supportedParams (user-added arbitrary keys).
  const customKeys = useMemo(
    () => Object.keys(params).filter((k) => !supportedKeys.has(k)),
    [params, supportedKeys],
  )

  // Merged ordered list: supported first (in plugin order), then custom.
  const allKeys = useMemo(() => {
    const supported = (activePlugin?.supportedParams ?? []).map((d) => d.key)
    return [...supported, ...customKeys]
  }, [activePlugin, customKeys])

  // Only plugins that declare supportedParams can be used for custom apps.
  const pluginOptions = plugins.filter((p) => p.id !== 'empty' && p.supportedParams && p.supportedParams.length > 0)

  // ── handlers ──────────────────────────────────────────────────

  const setLabel = (label: string) => onUpdate({ customConfig: { ...cfg, label } })
  const setDescription = (description: string) => onUpdate({ customConfig: { ...cfg, description } })

  const setPluginId = (pluginId: string) => {
    // Keep existing params; user can clean up irrelevant ones.
    onUpdate({ customConfig: { ...cfg, pluginId } })
  }

  const setParam = (key: string, value: string) => {
    onUpdate({ params: { ...params, [key]: value } })
  }

  const removeParam = (key: string) => {
    const next = { ...params }
    delete next[key]
    onUpdate({ params: next })
  }

  const addParam = () => {
    // Pick a key that doesn't exist yet.
    let candidate = 'key'
    let i = 1
    while (candidate in params) candidate = `key${++i}`
    onUpdate({ params: { ...params, [candidate]: '' } })
  }

  const docFor = (key: string): PluginParamDoc | undefined =>
    activePlugin?.supportedParams?.find((d) => d.key === key)

  return (
    <div className="mx-10 my-1 space-y-2.5 rounded border border-white/5 bg-black/20 p-2.5">
      {/* Label */}
      <div className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-[11px] text-muted-foreground">{t('appMenu.label')}</span>
        <input
          type="text"
          value={cfg.label}
          onChange={(e) => setLabel(e.target.value)}
          className={inputBase}
        />
      </div>

      {/* Description */}
      <div className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-[11px] text-muted-foreground">{t('appMenu.descField')}</span>
        <input
          type="text"
          value={cfg.description ?? ''}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional"
          className={inputBase}
        />
      </div>

      {/* Plugin selector */}
      <div className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-[11px] text-muted-foreground">{t('appMenu.plugin')}</span>
        <Select value={cfg.pluginId} onValueChange={setPluginId}>
          <SelectTrigger className="flex-1">
            <span>{pluginOptions.find((p) => p.id === cfg.pluginId)?.label ?? cfg.pluginId}</span>
          </SelectTrigger>
          <SelectContent>
            {pluginOptions.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Parameters */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">{t('appMenu.params')}</span>
          <button
            type="button"
            onClick={addParam}
            className="text-[10px] text-sky-400/70 transition-colors hover:text-sky-400"
          >
            + {t('appMenu.addParam')}
          </button>
        </div>

        {allKeys.length === 0 && (
          <p className="text-[10px] text-muted-foreground/40">{t('appMenu.noParams')}</p>
        )}

        <div className="space-y-1.5">
          {allKeys.map((key) => (
            <ParamRow
              key={key}
              doc={docFor(key)}
              paramKey={key}
              value={params[key] ?? ''}
              onChangeKey={(nextKey) => {
                // Rename: remove old, add new.
                const next = { ...params }
                delete next[key]
                next[nextKey] = params[key] ?? ''
                onUpdate({ params: next })
              }}
              onChangeValue={(v) => setParam(key, v)}
              onRemove={() => removeParam(key)}
            />
          ))}
        </div>
      </div>

      {/* Delete button */}
      <div className="flex justify-end pt-1">
        <button
          type="button"
          onClick={onDelete}
          className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400"
        >
          <TrashIcon />
          {t('appMenu.remove')}
        </button>
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────

/**
 * App Menu settings screen. Lists all registered apps with visibility
 * toggles, drag-to-reorder, and inline param editing for config-only apps.
 * Users can also create arbitrary custom app entries.
 */
export default function AppMenuView() {
  const { t } = useTranslation()
  const [menuItems, setMenuItems] = useAtom(appMenuAtom)

  // Bootstrap from registry if needed.
  const plugins = useMemo(() => getAllTilePlugins(), [])
  const configs = useMemo(() => getAllAppConfigs(), [])

  const items = useMemo(
    () => bootstrapAppMenu(plugins, configs, menuItems),
    [plugins, configs, menuItems],
  )

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

  // ── Expand / collapse ──────────────────────────────────────────
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // ── Is this a config-only item? (not a real plugin) ────────────
  const isConfigItem = useCallback(
    (id: string) => {
      // Custom items are always config items.
      const item = items.find((i) => i.id === id)
      if (item?.isCustom) return true
      // Registry config items (not a plugin).
      return !pluginMap.has(id)
    },
    [items, pluginMap],
  )

  // ── Update a config/custom item ────────────────────────────────
  const updateItem = useCallback(
    (id: string, patch: { params?: Record<string, string>; customConfig?: { label: string; description?: string; pluginId: string } }) => {
      setMenuItems((prev: typeof menuItems) =>
        prev.map((item) => {
          if (item.id !== id) return item
          return { ...item, ...patch }
        }),
      )
    },
    [setMenuItems],
  )

  // ── Delete a config/custom item ────────────────────────────────
  const deleteItem = useCallback(
    (id: string) => {
      setMenuItems((prev: typeof menuItems) => prev.filter((item) => item.id !== id))
      setExpandedIds((prev) => { const next = new Set(prev); next.delete(id); return next })
    },
    [setMenuItems],
  )

  // ── Create a new custom app ────────────────────────────────────
  const addCustom = useCallback(() => {
    const maxOrder = items.reduce((m, i) => Math.max(m, i.order), -1)
    const newItem = createCustomApp(plugins, maxOrder)
    setMenuItems((prev: typeof menuItems) => [...prev, newItem])
    // Auto-expand the new item.
    setExpandedIds((prev) => new Set(prev).add(newItem.id))
  }, [items, plugins, setMenuItems])

  // ── Determine icon for an item ─────────────────────────────────
  const getIcon = useCallback(
    (item: { id: string; customConfig?: { pluginId: string } }) => {
      const pluginId = item.customConfig?.pluginId
      return {
        classes: getAppIconClasses(item.id, pluginId),
        letter: getAppIconLetter(
          item.id,
          pluginMap.get(item.id)?.label ?? configMap.get(item.id)?.label ?? item.id,
          pluginId,
        ),
      }
    },
    [pluginMap, configMap],
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
          const label = plugin?.label ?? config?.label ?? item.customConfig?.label ?? item.id
          const description = plugin?.description ?? config?.description ?? item.customConfig?.description
          const configItem = isConfigItem(item.id)
          const expanded = expandedIds.has(item.id)
          const { classes: iconClasses, letter } = getIcon(item)

          return (
            <div key={item.id} data-app-row>
              {/* Row content — the grabbable / draggable surface */}
              <div
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

                {/* Label + description + expand toggle */}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-popover-foreground">{label}</div>
                  {description && (
                    <div className="text-[11px] text-muted-foreground">{description}</div>
                  )}
                  {configItem && (
                    <button
                      type="button"
                      onClick={() => toggleExpand(item.id)}
                      className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                    >
                      <ChevronIcon open={expanded} />
                      {expanded ? t('appMenu.collapse') : t('appMenu.configure')}
                    </button>
                  )}
                </div>

                {/* Toggle */}
                <Toggle
                  checked={item.visible}
                  onCheckedChange={() => toggleVisible(item.id)}
                />
              </div>

              {/* Expanded editing form (config items only) — below the row */}
              {configItem && expanded && (
                <EditingForm
                  item={item}
                  plugins={plugins}
                  onUpdate={(patch) => updateItem(item.id, patch)}
                  onDelete={() => deleteItem(item.id)}
                />
              )}
            </div>
          )
        })}
      </div>

      {/* Add custom app button */}
      <button
        type="button"
        onClick={addCustom}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-white/10 px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-white/20 hover:bg-white/5 hover:text-popover-foreground"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        {t('appMenu.addCustom')}
      </button>

      {/* Hint */}
      <p className="mt-2 text-[10px] text-muted-foreground/60">{t('appMenu.dragHint')}</p>
    </div>
  )
}
