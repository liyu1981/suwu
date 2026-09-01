/** Per-plugin session state shapes persisted across reloads. */

export interface TermSessionState {
  cwd?: string
  foreground?: string
}

export interface FileBrowserSessionState {
  currentPath: string
  sortKey?: string
  sortDir?: 'asc' | 'desc'
}

export interface DropboxSessionState {
  searchQuery?: string
  sortBy?: 'name' | 'date' | 'size'
}

/** Per-tile session state entry. */
export interface TileEntry {
  tileType: string
  state: Record<string, unknown>
}

/** Map of pane ID → saved session state for one server instance. */
export type TileSessionMap = Record<string, TileEntry>

/**
 * Session state keyed by server start timestamp (ISO 8601).
 * Each server instance gets its own slot. At most 5 kept (FIFO).
 */
export type SessionStore = Record<string, TileSessionMap>

export const SESSION_STATE_KEY = 'tiling-session-state'
export const MAX_SERVER_SESSIONS = 5
