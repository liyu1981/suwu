/** Per-plugin UI state shapes persisted across reloads. */

export interface FileBrowserSessionState {
  currentPath: string
  sortKey?: string
  sortDir?: 'asc' | 'desc'
  showHidden?: boolean
}

export interface DropboxSessionState {
  searchQuery?: string
  sortBy?: 'name' | 'date' | 'size'
}

export interface GitGraphSessionState {
  repoPath?: string
  branch?: string
  expandedCommitIndex?: number | null
  scrollPosition?: number
  showRemoteBranches?: boolean
  selectedWorktree?: string | null
  allBranches?: boolean
  diffTabs?: Array<{ id: string; repoPath: string; base: string; target: string; focusFile?: string }>
  activeTab?: string
}

export interface CodeExplorerSessionState {
  /** Saved (on-disk) tabs to reopen; unsaved buffers are never persisted. */
  tabs: Array<{ path: string; ranges?: Array<{ start: number; end: number }> }>
  activePath?: string
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
