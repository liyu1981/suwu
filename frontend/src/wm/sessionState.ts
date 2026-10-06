/** Per-plugin UI state shapes persisted across reloads. */

import type { RestRequestDraft } from '../store/resthelper';

export interface FileBrowserSessionState {
  currentPath: string;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  showHidden?: boolean;
}

export interface DropboxSessionState {
  searchQuery?: string;
  sortBy?: 'name' | 'date' | 'size';
}

/** One repository tab of the Git Graph tile (see components/gitgraph/repoTabs). */
export interface GitGraphTabState {
  id: string;
  repoPath: string | null;
  branch: string;
  selectedWorktree: string | null;
  allBranches: boolean;
  autoRefreshMs: number;
  scrollPosition: number;
  expandedIndex: number | null;
  worktreeBrowserOpen: boolean;
  comparisons: Array<{
    id: string;
    repoPath: string;
    base: string;
    target: string;
    focusFile?: string;
  }>;
  activeView: string;
}

export interface GitGraphSessionState {
  tabs: GitGraphTabState[];
  activeTabId: string;
  nextTabId: number;
  /**
   * Single-repo fields written by pre-multi-tab builds. Read once by
   * `parseRepoTabs` to migrate old sessions; never written again.
   */
  /** @deprecated */
  repoPath?: string;
  /** @deprecated */
  branch?: string;
  /** @deprecated */
  expandedCommitIndex?: number | null;
  /** @deprecated */
  scrollPosition?: number;
  /** @deprecated */
  showRemoteBranches?: boolean;
  /** @deprecated */
  selectedWorktree?: string | null;
  /** @deprecated */
  allBranches?: boolean;
  /** @deprecated */
  diffTabs?: Array<{
    id: string;
    repoPath: string;
    base: string;
    target: string;
    focusFile?: string;
  }>;
  /** @deprecated */
  activeTab?: string;
}

export interface CodeExplorerSessionState {
  /** Saved (on-disk) tabs to reopen; unsaved buffers are never persisted. */
  tabs: Array<{ path: string; ranges?: Array<{ start: number; end: number }> }>;
  activePath?: string;
}

export interface RestHelperSessionState {
  /** In-progress request draft. Response bodies are never persisted here. */
  draft?: RestRequestDraft;
}

export interface FolderSyncSessionState {
  /** Which job's activity log is expanded. Sync run state is never persisted. */
  selectedJobId?: string;
}

/** Per-tile session state entry. */
export interface TileEntry {
  tileType: string;
  state: Record<string, unknown>;
}

/** Map of pane ID → saved session state for one server instance. */
export type TileSessionMap = Record<string, TileEntry>;

/**
 * Session state keyed by server start timestamp (ISO 8601).
 * Each server instance gets its own slot. At most 5 kept (FIFO).
 */
export type SessionStore = Record<string, TileSessionMap>;

export const SESSION_STATE_KEY = 'tiling-session-state';
export const MAX_SERVER_SESSIONS = 5;
