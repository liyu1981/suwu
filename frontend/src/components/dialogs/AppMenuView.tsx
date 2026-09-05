import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { appMenuAtom, type AppMenuState, type CustomApp } from '../../store/appMenu'
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

// ── Display row item ─────────────────────────────────────────────────

interface DisplayItem {
  id: string
  label: string
  description?: string
  visible: boolean
  isCustom: boolean
  isConfig: boolean
  pluginId?: string
  params?: Record<string, string>
  customConfig?: { label: string; description?: string; pluginId: string }
  order: number
}

// ── Main component ───────────────────────────────────────────────────

/**
 * App Menu settings screen. Lists all registered apps with visibility
 * toggles, drag-to-reorder, and inline param editing for config-only apps.
 * Uses a blacklist model: all registry apps are visible by default;
 * the user stores which ones they've hidden.
 */
export default function AppMenuView() {
  const { t } = useTranslation()
  const [menuState, setMenuState] = useAtom(appMenuAtom)

  const plugins = useMemo(() => getAllTilePlugins(), [])
  const configs = useMemo(() => getAllAppConfigs(), [])

  // Derive the current state (handle legacy migration in atom).
  const state: AppMenuState = useMemo(() => {
    if (!menuState || typeof menuState !== 'object' || Array.isArray(menuState)) {
      return { hiddenApps: [], customApps: [] }
    }
    return menuState as AppMenuState
  }, [menuState])

  const setState = useCallback(
    (fn: (prev: AppMenuState) => AppMenuState) => {
      setMenuState((prev) => {
        const current: AppMenuState = (!prev || typeof prev !== 'object' || Array.isArray(prev))
          ? { hiddenApps: [], customApps: [] }
          : prev as AppMenuState
        return fn(current)
      })
    },
    [setMenuState],
  )

  // Plugin/config lookup for labels/descriptions.
  const pluginMap = useMemo(() => new Map(plugins.map((p) => [p.id, p])), [plugins])
  const configMap = useMemo(() => new Map(configs.map((c) => [c.id, c])), [configs])
  const hiddenSet = useMemo(() => new Set(state.hiddenApps), [state.hiddenApps])

  // Build unified display list (all apps: registry + custom).
  const displayItems: DisplayItem[] = useMemo(() => {
    const items: DisplayItem[] = []

    // Registry plugins (except 'empty').
    for (const p of plugins) {
      if (p.id === 'empty') continue
      items.push({
        id: p.id,
        label: p.label,
        description: p.description,
        visible: !hiddenSet.has(p.id),
        isCustom: false,
        isConfig: false,
        order: items.length,
      })
    }

    // Registry configs.
    for (const c of configs) {
      items.push({
        id: c.id,
        label: c.label,
        description: c.description,
        visible: !hiddenSet.has(c.id),
        isCustom: false,
        isConfig: true,
        params: c.params,
        order: items.length,
      })
    }

    // Custom-only items (not backed by registry).
    for (const custom of state.customApps) {
      if (pluginMap.has(custom.id) || configMap.has(custom.id)) continue
      items.push({
        id: custom.id,
        label: custom.config.label,
        description: custom.config.description,
        visible: true, // custom apps are always visible
        isCustom: true,
        isConfig: true,
        pluginId: custom.config.pluginId,
        params: custom.params,
        customConfig: custom.config,
        order: items.length,
      })
    }

    return items
  }, [plugins, configs, hiddenSet, state.customApps, pluginMap, configMap])

  // ── Toggle visibility ──────────────────────────────────────────
  const toggleVisible = useCallback(
    (id: string) => {
      setState((prev) => {
        const isHidden = prev.hiddenApps.includes(id)
        return {
          ...prev,
          hiddenApps: isHidden
            ? prev.hiddenApps.filter((h) => h !== id)
            : [...prev.hiddenApps, id],
        }
      })
    },
    [setState],
  )

  // ── Show / Hide all ────────────────────────────────────────────
  const allVisible = displayItems.every((i) => i.visible)
  const toggleAll = useCallback(() => {
    setState((prev) => {
      if (allVisible) {
        // Hide all registry apps.
        const registryIds = plugins
          .filter((p) => p.id !== 'empty')
          .map((p) => p.id)
          .concat(configs.map((c) => c.id))
        return { ...prev, hiddenApps: registryIds }
      }
      // Show all: clear the blacklist.
      return { ...prev, hiddenApps: [] }
    })
  }, [allVisible, setState, plugins, configs])

  // ── Drag to reorder (custom apps only) ─────────────────────────
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const dragStartY = useRef(0)
  const dragStartIdx = useRef(0)
  const currentIdx = useRef(0)

  const onDragStart = useCallback(
    (id: string, e: ReactPointerEvent) => {
      // Only custom apps can be reordered.
      if (!id.startsWith('custom-')) return

      e.preventDefault()
      e.stopPropagation()

      const el = e.currentTarget.closest('[data-app-row]') as HTMLElement | null
      if (!el) return

      el.setPointerCapture(e.pointerId)
      setDraggingId(id)
      dragStartY.current = e.clientY
      dragStartIdx.current = displayItems.findIndex((i) => i.id === id)
      currentIdx.current = dragStartIdx.current

      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientY - dragStartY.current
        const rowHeight = el.offsetHeight + 4 // gap
        const offset = Math.round(delta / rowHeight)
        const newIdx = Math.max(0, Math.min(displayItems.length - 1, dragStartIdx.current + offset))

        if (newIdx !== currentIdx.current) {
          currentIdx.current = newIdx
          setState((prev) => {
            const customApps = [...prev.customApps]
            const fromIdx = customApps.findIndex((c) => c.id === id)
            if (fromIdx === -1) return prev
            const [moved] = customApps.splice(fromIdx, 1)
            // Insert at the target position among custom apps.
            const targetCustomIdx = Math.min(newIdx, customApps.length)
            customApps.splice(targetCustomIdx, 0, moved)
            // Reassign orders.
            return {
              ...prev,
              customApps: customApps.map((c, i) => ({ ...c, order: i })),
            }
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
    [displayItems, setState],
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

  // ── Update a config/custom item ────────────────────────────────
  const updateCustomParams = useCallback(
    (id: string, params: Record<string, string>) => {
      setState((prev) => ({
        ...prev,
        customApps: prev.customApps.map((c) =>
          c.id === id ? { ...c, params } : c,
        ),
      }))
    },
    [setState],
  )

  const updateCustomConfig = useCallback(
    (id: string, config: { label: string; description?: string; pluginId: string }) => {
      setState((prev) => ({
        ...prev,
        customApps: prev.customApps.map((c) =>
          c.id === id ? { ...c, config } : c,
        ),
      }))
    },
    [setState],
  )

  // ── Delete a custom item ───────────────────────────────────────
  const deleteCustom = useCallback(
    (id: string) => {
      setState((prev) => ({
        ...prev,
        customApps: prev.customApps.filter((c) => c.id !== id),
      }))
      setExpandedIds((prev) => { const next = new Set(prev); next.delete(id); return next })
    },
    [setState],
  )

  // ── Create a new custom app ────────────────────────────────────
  const addCustom = useCallback(() => {
    const pluginsWithParams = plugins.filter((p) => p.id !== 'empty' && p.supportedParams && p.supportedParams.length > 0)
    const defaultPlugin = pluginsWithParams[0]?.id ?? plugins.find((p) => p.id !== 'empty')?.id ?? 'term'
    const maxOrder = state.customApps.reduce((m, c) => Math.max(m, c.order), -1)

    const newCustom: CustomApp = {
      id: `custom-${Date.now()}`,
      order: maxOrder + 1,
      params: {},
      config: {
        label: 'New App',
        pluginId: defaultPlugin,
      },
    }

    setState((prev) => ({
      ...prev,
      customApps: [...prev.customApps, newCustom],
    }))
    setExpandedIds((prev) => new Set(prev).add(newCustom.id))
  }, [plugins, state.customApps, setState])

  // ── Determine icon for an item ─────────────────────────────────
  const getIcon = useCallback(
    (item: DisplayItem) => {
      const pluginId = item.isCustom ? item.pluginId : undefined
      return {
        classes: getAppIconClasses(item.id, pluginId),
        letter: getAppIconLetter(
          item.id,
          pluginMap.get(item.id)?.label ?? configMap.get(item.id)?.label ?? item.label,
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
        {displayItems.map((item) => {
          const expanded = expandedIds.has(item.id)
          const { classes: iconClasses, letter } = getIcon(item)

          return (
            <div key={item.id} data-app-row>
              {/* Row content — the grabbable / draggable surface */}
              <div
                className={`${row} ${draggingId === item.id ? 'bg-white/5' : ''}`}
              >
                {item.isCustom && (
                  <DragHandle onPointerDown={(e) => onDragStart(item.id, e)} />
                )}

                {/* Icon */}
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-xs font-bold ${iconClasses.bg} ${iconClasses.text}`}
                >
                  {letter}
                </div>

                {/* Label + description + expand toggle */}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-popover-foreground">{item.label}</div>
                  {item.description && (
                    <div className="text-[11px] text-muted-foreground">{item.description}</div>
                  )}
                  {item.isConfig && (
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
              {item.isConfig && expanded && (
                <EditingForm
                  item={{
                    id: item.id,
                    params: item.params,
                    customConfig: item.customConfig ?? (item.isCustom ? { label: item.label, description: item.description, pluginId: item.pluginId ?? 'term' } : undefined),
                  }}
                  plugins={plugins}
                  onUpdate={(patch) => {
                    if (item.isCustom) {
                      if (patch.params) updateCustomParams(item.id, patch.params)
                      if (patch.customConfig) updateCustomConfig(item.id, patch.customConfig)
                    }
                    // Registry config items: params would be stored via a future feature.
                  }}
                  onDelete={() => {
                    if (item.isCustom) deleteCustom(item.id)
                  }}
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
