import type { ReactNode } from 'react';
import type { TileType } from './layout';

/** Context passed to a tile plugin's toolbar renderer. */
export interface ToolbarContext {
  paneId: string;
  fontSize: number;
  fontDefault: number;
  setFontSize: (size: number) => void;
  closeTile: (id: string) => void;
  startSwap: (id: string) => void;
}

/** Context passed to a tile plugin's render function. */
export interface TileRenderContext {
  paneId: string;
  /** Initial path passed from the action resolver (e.g. ?path=... in iframe src). */
  initialPath?: string;
  /** Open the tile-type picker for this pane (used by the empty placeholder). */
  onOpenPicker?: (paneId: string) => void;
  /** Extra URL params merged into the iframe src (e.g. from a custom app). */
  params?: Record<string, string>;
}

/** Documentation for a single parameter a plugin accepts. */
export interface PluginParamDoc {
  key: string;
  label: string;
  description?: string;
  defaultValue?: string;
}

export interface TilePlugin {
  id: TileType;
  label: string;
  /**
   * A name for one configured tile, when the plugin can derive it from the
   * tile's params: an extension tile is "note", not "Extension". Falls back to
   * `label` whenever it returns nothing, so a misconfigured tile is still named.
   */
  title?: (params?: Record<string, string>) => string | undefined;
  description?: string;
  /** Declared parameters this plugin accepts (shown as hints in the editor). */
  supportedParams?: PluginParamDoc[];
  /**
   * Keep this app out of the picker until the user turns it on in App Menu
   * settings. Combined with `shownApps` in AppMenuState, so an explicit
   * enable persists.
   */
  defaultHidden?: boolean;
  /** Render the tile content (iframe, React component, etc.). */
  render: (paneId: string, context?: TileRenderContext) => ReactNode;
  /**
   * Render type-specific toolbar buttons. These appear between the divider
   * and the shared drag/close section of TileTools.
   */
  renderToolbar?: (ctx: ToolbarContext) => ReactNode;
}

const registry = new Map<TileType, TilePlugin>();

export function registerTilePlugin(plugin: TilePlugin): void {
  registry.set(plugin.id, plugin);
}

export function getTilePlugin(id: TileType): TilePlugin | undefined {
  return registry.get(id);
}

/**
 * The name to show for one tile: what the plugin derives from its params, else
 * the plugin's own label. One helper so the phone's header, its overview and the
 * desktop's swap strip cannot disagree about what a tile is called.
 */
export function tileTitle(
  plugin: TilePlugin | undefined,
  params?: Record<string, string>,
): string | undefined {
  const derived = plugin?.title?.(params)?.trim();
  if (derived) return derived;
  return plugin?.label;
}

export function getAllTilePlugins(): TilePlugin[] {
  return [...registry.values()];
}
