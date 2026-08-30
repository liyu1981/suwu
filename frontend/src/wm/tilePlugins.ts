import type { ReactNode } from 'react'
import type { MoveDir, TileType } from './layout'

/** Context passed to a tile plugin's toolbar renderer. */
export interface ToolbarContext {
  paneId: string
  fontSize: number
  fontDefault: number
  setFontSize: (size: number) => void
  canMove: (id: string, dir: MoveDir) => boolean
  move: (id: string, dir: MoveDir) => void
  closeTile: (id: string) => void
  startSwap: (id: string) => void
}

/** Context passed to a tile plugin's render function. */
export interface TileRenderContext {
  paneId: string
  /** Initial path passed from the action resolver (e.g. ?path=... in iframe src). */
  initialPath?: string
  /** Open the tile-type picker for this pane (used by the empty placeholder). */
  onOpenPicker?: (paneId: string) => void
  /** Extra URL params from an AppConfig preset (merged into iframe src). */
  params?: Record<string, string>
}

export interface TilePlugin {
  id: TileType
  label: string
  description?: string
  /** Render the tile content (iframe, React component, etc.). */
  render: (paneId: string, context?: TileRenderContext) => ReactNode
  /**
   * Render type-specific toolbar buttons. These appear between the divider
   * and the shared move/close section of TileTools.
   */
  renderToolbar?: (ctx: ToolbarContext) => ReactNode
}

const registry = new Map<TileType, TilePlugin>()

export function registerTilePlugin(plugin: TilePlugin): void {
  registry.set(plugin.id, plugin)
}

export function getTilePlugin(id: TileType): TilePlugin | undefined {
  return registry.get(id)
}

export function getAllTilePlugins(): TilePlugin[] {
  return [...registry.values()]
}
