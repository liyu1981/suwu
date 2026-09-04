import { atomWithStorage } from 'jotai/utils'
import type { AppConfig } from '../wm/appConfigs'
import type { TilePlugin } from '../wm/tilePlugins'

export interface AppMenuItem {
  /** Unique identifier — matches plugin id, config id, or a custom `custom-*` id. */
  id: string
  /** Whether this app appears in the "New App" picker. */
  visible: boolean
  /** Display order (lower = higher in list). Managed by drag reorder. */
  order: number
  /** Editable params merged into the plugin iframe src. */
  params?: Record<string, string>
  /** True when user-created (not from the AppConfig code registry). */
  isCustom?: boolean
  /** Metadata for custom items (label, description, which plugin to use). */
  customConfig?: {
    label: string
    description?: string
    pluginId: string
  }
}

/**
 * Persisted app menu state: visibility, order, and config params.
 * Bootstrapped from the live plugin/config registry on first load.
 */
export const appMenuAtom = atomWithStorage<AppMenuItem[]>('suwu:app-menu', [])

/** Apps hidden by default on first visit. */
const DEFAULT_HIDDEN = new Set(['fileviewer', 'diff'])

/**
 * Create a blank custom app entry ready for editing.
 */
export function createCustomApp(
  plugins: TilePlugin[],
  maxOrder: number,
): AppMenuItem {
  // Prefer a plugin that accepts params; fall back to first non-empty plugin.
  const defaultPlugin =
    plugins.find((p) => p.id !== 'empty' && p.supportedParams && p.supportedParams.length > 0)?.id ??
    plugins.find((p) => p.id !== 'empty')?.id ??
    'term'
  return {
    id: `custom-${Date.now()}`,
    visible: true,
    order: maxOrder + 1,
    params: {},
    isCustom: true,
    customConfig: {
      label: 'New App',
      pluginId: defaultPlugin,
    },
  }
}

/**
 * Merge the live registry (plugins + configs) with the stored user
 * preferences. Adds new entries, removes stale ones, preserves user
 * overrides.  Custom (user-created) items are kept as-is.
 */
export function bootstrapAppMenu(
  plugins: TilePlugin[],
  configs: AppConfig[],
  current: AppMenuItem[],
): AppMenuItem[] {
  const registryIds = new Set<string>()
  const byId = new Map<string, AppMenuItem>()

  // Index current stored items.
  for (const item of current) {
    byId.set(item.id, item)
  }

  // Determine max order from current items.
  let maxOrder = current.reduce((m, i) => Math.max(m, i.order), -1)

  // Merge plugins (skip 'empty' — it's a placeholder, not a real app).
  for (const p of plugins) {
    if (p.id === 'empty') continue
    registryIds.add(p.id)
    if (!byId.has(p.id)) {
      maxOrder++
      byId.set(p.id, {
        id: p.id,
        visible: !DEFAULT_HIDDEN.has(p.id),
        order: maxOrder,
      })
    }
  }

  // Merge app configs.
  for (const c of configs) {
    registryIds.add(c.id)
    if (!byId.has(c.id)) {
      maxOrder++
      byId.set(c.id, {
        id: c.id,
        visible: !DEFAULT_HIDDEN.has(c.id),
        order: maxOrder,
        params: { ...c.params },
      })
    } else {
      // Ensure stored config items have params (backfill from registry).
      const stored = byId.get(c.id)!
      if (!stored.params) {
        stored.params = { ...c.params }
      } else {
        // Add any new param keys from registry, preserve user values.
        for (const [k, v] of Object.entries(c.params)) {
          if (!(k in stored.params)) {
            stored.params[k] = v
          }
        }
      }
    }
  }

  // Keep: registry items + custom (user-created) items. Drop the rest.
  const result: AppMenuItem[] = []
  for (const [id, item] of byId) {
    if (item.isCustom || registryIds.has(id)) {
      result.push(item)
    }
  }

  return result
}

/**
 * Return visible apps in order, merged from plugins + configs + custom items.
 */
export function getVisibleApps(
  plugins: TilePlugin[],
  configs: AppConfig[],
  menuItems: AppMenuItem[],
): Array<
  | { kind: 'plugin'; plugin: TilePlugin; params?: Record<string, string> }
  | { kind: 'config'; config: AppConfig; params?: Record<string, string> }
> {
  const pluginMap = new Map(plugins.map((p) => [p.id, p]))
  const configMap = new Map(configs.map((c) => [c.id, c]))

  // Build list from menuItems (which has the order).
  const sorted = [...menuItems].sort((a, b) => a.order - b.order)

  const result: Array<
    | { kind: 'plugin'; plugin: TilePlugin; params?: Record<string, string> }
    | { kind: 'config'; config: AppConfig; params?: Record<string, string> }
  > = []

  for (const item of sorted) {
    if (!item.visible) continue

    // Real plugin
    const plugin = pluginMap.get(item.id)
    if (plugin) {
      result.push({ kind: 'plugin', plugin, params: item.params })
      continue
    }

    // Registry config
    const config = configMap.get(item.id)
    if (config) {
      result.push({ kind: 'config', config, params: item.params ?? config.params })
      continue
    }

    // Custom item → synthesise an AppConfig for the picker.
    if (item.isCustom && item.customConfig) {
      const targetPlugin = pluginMap.get(item.customConfig.pluginId)
      if (targetPlugin) {
        result.push({
          kind: 'config',
          config: {
            id: item.id,
            label: item.customConfig.label,
            description: item.customConfig.description,
            pluginId: item.customConfig.pluginId,
            params: item.params ?? {},
            iconBg: '',
            iconLetter: '',
          },
          params: item.params,
        })
      }
    }
  }

  // If no menuItems match (e.g. empty storage), fall back to registry order.
  if (result.length === 0) {
    for (const p of plugins) {
      if (p.id === 'empty') continue
      if (!DEFAULT_HIDDEN.has(p.id)) {
        result.push({ kind: 'plugin', plugin: p })
      }
    }
    for (const c of configs) {
      if (!DEFAULT_HIDDEN.has(c.id)) {
        result.push({ kind: 'config', config: c })
      }
    }
  }

  return result
}
