/**
 * useRepoTabs - owns the Git Graph tile's repository tab list.
 *
 * The list *is* the tile's session state: it is restored once from the parent
 * window's saved pane state (falling back to `?path=` on a cold start) and
 * reported back on every change, so tabs survive reloads, focus-mode
 * recreation and pane churn.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReportTileState, useTileSessionState } from '../CommonTileContainer';
import type { GitGraphSessionState } from '../../wm/sessionState';
import {
  COMMITS_VIEW,
  mergeTab,
  newRepoTab,
  parseRepoTabs,
  sameRepo,
  type RepoTab,
  type RepoTabSnapshot,
} from './repoTabs';

export interface UseRepoTabs {
  tabs: RepoTab[];
  activeTab: RepoTab | undefined;
  activeTabId: string;
  /** Index of the active tab in `tabs` (-1 when there are none). */
  activeIndex: number;
  select: (id: string) => void;
  /** Open a repository as a tab. Activates the existing tab if already open. */
  openRepo: (path: string, tabId?: string) => void;
  /** Append an empty tab showing the repo picker, and activate it. */
  addTab: () => void;
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  closeAll: () => void;
  patch: (id: string, next: Partial<RepoTab>) => void;
}

const EMPTY: RepoTabSnapshot = { tabs: [], activeTabId: '', nextTabId: 1 };

export function useRepoTabs(urlPath: string | null): UseRepoTabs {
  const saved = useTileSessionState<GitGraphSessionState>();
  const reportState = useReportTileState();
  const [snapshot, setSnapshot] = useState<RepoTabSnapshot>(() => parseRepoTabs(null, urlPath));
  const restored = useRef(false);

  // One-shot restore. Reports are withheld by useReportTileState until the WM
  // has answered, so the seed state can never clobber what we are restoring.
  useEffect(() => {
    if (!saved || restored.current) return;
    restored.current = true;
    setSnapshot(parseRepoTabs(saved, urlPath));
  }, [saved, urlPath]);

  useEffect(() => {
    reportState({
      tabs: snapshot.tabs,
      activeTabId: snapshot.activeTabId,
      nextTabId: snapshot.nextTabId,
    });
  }, [snapshot, reportState]);

  const select = useCallback((id: string) => {
    setSnapshot((prev) =>
      prev.activeTabId === id || !prev.tabs.some((tab) => tab.id === id)
        ? prev
        : { ...prev, activeTabId: id },
    );
  }, []);

  const patch = useCallback((id: string, next: Partial<RepoTab>) => {
    setSnapshot((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) => (tab.id === id ? mergeTab(tab, next) : tab)),
    }));
  }, []);

  const addTab = useCallback(() => {
    setSnapshot((prev) => {
      const id = `r${prev.nextTabId}`;
      return {
        tabs: [...prev.tabs, newRepoTab(id, null)],
        activeTabId: id,
        nextTabId: prev.nextTabId + 1,
      };
    });
  }, []);

  /**
   * Point a tab at a repository.
   *
   * - A tab already tracking that repo wins: the request lands there and the
   *   empty tab it came from is dropped, so a repo never opens twice.
   * - Otherwise the tab is retargeted, and everything scoped to the previous
   *   repository (worktree, expanded row, scroll, comparisons) is discarded.
   */
  const openRepo = useCallback((path: string, tabId?: string) => {
    setSnapshot((prev) => {
      const targetId = tabId ?? prev.activeTabId;
      const target = prev.tabs.find((tab) => tab.id === targetId);
      if (!target) {
        const id = `r${prev.nextTabId}`;
        return {
          tabs: [...prev.tabs, newRepoTab(id, path)],
          activeTabId: id,
          nextTabId: prev.nextTabId + 1,
        };
      }
      const existing = prev.tabs.find((tab) => tab.id !== targetId && sameRepo(tab.repoPath, path));
      if (existing) {
        return {
          ...prev,
          tabs: prev.tabs.filter((tab) => tab.id !== targetId || tab.repoPath !== null),
          activeTabId: existing.id,
        };
      }
      return {
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.id === targetId
            ? mergeTab(tab, {
                repoPath: path,
                selectedWorktree: null,
                expandedIndex: null,
                worktreeBrowserOpen: false,
                scrollPosition: 0,
                comparisons: [],
                activeView: COMMITS_VIEW,
              })
            : tab,
        ),
      };
    });
  }, []);

  const close = useCallback((id: string) => {
    setSnapshot((prev) => {
      // A tile always keeps one graph: closing the last tab empties the tile
      // instead, and the empty state offers the picker again.
      if (prev.tabs.length <= 1) return prev;
      const index = prev.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return prev;
      const tabs = prev.tabs.filter((tab) => tab.id !== id);
      const activeTabId =
        prev.activeTabId === id ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? '') : prev.activeTabId;
      return { ...prev, tabs, activeTabId };
    });
  }, []);

  const closeOthers = useCallback((id: string) => {
    setSnapshot((prev) => {
      if (!prev.tabs.some((tab) => tab.id === id)) return prev;
      return { ...prev, tabs: prev.tabs.filter((tab) => tab.id === id), activeTabId: id };
    });
  }, []);

  const closeAll = useCallback(() => {
    setSnapshot((prev) => ({ ...EMPTY, nextTabId: prev.nextTabId }));
  }, []);

  const activeIndex = useMemo(
    () => snapshot.tabs.findIndex((tab) => tab.id === snapshot.activeTabId),
    [snapshot.tabs, snapshot.activeTabId],
  );

  return {
    tabs: snapshot.tabs,
    activeTab: activeIndex >= 0 ? snapshot.tabs[activeIndex] : undefined,
    activeTabId: snapshot.activeTabId,
    activeIndex,
    select,
    openRepo,
    addTab,
    close,
    closeOthers,
    closeAll,
    patch,
  };
}
