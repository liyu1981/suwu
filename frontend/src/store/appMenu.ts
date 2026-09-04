import { atomWithStorage } from 'jotai/utils'
import type { AppConfig } from '../wm/appConfigs'
import type { TilePlugin } from '../wm/tilePlugins'

export interface AppMenuItem {
  /** Unique identifier — matches plugin id or app config id. */
  id: string
  /** Whether this app appears in the "New App" picker. */
  visible: boolean
  /** Display order (lower = higher in list). Managed by drag reorder. */
  order: number
  /** For config-only apps: editable params. Undefined for real plugins. */
  params?: Record<string, string>
}

/**
 * Persisted app menu state: visibility, order, and config params.
 * Bootstrapped from the live plugin/config registry on first load.
 */
export const appMenuAtom = atomWithStorage<AppMenuItem[]>('suwu:app-menu', [])

/** Apps hidden by default on first visit. */
const DEFAULT_HIDDEN = new Set(['fileviewer', 'diff'])

/**
 * Merge the live registry (plugins + configs) with the stored user
 * preferences. Adds new entries, removes stale ones, preserves user
 * overrides.
 */
export function bootstrapAppMenu(
  plugins: TilePlugin[],
  configs: AppConfig[],
  current: AppMenuItem[],
): AppMenuItem[] {
  const allIds = new Set<string>()
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
    allIds.add(p.id)
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
    allIds.add(c.id)
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

  // Filter out stale entries (plugins/configs removed from code).
  const result: AppMenuItem[] = []
  for (const [id, item] of byId) {
    if (allIds.has(id)) {
      result.push(item)
    }
  }

  return result
}

/**
 * Return visible apps in order, merged from plugins + configs.
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

    const plugin = pluginMap.get(item.id)
    if (plugin) {
      result.push({ kind: 'plugin', plugin, params: item.params })
      continue
    }

    const config = configMap.get(item.id)
    if (config) {
      result.push({ kind: 'config', config, params: item.params ?? config.params })
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
