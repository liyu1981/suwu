/**
 * useGitGraph Hook
 * Manages git graph state and data fetching
 */

import { useState, useEffect, useCallback } from 'react';
import type { GitCommit, GraphConfig, MuteConfig, GraphLayout } from './graph';
import { createGraphLayout } from './graph';

interface UseGitGraphOptions {
  repoPath?: string | null;
  branch?: string;
  maxCount?: number;
  followFirstParent?: boolean;
  /** When false, no fetch is performed (e.g. no path chosen yet). */
  enabled?: boolean;
  /** When provided, show only commits on branch not in base (worktree diff mode). */
  base?: string;
  config?: GraphConfig;
  muteConfig?: MuteConfig;
}

interface UseGitGraphReturn {
  commits: GitCommit[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  graphLayout: GraphLayout | null;
  commitHead: string | null;
  refresh: () => void;
  loadMore: () => void;
  expandedCommitIndex: number | null;
  setExpandedCommitIndex: (index: number | null) => void;
}

export function useGitGraph(options: UseGitGraphOptions = {}): UseGitGraphReturn {
  const {
    repoPath = '.',
    branch = 'HEAD',
    maxCount = 100,
    followFirstParent = false,
    enabled = true,
    base,
    config,
    muteConfig,
  } = options;

  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitHead, setCommitHead] = useState<string | null>(null);
  const [expandedCommitIndex, setExpandedCommitIndex] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);

  // Default config
  const defaultConfig: GraphConfig = {
    style: 'curved',
    colors: [
      '#0366d6', '#6f42c1', '#e36209', '#00875a', '#5067d6',
      '#f97583', '#79b8ff', '#b392f0', '#f9826c', '#85e89d',
      '#56d4dd', '#da3633', '#fdd663', '#0457c0', '#6e40c9',
    ],
    grid: {
      x: 24,
      y: 24,
      offsetX: 12,
      offsetY: 12,
      expandY: 260,
    },
    uncommittedChanges: 'OpenCircleAtTheUncommittedChanges',
  };

  const defaultMuteConfig: MuteConfig = {
    mergeCommits: false,
    commitsNotAncestorsOfHead: false,
  };

  const finalConfig = config ?? defaultConfig;
  const finalMuteConfig = muteConfig ?? defaultMuteConfig;

  // Fetch commits (initial load or refresh — always from scratch)
  const fetchCommits = useCallback(async () => {
    if (!enabled) {
      setCommits([]);
      setCommitHead(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setHasMore(true);

    try {
      const params = new URLSearchParams({
        path: repoPath ?? '.',
        branch: branch,
        count: maxCount.toString(),
      });

      const response = await fetch(`/api/git/commits?${params}`);

      let data: { commits?: GitCommit[] | null; head?: string | null; error?: string } | null = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok) {
        throw new Error(data?.error || `Failed to load commits (HTTP ${response.status})`);
      }

      const newCommits = Array.isArray(data?.commits) ? data.commits : [];
      setCommits(newCommits);
      setCommitHead(data?.head || null);
      setHasMore(newCommits.length >= maxCount);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch commits';
      setError(message);
      console.error('Failed to fetch commits:', err);
    } finally {
      setLoading(false);
    }
  }, [repoPath, branch, maxCount, enabled]);

  // Load more commits (append to existing list)
  const loadMore = useCallback(async () => {
    if (!enabled || loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        path: repoPath ?? '.',
        branch: branch,
        count: maxCount.toString(),
        skip: commits.length.toString(),
      });
      if (base) params.set('base', base);

      const response = await fetch(`/api/git/commits?${params}`);

      let data: { commits?: GitCommit[] | null; head?: string | null; error?: string } | null = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok) {
        throw new Error(data?.error || `Failed to load commits (HTTP ${response.status})`);
      }

      const newCommits = Array.isArray(data?.commits) ? data.commits : [];
      setCommits((prev) => [...prev, ...newCommits]);
      setHasMore(newCommits.length >= maxCount);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load commits';
      setError(message);
      console.error('Failed to load more commits:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [repoPath, branch, maxCount, enabled, loadingMore, hasMore, commits.length, base]);

  useEffect(() => {
    fetchCommits();
  }, [fetchCommits]);

  // Listen for refresh messages from toolbar
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'gitgraph-refresh') {
        fetchCommits();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [fetchCommits]);

  // Generate graph layout
  const graphLayout = commits.length > 0
    ? createGraphLayout(commits, finalConfig, finalMuteConfig, {
        commitHead,
        onlyFollowFirstParent: followFirstParent,
        expandedCommitIndex: expandedCommitIndex ?? -1,
      })
    : null;

  return {
    commits,
    loading: enabled && loading,
    loadingMore,
    error,
    hasMore,
    graphLayout,
    commitHead,
    refresh: fetchCommits,
    loadMore,
    expandedCommitIndex,
    setExpandedCommitIndex,
  };
}
