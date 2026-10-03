/**
 * Repo tab model for the Git Graph tile.
 *
 * A tile hosts N tabs. Each tab is a complete git graph for one repository —
 * worktree browser, all-branches toggle, expanded commit rows, comparison
 * (diff) tabs and its own auto-refresh interval. Every field on `RepoTab` is
 * serializable, so the tab list doubles as the pane's persisted session state
 * and survives reload / iframe recreation.
 *
 * Pure module: no React, no fetch. `parseRepoTabs` reads whatever the tile
 * session store holds — including the pre-tabs single-repo shape — and always
 * returns a well-formed list.
 */

// Explicit `.ts` extensions: this module is pure so the tab-restore checks in
// scripts/check-git-tabs.mjs can run it under Node's type stripping.
import { comparisonId } from './refs.ts';
import type { DiffTab } from './comparison.ts';
import type { GitGraphSessionState } from '../../wm/sessionState.ts';

/** Pseudo view id: the commit list, as opposed to a comparison tab. */
export const COMMITS_VIEW = 'commits';

/** Comparisons kept per tab before the oldest are dropped on serialize. */
export const MAX_COMPARISONS_PER_TAB = 12;

export interface RepoTab {
  id: string;
  /** null ⇒ the tab is an un-filled picker. */
  repoPath: string | null;
  branch: string;
  selectedWorktree: string | null;
  allBranches: boolean;
  autoRefreshMs: number;
  scrollPosition: number;
  expandedIndex: number | null;
  worktreeBrowserOpen: boolean;
  /** Comparison (diff) tabs, scoped to this repo. */
  comparisons: DiffTab[];
  /** `COMMITS_VIEW` or a comparison id. */
  activeView: string;
}

export interface RepoTabSnapshot {
  tabs: RepoTab[];
  activeTabId: string;
  /** Monotonic counter backing `tab.id`, so ids stay unique across reloads. */
  nextTabId: number;
}

export function newRepoTab(id: string, repoPath: string | null): RepoTab {
  return {
    id,
    repoPath,
    branch: 'HEAD',
    selectedWorktree: null,
    allBranches: true,
    autoRefreshMs: 0,
    scrollPosition: 0,
    expandedIndex: null,
    worktreeBrowserOpen: false,
    comparisons: [],
    activeView: COMMITS_VIEW,
  };
}

/** Trailing slashes are noise when comparing two repo paths. */
export function normalizeRepoPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export function sameRepo(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  return normalizeRepoPath(a) === normalizeRepoPath(b);
}

function segmentsOf(path: string): string[] {
  return normalizeRepoPath(path).split('/').filter(Boolean);
}

function lastSegments(path: string, count: number): string {
  const segments = segmentsOf(path);
  return segments.slice(Math.max(0, segments.length - count)).join('/');
}

/**
 * Tab labels: the repo basename, widened with parent segments only where two
 * tabs would otherwise be indistinguishable. A tile with `~/work/suwu` and
 * `~/tmp/suwu` shows `work/suwu` and `tmp/suwu`; unique names stay bare.
 */
export function tabLabels(paths: (string | null)[]): string[] {
  const labels = paths.map((path) => (path ? lastSegments(path, 1) : ''));
  const groups = new Map<string, number[]>();
  paths.forEach((path, index) => {
    if (!path) return;
    const key = labels[index];
    const group = groups.get(key);
    if (group) group.push(index);
    else groups.set(key, [index]);
  });
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    const wide = indexes.map((index) => lastSegments(paths[index] as string, 2));
    if (new Set(wide).size === indexes.length) {
      indexes.forEach((index, i) => {
        labels[index] = wide[i];
      });
      continue;
    }
    const full = indexes.map((index) => paths[index] as string);
    indexes.forEach((index, i) => {
      labels[index] = new Set(full).size === indexes.length ? full[i] : `${labels[index]} ${i + 1}`;
    });
  }
  return labels;
}

function sanitizeComparison(raw: unknown): DiffTab | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.repoPath !== 'string' ||
    typeof value.base !== 'string' ||
    typeof value.target !== 'string'
  ) {
    return null;
  }
  const tab: DiffTab = {
    // Recomputed rather than trusted: a hand-edited or older session entry may
    // carry a stale id, and comparison ids are the tab identity everywhere.
    id: comparisonId(value.repoPath, value.base, value.target),
    repoPath: value.repoPath,
    base: value.base,
    target: value.target,
  };
  if (typeof value.focusFile === 'string') tab.focusFile = value.focusFile;
  return tab;
}

/** Drop malformed comparisons and keep ids consistent with their refs. */
export function sanitizeComparisons(raw: unknown): DiffTab[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DiffTab[] = [];
  for (const entry of raw) {
    const comparison = sanitizeComparison(entry);
    if (!comparison || seen.has(comparison.id)) continue;
    seen.add(comparison.id);
    out.push(comparison);
  }
  return out.slice(0, MAX_COMPARISONS_PER_TAB);
}

/** Clamp `activeView` to the commit list or a comparison that still exists. */
function sanitizeActiveView(activeView: unknown, comparisons: DiffTab[]): string {
  if (typeof activeView !== 'string') return COMMITS_VIEW;
  if (activeView === COMMITS_VIEW) return COMMITS_VIEW;
  return comparisons.some((comparison) => comparison.id === activeView) ? activeView : COMMITS_VIEW;
}

/**
 * Apply a patch to a tab, keeping every invariant the UI relies on: a valid
 * active view, a bounded comparison list, and no negative indices.
 */
export function mergeTab(tab: RepoTab, patch: Partial<RepoTab>): RepoTab {
  const next = { ...tab, ...patch };
  next.comparisons = sanitizeComparisons(next.comparisons);
  next.activeView = sanitizeActiveView(next.activeView, next.comparisons);
  next.expandedIndex =
    typeof next.expandedIndex === 'number' && next.expandedIndex >= 0
      ? Math.floor(next.expandedIndex)
      : null;
  next.scrollPosition =
    typeof next.scrollPosition === 'number' && next.scrollPosition > 0 ? next.scrollPosition : 0;
  next.branch = typeof next.branch === 'string' && next.branch ? next.branch : 'HEAD';
  next.selectedWorktree = typeof next.selectedWorktree === 'string' ? next.selectedWorktree : null;
  next.allBranches = next.allBranches !== false;
  next.worktreeBrowserOpen = next.worktreeBrowserOpen === true;
  next.autoRefreshMs =
    typeof next.autoRefreshMs === 'number' && next.autoRefreshMs > 0 ? next.autoRefreshMs : 0;
  return next;
}

function sanitizeTab(raw: unknown, index: number, nextId: number): RepoTab | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === 'string' && value.id ? value.id : `r${nextId + index}`;
  const repoPath = typeof value.repoPath === 'string' && value.repoPath ? value.repoPath : null;
  const comparisons = sanitizeComparisons(value.comparisons);
  return mergeTab(newRepoTab(id, repoPath), {
    branch: typeof value.branch === 'string' ? value.branch : 'HEAD',
    selectedWorktree: typeof value.selectedWorktree === 'string' ? value.selectedWorktree : null,
    allBranches: value.allBranches !== false,
    autoRefreshMs: typeof value.autoRefreshMs === 'number' ? value.autoRefreshMs : 0,
    scrollPosition: typeof value.scrollPosition === 'number' ? value.scrollPosition : 0,
    expandedIndex: typeof value.expandedIndex === 'number' ? value.expandedIndex : null,
    worktreeBrowserOpen: value.worktreeBrowserOpen === true,
    comparisons,
    activeView: sanitizeActiveView(value.activeView, comparisons),
  });
}

/**
 * Read the tile's saved state into a tab list.
 *
 * Three cases, in precedence order:
 *   1. a saved tab list (current format) — sanitized;
 *   2. a pre-tabs single-repo state — promoted to one tab, comparisons kept;
 *   3. nothing saved — one tab seeded from `?path=`, or an empty picker tab.
 */
export function parseRepoTabs(
  saved: GitGraphSessionState | null,
  urlPath: string | null,
): RepoTabSnapshot {
  const seed = (path: string | null): RepoTabSnapshot => {
    const tab = newRepoTab('r1', path);
    return { tabs: [tab], activeTabId: tab.id, nextTabId: 2 };
  };

  if (saved && Array.isArray(saved.tabs)) {
    const nextId =
      typeof saved.nextTabId === 'number' && saved.nextTabId > 0 ? Math.floor(saved.nextTabId) : 1;
    const tabs: RepoTab[] = [];
    const used = new Set<string>();
    saved.tabs.forEach((raw, index) => {
      const tab = sanitizeTab(raw, index, nextId);
      if (!tab) return;
      while (used.has(tab.id)) tab.id = `r${nextId + tabs.length}`;
      used.add(tab.id);
      tabs.push(tab);
    });
    if (tabs.length > 0) {
      const activeTabId = tabs.some((tab) => tab.id === saved.activeTabId)
        ? (saved.activeTabId as string)
        : tabs[0].id;
      // Stay clear of every id in use, including one carried by a
      // hand-edited session, so generated ids can never collide.
      let nextTabId = nextId;
      for (const tab of tabs) {
        const match = /^r(\d+)$/.exec(tab.id);
        if (match) nextTabId = Math.max(nextTabId, Number(match[1]) + 1);
      }
      return { tabs, activeTabId, nextTabId };
    }
    // An explicitly emptied tile stays empty: the user closed every tab on
    // purpose, and re-seeding one here would resurrect a tab they dismissed.
    return { tabs: [], activeTabId: '', nextTabId: nextId };
  }

  // Pre-tabs state: one repo, flat comparison list.
  if (saved && typeof saved.repoPath === 'string' && saved.repoPath) {
    const comparisons = sanitizeComparisons(saved.diffTabs);
    const tab = mergeTab(newRepoTab('r1', saved.repoPath), {
      branch: typeof saved.branch === 'string' ? saved.branch : 'HEAD',
      selectedWorktree: typeof saved.selectedWorktree === 'string' ? saved.selectedWorktree : null,
      allBranches: saved.allBranches !== false,
      scrollPosition: typeof saved.scrollPosition === 'number' ? saved.scrollPosition : 0,
      comparisons,
      activeView: sanitizeActiveView(saved.activeTab, comparisons),
    });
    return { tabs: [tab], activeTabId: tab.id, nextTabId: 2 };
  }

  return seed(urlPath);
}
