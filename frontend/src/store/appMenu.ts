import { atomWithStorage } from 'jotai/utils';
import type { TilePlugin } from '../wm/tilePlugins';

// ── Data model (blacklist approach) ──────────────────────────────

export interface CustomApp {
  /** Unique identifier (always starts with `custom-`). */
  id: string;
  /** Display order among all apps (lower = higher in list). */
  order: number;
  /** Editable params merged into the plugin iframe src. */
  params: Record<string, string>;
  /** User-defined label, description, and target plugin. */
  config: {
    label: string;
    description?: string;
    pluginId: string;
  };
}

export interface AppMenuState {
  /** IDs of registry apps the user has explicitly hidden (blacklist). */
  hiddenApps: string[];
  /**
   * Default-hidden plugins the user explicitly turned back on. Kept separate
   * from `hiddenApps` so "never touched" and "deliberately shown" stay
   * distinguishable for plugins that declare `defaultHidden`.
   */
  shownApps?: string[];
  /** Custom apps created by the user. */
  customApps: CustomApp[];
}

// ── Legacy type for migration ────────────────────────────────────

interface LegacyAppMenuItem {
  id: string;
  visible: boolean;
  order: number;
  params?: Record<string, string>;
  isCustom?: boolean;
  customConfig?: {
    label: string;
    description?: string;
    pluginId: string;
  };
}

// ── Atom ─────────────────────────────────────────────────────────

const EMPTY_STATE: AppMenuState = { hiddenApps: [], customApps: [] };

/**
 * Persisted app menu state. Uses a blacklist model: all registry apps
 * are visible by default; the user stores which ones they've hidden.
 */
export const appMenuAtom = atomWithStorage<AppMenuState | LegacyAppMenuItem[]>(
  'suwu:app-menu',
  EMPTY_STATE,
);

// ── Pure helpers ─────────────────────────────────────────────────

/**
 * Visibility for a registry app, honoring a plugin's `defaultHidden` flag.
 *
 * A plain plugin is visible unless blacklisted. A `defaultHidden` plugin is
 * hidden until the user explicitly enables it (`shownApps`), so "never
 * touched" reads as off while an explicit enable still sticks.
 */
export function isAppHidden(
  id: string,
  defaultHidden: boolean | undefined,
  state: AppMenuState,
): boolean {
  if (state.hiddenApps.includes(id)) return true;
  if (defaultHidden) return !(state.shownApps ?? []).includes(id);
  return false;
}

/** Get the combined order of all apps (registry + custom). */
function getUnifiedOrder(plugins: TilePlugin[], state: AppMenuState): Map<string, number> {
  const order = new Map<string, number>();

  // Registry items: use customApps order if present, otherwise registry index.
  const allRegistry = plugins.filter((p) => p.id !== 'empty');
  for (let i = 0; i < allRegistry.length; i++) {
    const id = allRegistry[i].id;
    const custom = state.customApps.find((c) => c.id === id);
    order.set(id, custom?.order ?? i);
  }

  // Custom-only items (not in registry).
  for (const c of state.customApps) {
    if (!order.has(c.id)) {
      order.set(c.id, c.order);
    }
  }

  return order;
}

/** A user-created app entry surfaced in the app menu. */
interface CustomAppEntry {
  id: string;
  label: string;
  description?: string;
  pluginId: string;
  params?: Record<string, string>;
}

/**
 * Return visible apps in order, merged from plugins + custom items.
 * Registry apps are always included unless explicitly hidden.
 */
export function getVisibleApps(
  plugins: TilePlugin[],
  state: AppMenuState,
): Array<
  | { kind: 'plugin'; plugin: TilePlugin; params?: Record<string, string> }
  | { kind: 'config'; config: CustomAppEntry; params?: Record<string, string> }
> {
  const pluginMap = new Map(plugins.map((p) => [p.id, p]));
  const order = getUnifiedOrder(plugins, state);

  interface AppEntry {
    id: string;
    kind: 'plugin' | 'config';
    order: number;
    plugin?: TilePlugin;
    config?: CustomAppEntry;
    params?: Record<string, string>;
  }

  const entries: AppEntry[] = [];

  // Add all registry plugins (except 'empty' placeholder).
  for (const p of plugins) {
    if (p.id === 'empty') continue;
    if (isAppHidden(p.id, p.defaultHidden, state)) continue;
    entries.push({
      id: p.id,
      kind: 'plugin',
      order: order.get(p.id) ?? 0,
      plugin: p,
    });
  }

  // Add custom-only items (not backed by a registry plugin).
  for (const custom of state.customApps) {
    if (pluginMap.has(custom.id)) continue;
    const targetPlugin = pluginMap.get(custom.config.pluginId);
    if (!targetPlugin) continue;
    entries.push({
      id: custom.id,
      kind: 'config',
      order: order.get(custom.id) ?? 0,
      config: {
        id: custom.id,
        label: custom.config.label,
        description: custom.config.description,
        pluginId: custom.config.pluginId,
        params: custom.params,
      },
      params: custom.params,
    });
  }

  // Sort by unified order.
  entries.sort((a, b) => a.order - b.order);

  return entries.map((e) => {
    if (e.kind === 'plugin')
      return { kind: 'plugin' as const, plugin: e.plugin!, params: e.params };
    return { kind: 'config' as const, config: e.config!, params: e.params };
  });
}
