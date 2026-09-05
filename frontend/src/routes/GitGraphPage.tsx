/**
 * GitGraphPage - Full-space git graph page for tiling.
 *
 * Layout:
 *   Row 1: toolbar (Git Graph label + refresh + auto-refresh) — glass material
 *   Row 2: repo path bar (click to copy) + commit counter + Change repo button
 *
 * Path resolution order: saved session state → ?path= URL param → folder picker.
 * On load error the user is told what happened and offered the picker again.
 * Clicking a commit expands the row in place (vscode-git-graph style) showing
 * a two-column view: left = commit metadata, right = file changes with inline diffs.
 * The graph layout stretches at the expanded commit via grid.expandY.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CommonTileContainer, useTileSessionState, useReportTileState } from '../components/CommonTileContainer';
import { useAtomValue } from 'jotai';
import { fileBrowserBgAtom } from '../store/appearance';
import { GraphRenderer } from '../components/gitgraph/GraphRenderer';
import { useGitGraph } from '../components/gitgraph/useGitGraph';
import { RepoPicker } from '../components/gitgraph/RepoPicker';
import { ContextMenu, type ContextMenuItem } from '../components/gitgraph/ContextMenu';
import { ActionDialog, type DialogInput } from '../components/gitgraph/ActionDialog';
import { useGitActions } from '../components/gitgraph/useGitActions';
import { RefreshIcon } from '../components/icons';
import { gitGraphZoomAtom } from '../store/zoom';
import { fetchJson } from '../lib/format';
import { setPageTransparent } from '../lib/constants';
import { useAutoRefreshDropdown, AutoRefreshDropdown, AutoRefreshTrigger } from '../components/AutoRefreshDropdown';
import type { GitCommit } from '../components/gitgraph/graph';

interface GitGraphSessionState {
  repoPath?: string;
  branch?: string;
  scrollPosition?: number;
  selectedWorktree?: string | null;
  allBranches?: boolean;
}

interface GitWorktree {
  path: string;
  head: string;
  branch: string;
  isMain: boolean;
  ahead: number;
  behind: number;
  lastActive: number; // unix millis
}

interface GitFileChange {
  oldPath: string;
  newPath: string;
  type: 'A' | 'M' | 'D' | 'R' | 'U';
  adds: number;
  dels: number;
}

interface GitCommitDetails {
  hash: string;
  parents: string[];
  author: string;
  date: number;
  committer: string;
  message: string;
  body: string;
  fileChanges: GitFileChange[];
}

const ROW_HEIGHT = 24;
const DETAILS_HEIGHT = 260;



function resolveInitPath(saved: GitGraphSessionState | null): string | null {
  const urlPath = new URLSearchParams(window.location.search).get('path');
  return saved?.repoPath ?? urlPath ?? null;
}



export default function GitGraphPage() {
  const savedState = useTileSessionState<GitGraphSessionState>();
  const reportState = useReportTileState();
  const bgColor = useAtomValue(fileBrowserBgAtom);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPageTransparent();
  }, []);

  const initPath = resolveInitPath(savedState);
  const [repoPath, setRepoPath] = useState<string | null>(initPath);
  const [branch] = useState(savedState?.branch ?? 'HEAD');
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [selectedWorktree, setSelectedWorktree] = useState<string | null>(savedState?.selectedWorktree ?? null);
  const [showWorktreeBrowser, setShowWorktreeBrowser] = useState(false);
  const [allBranches, setAllBranches] = useState(savedState?.allBranches ?? true);
  const [autoRefresh, setAutoRefresh] = useState(0);
  const dropdown = useAutoRefreshDropdown();

  // Determine the active worktree path and base for diff mode
  const activeWorktree = worktrees.find((wt) => wt.path === selectedWorktree);
  const activePath = activeWorktree?.path ?? repoPath ?? '.';
  const mainWorktree = worktrees.find((wt) => wt.isMain);
  const base = selectedWorktree !== null && mainWorktree ? mainWorktree.branch : undefined;

  const { commits, loading, loadingMore, error, hasMore, commitHead, refresh, loadMore } = useGitGraph({
    repoPath: activePath,
    branch,
    maxCount: 100,
    enabled: activePath !== null,
    base,
    allBranches,
  });

  // Fetch worktrees when repoPath changes
  const fetchWorktrees = useCallback(async () => {
    if (!repoPath) { setWorktrees([]); return; }
    try {
      const data = await fetchJson<{ worktrees: GitWorktree[] }>(`/api/git/worktrees?path=${encodeURIComponent(repoPath)}`);
      setWorktrees(data.worktrees ?? []);
    } catch {
      setWorktrees([]);
    }
  }, [repoPath]);

  useEffect(() => { fetchWorktrees(); }, [fetchWorktrees]);

  // Refresh both worktrees and commits
  const refreshAll = useCallback(() => {
    fetchWorktrees();
    refresh();
  }, [fetchWorktrees, refresh]);

  useEffect(() => { reportState({ repoPath: repoPath ?? undefined, branch, selectedWorktree, allBranches }); }, [repoPath, branch, selectedWorktree, allBranches, reportState]);

  useEffect(() => { if (autoRefresh <= 0) return; const id = setInterval(() => refreshAll(), autoRefresh); return () => clearInterval(id); }, [autoRefresh, refreshAll]);

  const handleIntervalSelect = useCallback((ms: number) => { setAutoRefresh(ms); dropdown.close(); }, [dropdown]);

  useEffect(() => { if (scrollRef.current && savedState?.scrollPosition) scrollRef.current.scrollTop = savedState.scrollPosition; }, [savedState?.scrollPosition]);

  // Scroll to bottom → load more commits
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    reportState({ repoPath: repoPath ?? undefined, branch, scrollPosition: el.scrollTop });
    // Trigger load more when within 120px of the bottom
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120 && hasMore && !loadingMore && !loading) {
      loadMore();
    }
  }, [repoPath, branch, reportState, hasMore, loadingMore, loading, loadMore]);

  const handleSelectPath = useCallback((path: string) => { setRepoPath(path); setPicking(false); setExpandedIndex(null); setSelectedWorktree(null); setShowWorktreeBrowser(false); }, []);
  const handleRetry = useCallback(() => { setExpandedIndex(null); refresh(); }, [refresh]);

  const copyPath = useCallback(async () => {
    if (!repoPath) return;
    try { await navigator.clipboard.writeText(repoPath); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* noop */ }
  }, [repoPath]);

  const { execute: gitAction } = useGitActions(repoPath ?? '.');
  const [contextMenu, setContextMenu] = useState<{ items: ContextMenuItem[][]; pos: { x: number; y: number } } | null>(null);
  const [dialog, setDialog] = useState<{ title: string; message: string; inputs?: DialogInput[]; actionLabel?: string; onAction: (v: Record<string, string | boolean>) => void } | null>(null);

  const showCommitContextMenu = useCallback((e: React.MouseEvent, commit: GitCommit) => {
    e.preventDefault();
    e.stopPropagation();
    const zoom = parseFloat(document.documentElement.style.zoom) || 1;

    // Special context menu for uncommitted changes
    if (commit.hash === 'UNCOMMITTED') {
      const items: ContextMenuItem[][] = [
        [
          { label: 'Stash Uncommitted...', onClick: () => setDialog({ title: 'Stash Changes', message: 'Stash all uncommitted changes?', inputs: [{ type: 'text', name: 'Message', defaultValue: '' }], actionLabel: 'Stash', onAction: (v) => { gitAction('stash', { message: String(v['Message']), includeUntracked: 'true' }); refresh(); } }) },
          { label: 'Reset All...', onClick: () => setDialog({ title: 'Reset Working Directory', message: 'Discard ALL uncommitted changes? This cannot be undone.', actionLabel: 'Reset', onAction: () => { gitAction('reset-hard', {}); refresh(); } }) },
          { label: 'Clean Untracked...', onClick: () => setDialog({ title: 'Clean Untracked', message: 'Remove all untracked files? This cannot be undone.', actionLabel: 'Clean', onAction: () => { gitAction('clean', {}); refresh(); } }) },
        ],
      ];
      setContextMenu({ items, pos: { x: e.clientX / zoom, y: e.clientY / zoom } });
      return;
    }

    // Normal commit context menu
    const items: ContextMenuItem[][] = [
      [
        { label: 'Checkout', onClick: () => { gitAction('checkout-commit', { hash: commit.hash }); refresh(); } },
        { label: 'Cherry Pick...', onClick: () => setDialog({ title: 'Cherry Pick', message: `Cherry pick <b>${commit.hash.slice(0, 7)}</b>?`, inputs: [{ type: 'checkbox', name: 'No Commit', checked: false }], actionLabel: 'Cherry Pick', onAction: (v) => { gitAction('cherry-pick', { hash: commit.hash, noCommit: String(v['No Commit']) }); refresh(); } }) },
        { label: 'Revert...', onClick: () => setDialog({ title: 'Revert', message: `Revert commit <b>${commit.hash.slice(0, 7)}</b>?`, actionLabel: 'Revert', onAction: () => { gitAction('revert', { hash: commit.hash }); refresh(); } }) },
      ],
      [
        { label: 'Create Branch...', onClick: () => setDialog({ title: 'Create Branch', message: `Create a new branch at <b>${commit.hash.slice(0, 7)}</b>:`, inputs: [{ type: 'text', name: 'Branch name', defaultValue: '' }], actionLabel: 'Create', onAction: (v) => { const name = String(v['Branch name']).trim(); if (name) { gitAction('create-branch', { name, startPoint: commit.hash }); refresh(); } } }) },
        { label: 'Add Tag...', onClick: () => setDialog({ title: 'Add Tag', message: `Add tag at <b>${commit.hash.slice(0, 7)}</b>:`, inputs: [{ type: 'text', name: 'Tag name', defaultValue: '' }, { type: 'text', name: 'Message', defaultValue: '' }], actionLabel: 'Create Tag', onAction: (v) => { const name = String(v['Tag name']).trim(); if (name) { gitAction('add-tag', { name, hash: commit.hash, message: String(v['Message']), annotated: 'true' }); refresh(); } } }) },
      ],
      [
        { label: 'Reset to Commit...', onClick: () => setDialog({ title: 'Reset', message: `Reset current branch to <b>${commit.hash.slice(0, 7)}</b>?`, inputs: [{ type: 'radio', name: 'Mode', options: [{ label: 'Soft — keep changes, reset head', value: 'soft' }, { label: 'Mixed — keep working tree, reset index', value: 'mixed' }, { label: 'Hard — discard all changes', value: 'hard' }], defaultValue: 'mixed' }], actionLabel: 'Reset', onAction: (v) => { gitAction('reset-to-commit', { hash: commit.hash, mode: String(v['Mode']) }); refresh(); } }) },
        { label: 'Merge...', onClick: () => setDialog({ title: 'Merge', message: `Merge <b>${commit.hash.slice(0, 7)}</b> into current branch?`, actionLabel: 'Merge', onAction: () => { gitAction('merge', { ref: commit.hash }); refresh(); } }) },
        { label: 'Rebase on Commit...', onClick: () => setDialog({ title: 'Rebase', message: `Rebase current branch onto <b>${commit.hash.slice(0, 7)}</b>?`, actionLabel: 'Rebase', onAction: () => { gitAction('rebase', { upstream: commit.hash }); refresh(); } }) },
      ],
      [
        { label: 'Copy Hash', onClick: () => navigator.clipboard.writeText(commit.hash) },
        { label: 'Copy Message', onClick: () => navigator.clipboard.writeText(commit.message) },
      ],
    ];
    setContextMenu({ items, pos: { x: e.clientX / zoom, y: e.clientY / zoom } });
  }, [gitAction, refresh]);

  const showBranchContextMenu = useCallback((e: React.MouseEvent, branchName: string) => {
    e.preventDefault();
    const zoom = parseFloat(document.documentElement.style.zoom) || 1;
    const isCurrent = branchName === commitHead;
    const items: ContextMenuItem[][] = [
      [
        { label: 'Checkout', disabled: isCurrent, onClick: () => { gitAction('checkout-branch', { branch: branchName }); refresh(); } },
        { label: 'Rename...', onClick: () => setDialog({ title: 'Rename Branch', message: `Rename <b>${branchName}</b> to:`, inputs: [{ type: 'text', name: 'New name', defaultValue: branchName }], actionLabel: 'Rename', onAction: (v) => { const name = String(v['New name']).trim(); if (name && name !== branchName) { gitAction('rename-branch', { oldName: branchName, newName: name }); refresh(); } } }) },
        { label: 'Delete...', disabled: isCurrent, onClick: () => setDialog({ title: 'Delete Branch', message: `Delete branch <b>${branchName}</b>?`, inputs: [{ type: 'checkbox', name: 'Force delete', checked: false }], actionLabel: 'Delete', onAction: (v) => { gitAction('delete-branch', { branch: branchName, force: String(v['Force delete']) }); refresh(); } }) },
      ],
      [
        { label: 'Merge...', onClick: () => setDialog({ title: 'Merge', message: `Merge <b>${branchName}</b> into current branch?`, actionLabel: 'Merge', onAction: () => { gitAction('merge', { ref: branchName }); refresh(); } }) },
        { label: 'Rebase on Branch...', onClick: () => setDialog({ title: 'Rebase', message: `Rebase current branch onto <b>${branchName}</b>?`, actionLabel: 'Rebase', onAction: () => { gitAction('rebase', { upstream: branchName }); refresh(); } }) },
        { label: 'Push...', onClick: () => setDialog({ title: 'Push Branch', message: `Push <b>${branchName}</b> to remote?`, inputs: [{ type: 'checkbox', name: 'Set Upstream', checked: true }, { type: 'radio', name: 'Mode', options: [{ label: 'Normal', value: 'normal' }, { label: 'Force With Lease', value: 'forceWithLease' }, { label: 'Force', value: 'force' }], defaultValue: 'normal' }], actionLabel: 'Push', onAction: (v) => { gitAction('push-branch', { branch: branchName, setUpstream: String(v['Set Upstream']), force: v['Mode'] === 'force' ? 'true' : 'false', forceWithLease: v['Mode'] === 'forceWithLease' ? 'true' : 'false' }); refresh(); } }) },
      ],
      [
        { label: 'Fetch', onClick: () => { gitAction('fetch', {}); refresh(); } },
      ],
      [
        { label: 'Copy Name', onClick: () => navigator.clipboard.writeText(branchName) },
      ],
    ];
    setContextMenu({ items, pos: { x: e.clientX / zoom, y: e.clientY / zoom } });
  }, [gitAction, refresh, commitHead]);

  const showTagContextMenu = useCallback((e: React.MouseEvent, tag: { name: string; annotated: boolean }) => {
    e.preventDefault();
    const zoom = parseFloat(document.documentElement.style.zoom) || 1;
    const items: ContextMenuItem[][] = [
      [
        { label: 'Delete...', onClick: () => setDialog({ title: 'Delete Tag', message: `Delete tag <b>${tag.name}</b>?`, actionLabel: 'Delete', onAction: () => { gitAction('delete-tag', { name: tag.name }); refresh(); } }) },
        { label: 'Push...', onClick: () => setDialog({ title: 'Push Tag', message: `Push tag <b>${tag.name}</b> to remote?`, actionLabel: 'Push', onAction: () => { gitAction('push-tag', { name: tag.name }); refresh(); } }) },
      ],
      [
        { label: 'Copy Name', onClick: () => navigator.clipboard.writeText(tag.name) },
      ],
    ];
    setContextMenu({ items, pos: { x: e.clientX / zoom, y: e.clientY / zoom } });
  }, [gitAction, refresh]);

  const showStashContextMenu = useCallback((e: React.MouseEvent, stash: { selector: string; baseHash: string }) => {
    e.preventDefault();
    const zoom = parseFloat(document.documentElement.style.zoom) || 1;
    const items: ContextMenuItem[][] = [
      [
        { label: 'Apply...', onClick: () => setDialog({ title: 'Apply Stash', message: `Apply stash <b>${stash.selector}</b>?`, inputs: [{ type: 'checkbox', name: 'Reinstate Index', checked: false }], actionLabel: 'Apply', onAction: (v) => { gitAction('stash-apply', { selector: stash.selector, reinstateIndex: String(v['Reinstate Index']) }); refresh(); } }) },
        { label: 'Pop...', onClick: () => setDialog({ title: 'Pop Stash', message: `Pop stash <b>${stash.selector}</b>?`, inputs: [{ type: 'checkbox', name: 'Reinstate Index', checked: false }], actionLabel: 'Pop', onAction: (v) => { gitAction('stash-pop', { selector: stash.selector, reinstateIndex: String(v['Reinstate Index']) }); refresh(); } }) },
        { label: 'Drop...', onClick: () => setDialog({ title: 'Drop Stash', message: `Drop stash <b>${stash.selector}</b>?`, actionLabel: 'Drop', onAction: () => { gitAction('stash-drop', { selector: stash.selector }); refresh(); } }) },
      ],
      [
        { label: 'Create Branch From...', onClick: () => setDialog({ title: 'Branch From Stash', message: `Create a branch from stash <b>${stash.selector}</b>:`, inputs: [{ type: 'text', name: 'Branch name', defaultValue: '' }], actionLabel: 'Create', onAction: (v) => { const name = String(v['Branch name']).trim(); if (name) { gitAction('branch-from-stash', { branch: name, selector: stash.selector }); refresh(); } } }) },
      ],
      [
        { label: 'Copy Selector', onClick: () => navigator.clipboard.writeText(stash.selector) },
        { label: 'Copy Hash', onClick: () => navigator.clipboard.writeText(stash.baseHash) },
      ],
    ];
    setContextMenu({ items, pos: { x: e.clientX / zoom, y: e.clientY / zoom } });
  }, [gitAction, refresh]);

  const handleCommitClick = useCallback((_commit: GitCommit, index: number) => { setExpandedIndex((prev) => (prev === index ? null : index)); }, []);

  // Keep a ref to the latest commits so async loops see updated data
  const commitsRef = useRef(commits)
  commitsRef.current = commits

  // Navigate to a parent commit: find in list, scroll to it, expand it.
  // If not loaded yet, call loadMore repeatedly until found.
  const handleParentClick = useCallback((parentHash: string) => {
    // Search loaded commits for the parent
    const idx = commitsRef.current.findIndex((c) => c.hash === parentHash)
    if (idx >= 0) {
      setExpandedIndex(idx)
      const row = scrollRef.current?.querySelector(`[data-commit-idx="${idx}"]`)
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    // Not found — load more via useGitGraph until found or exhausted
    const loadUntilFound = async () => {
      const maxAttempts = 20
      for (let i = 0; i < maxAttempts; i++) {
        const prevLen = commitsRef.current.length
        loadMore()
        // Wait for commits state to update (or timeout)
        await new Promise<void>((resolve) => {
          const start = Date.now()
          const check = () => {
            if (commitsRef.current.length > prevLen || Date.now() - start > 3000) resolve()
            else requestAnimationFrame(check)
          }
          requestAnimationFrame(check)
        })
        const idx = commitsRef.current.findIndex((c) => c.hash === parentHash)
        if (idx >= 0) {
          setExpandedIndex(idx)
          const row = scrollRef.current?.querySelector(`[data-commit-idx="${idx}"]`)
          row?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          return
        }
        // No more commits loaded — exhausted
        if (commitsRef.current.length === prevLen) break
      }
    }
    void loadUntilFound()
  }, [loadMore]);

  return (
    <CommonTileContainer zoomAtom={gitGraphZoomAtom} noPadding>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">

        {/* Row 1 — toolbar (file viewer style) */}
        <div className="flex h-8 shrink-0 items-center gap-1 rounded-t-[6px] border-b border-white/10 px-3 py-1.5 glass-control">
          <button type="button" onClick={refreshAll} className={`grid h-5 w-5 place-items-center rounded transition hover:bg-white/10 ${autoRefresh > 0 ? 'text-green-400' : 'text-white/50 hover:text-white/70'}`} title="Refresh"><RefreshIcon /></button>
          <AutoRefreshTrigger btnRef={dropdown.btnRef} isActive={autoRefresh > 0} onClick={dropdown.toggle} />
          <span className="text-[11px] font-semibold tracking-wide text-white/60">Git Graph</span>
        </div>

        {/* Auto-refresh dropdown */}
        {dropdown.showDropdown && (
          <AutoRefreshDropdown value={autoRefresh} onChange={handleIntervalSelect} dropdownRef={dropdown.dropdownRef} dropdownPos={dropdown.dropdownPos} />
        )}

        {/* Row 2 — repo path bar */}
        <div className="flex shrink-0 items-center gap-2 border-b border-x border-white/[0.10] bg-white/[0.03] px-2.5 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
          {repoPath ? (
            <>
              <button type="button" onClick={copyPath} title="Copy repository path" className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-white/[0.04] px-2 py-1 text-left text-white/50 transition-all duration-150 hover:bg-white/[0.08] hover:text-white/70">
                <svg className="h-3 w-3 shrink-0 text-white/30" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg>
                <span className="truncate font-mono tracking-tight">{activePath}</span>
                <span className="shrink-0 text-white/30">{copied ? <svg className="h-3 w-3 text-green-400" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg> : <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z"/></svg>}</span>
              </button>
              {/* All-branches toggle */}
              <button
                type="button"
                onClick={() => { setAllBranches((v) => !v); setExpandedIndex(null); }}
                disabled={selectedWorktree !== null}
                className={`shrink-0 flex items-center gap-1 rounded-md px-2 py-1 transition-all duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-30 ${
                  allBranches && selectedWorktree === null
                    ? 'bg-sky-500/20 text-sky-300'
                    : 'bg-white/[0.04] text-white/50 hover:bg-white/[0.08] hover:text-white/70'
                }`}
                title={selectedWorktree !== null ? 'All branches is not available in worktree diff mode' : allBranches ? 'Showing all branches — click to show current branch only' : 'Show all branches'}
              >
                <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>
                <span className="text-[10px]">All</span>
              </button>
              {/* Worktree selector — clickable to open worktree browser */}
              {worktrees.length > 1 && (
                <button
                  type="button"
                  onClick={() => setShowWorktreeBrowser((v) => !v)}
                  className={`shrink-0 flex items-center gap-1 rounded-md px-2 py-1 transition-all duration-150 active:scale-[0.97] ${
                    showWorktreeBrowser
                      ? 'bg-sky-500/20 text-sky-300'
                      : 'bg-white/[0.04] text-white/50 hover:bg-white/[0.08] hover:text-white/70'
                  }`}
                >
                  <span className="text-[10px] text-white/30">Worktree:</span>
                  <span>{selectedWorktree === null
                    ? (mainWorktree?.branch ?? 'main')
                    : (activeWorktree?.branch ?? '—')}
                  </span>
                  <svg className={`h-2.5 w-2.5 shrink-0 opacity-50 transition-transform ${showWorktreeBrowser ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 9 6 6 6-6"/></svg>
                </button>
              )}
              <span className="shrink-0 rounded-md bg-white/[0.04] px-2 py-1 text-white/50">{error ? '—' : `${commits.length} commits`}</span>
              <button type="button" onClick={() => setPicking(true)} title="Change repository folder" className="shrink-0 rounded-md bg-white/[0.06] px-2.5 py-1 text-white/70 transition-all duration-150 hover:bg-white/[0.12] hover:text-white active:scale-[0.97]">Change repo</button>
            </>
          ) : <span className="px-1 text-white/50">No repository selected</span>}
        </div>

        {/* Worktree browser */}
        {showWorktreeBrowser && worktrees.length > 1 && (
          <div className="flex flex-1 flex-col overflow-auto rounded-b-[6px] border-x border-b border-white/[0.10] bg-black/20 scrollbar-thin">
            <div className="flex shrink-0 items-center border-b border-white/[0.06] bg-white/[0.03] px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-white/35">
              <span className="flex-1 min-w-0">Worktree dir</span>
              <span className="w-32 shrink-0">Branch</span>
              <span className="w-24 shrink-0">Base</span>
              <span className="w-32 shrink-0">Last active</span>
              <span className="w-20 shrink-0 text-right">Commits</span>
            </div>
            {worktrees.map((wt) => (
              <button
                key={wt.path}
                type="button"
                onClick={() => {
                  setSelectedWorktree(wt.isMain ? null : wt.path);
                  setShowWorktreeBrowser(false);
                  setExpandedIndex(null);
                }}
                className={`flex w-full items-center px-3 py-2 text-left transition-colors ${
                  (wt.isMain && selectedWorktree === null) || (!wt.isMain && selectedWorktree === wt.path)
                    ? 'bg-sky-500/10 text-white'
                    : 'text-white/70 hover:bg-white/[0.05] hover:text-white/90'
                }`}
              >
                <div className="flex flex-1 min-w-0 items-center gap-1.5">
                  <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${wt.isMain ? 'bg-sky-400' : 'bg-white/30'}`} />
                  <span className="truncate font-mono text-[11px]">{wt.path}</span>
                </div>
                <span className="w-32 shrink-0 truncate text-white/60">{wt.branch || 'detached'}</span>
                <span className="w-24 shrink-0 text-white/40">{wt.isMain ? '—' : (mainWorktree?.branch ?? 'main')}</span>
                <span className="w-32 shrink-0 text-white/40">{wt.lastActive > 0 ? new Date(wt.lastActive).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</span>
                <div className="w-20 shrink-0 flex justify-end gap-2">
                  {wt.ahead > 0 && <span className="font-mono text-green-400">{wt.ahead} ↑</span>}
                  {wt.behind > 0 && <span className="font-mono text-red-400">{wt.behind} ↓</span>}
                  {wt.ahead === 0 && wt.behind === 0 && <span className="text-white/30">—</span>}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        {!showWorktreeBrowser && (picking || repoPath === null) ? (
          <div className="flex flex-1 flex-col overflow-y-auto scrollbar-thin rounded-b-[6px] border-x border-b border-x-white/[0.10] border-b-white/[0.10] bg-black/20 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]" style={{ maxHeight: `calc(${100 / (parseFloat(document.documentElement.style.zoom) || 1)}vh - 90px)` }}>
            <RepoPicker error={repoPath !== null ? error : null} onSelect={handleSelectPath} />
          </div>
        ) : !showWorktreeBrowser && loading ? (
          <div className="flex flex-1 items-center justify-center rounded-b-[6px] border-x border-b border-white/[0.10] bg-black/20">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          </div>
        ) : !showWorktreeBrowser && error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-b-[6px] border-x border-b border-white/[0.10] bg-black/20 p-6">
            <svg className="h-8 w-8 text-red-400" viewBox="0 0 16 16" fill="currentColor"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575L6.457 1.047zM8 5.5a.75.75 0 0 0-.75.75v3a.75.75 0 1 0 1.5 0v-3A.75.75 0 0 0 8 5.5zm0 6.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>
            <div className="max-w-sm text-center text-red-300">{error}</div>
            <div className="flex gap-2">
              <button type="button" onClick={handleRetry} className="rounded-md bg-white/10 px-3 py-1.5 text-white/80 transition hover:bg-white/20 hover:text-white">Retry</button>
              <button type="button" onClick={() => setPicking(true)} className="rounded-md bg-green-500/20 px-3 py-1.5 font-medium text-green-300 transition hover:bg-green-500/30">Choose another folder</button>
            </div>
          </div>
        ) : !showWorktreeBrowser && commits.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-b-[6px] border-x border-b border-white/[0.10] bg-black/20 p-6">
            <div className="max-w-sm text-center text-white/60">No commits found in this repository.</div>
            <button type="button" onClick={() => setPicking(true)} className="rounded-md bg-green-500/20 px-3 py-1.5 font-medium text-green-300 transition hover:bg-green-500/30">Choose another folder</button>
          </div>
        ) : !showWorktreeBrowser && (
          <div className="min-h-0 flex-1 overflow-auto rounded-b-[6px] border-x border-b border-x-white/[0.10] border-b-white/[0.10] bg-black/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] scrollbar-thin" onScroll={handleScroll} ref={scrollRef}>
            <div className="flex">
              <div className="sticky left-0 z-10 shrink-0" style={{ backgroundColor: bgColor }}>
                <GraphRenderer commits={commits} commitHead={commitHead} expandedCommitIndex={expandedIndex ?? -1} onCommitClick={handleCommitClick} />
              </div>
              <div className="min-w-0 flex-1">
                {commits.map((commit, index) => (
                  <div key={commit.hash} data-commit-idx={index} style={{ minHeight: ROW_HEIGHT }}>
                    <CommitRow commit={commit} isExpanded={expandedIndex === index} onClick={() => handleCommitClick(commit, index)} onContextMenu={showCommitContextMenu} onBranchContextMenu={showBranchContextMenu} onTagContextMenu={showTagContextMenu} onStashContextMenu={showStashContextMenu} />
                    {expandedIndex === index && repoPath && <ExpandedCommitRow repoPath={repoPath} hash={commit.hash} height={DETAILS_HEIGHT} onParentClick={handleParentClick} />}
                  </div>
                ))}
                {loadingMore && (
                  <div className="flex justify-center py-3">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
                  </div>
                )}
                {!loading && hasMore && commits.length > 0 && !loadingMore && (
                  <div className="py-3 text-center text-[10px] text-white/30">Scroll down to load more commits</div>
                )}
                {!loading && !hasMore && commits.length > 0 && (
                  <div className="py-3 text-center text-[10px] text-white/20">All commits loaded ({commits.length})</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && <ContextMenu items={contextMenu.items} position={contextMenu.pos} onClose={() => setContextMenu(null)} />}

      {/* Action dialog */}
      {dialog && (
        <ActionDialog
          title={dialog.title}
          message={dialog.message}
          inputs={dialog.inputs}
          actionLabel={dialog.actionLabel}
          onAction={(v) => { dialog.onAction(v); setDialog(null); }}
          onCancel={() => setDialog(null)}
        />
      )}
    </CommonTileContainer>
  );
}

/* CommitRow — exactly ROW_HEIGHT tall to align with the graph grid */
function CommitRow({ commit, isExpanded, onClick, onContextMenu, onBranchContextMenu, onTagContextMenu, onStashContextMenu }: { commit: GitCommit; isExpanded: boolean; onClick: () => void; onContextMenu: (e: React.MouseEvent, c: GitCommit) => void; onBranchContextMenu: (e: React.MouseEvent, branch: string) => void; onTagContextMenu: (e: React.MouseEvent, tag: { name: string; annotated: boolean }) => void; onStashContextMenu: (e: React.MouseEvent, stash: { selector: string; baseHash: string }) => void }) {
  const date = new Date(commit.date);
  const isUncommitted = commit.hash === 'UNCOMMITTED';
  return (
    <div className={`flex h-6 cursor-pointer items-center leading-none transition-colors ${isExpanded ? 'bg-white/10' : isUncommitted ? 'bg-orange-500/5 hover:bg-orange-500/10' : 'hover:bg-white/5'}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }} onClick={onClick} onContextMenu={(e) => onContextMenu(e, commit)}>
      {isUncommitted ? (
        <div className="w-20 shrink-0 pl-2 text-[11px] text-orange-400/70">now</div>
      ) : (
        <div className="w-20 shrink-0 pl-2 text-[11px] text-white/50">{date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
      )}
      <div className="min-w-0 flex-1 truncate text-white/90">{commit.message}</div>
      <div className="ml-2 flex shrink-0 items-center gap-1">
        {(commit.heads || []).map((h) => <span key={h} onContextMenu={(e) => { e.stopPropagation(); onBranchContextMenu(e, h); }} className="cursor-pointer rounded-full bg-blue-500/20 px-1.5 py-[1px] text-[10px] text-blue-400 hover:bg-blue-500/30">{h}</span>)}
        {(commit.tags || []).map((t) => <span key={t.name} onContextMenu={(e) => { e.stopPropagation(); onTagContextMenu(e, t); }} className="cursor-pointer rounded-full bg-yellow-500/20 px-1.5 py-[1px] text-[10px] text-yellow-400 hover:bg-yellow-500/30">{t.name}</span>)}
        {commit.stash && <span onContextMenu={(e) => { e.stopPropagation(); onStashContextMenu(e, commit.stash!); }} className="cursor-pointer rounded-full bg-purple-500/20 px-1.5 py-[1px] text-[10px] text-purple-400 hover:bg-purple-500/30">{commit.stash.selector}</span>}
      </div>
      <div className="ml-2 w-24 shrink-0 truncate text-white/40">{commit.author}</div>
      <div className="ml-2 w-14 shrink-0 pr-2 text-right font-mono text-[10px] text-white/40">{commit.hash.slice(0, 7)}</div>
    </div>
  );
}

/* ExpandedCommitRow — two-column layout: left = metadata, right = file changes */
function ExpandedCommitRow({ repoPath, hash, height, onParentClick }: { repoPath: string; hash: string; height: number; onParentClick?: (parentHash: string) => void }) {
  const [details, setDetails] = useState<GitCommitDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const [hashCopied, setHashCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError(null); setDetails(null); setOpenDiff(null);
    fetchJson<GitCommitDetails>(`/api/git/commit?path=${encodeURIComponent(repoPath)}&hash=${encodeURIComponent(hash)}`)
      .then((d) => { if (!cancelled) setDetails(d); })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repoPath, hash]);

  const copyHash = useCallback((e: React.MouseEvent) => { e.stopPropagation(); navigator.clipboard.writeText(hash); setHashCopied(true); setTimeout(() => setHashCopied(false), 1200); }, [hash]);

  return (
    <div className="flex overflow-y-auto scrollbar-thin border-b border-white/[0.06] bg-white/[0.03]" style={{ height }} onClick={(e) => e.stopPropagation()}>
      {loading ? (
        <div className="flex w-full items-center justify-center"><div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/80" /></div>
      ) : loadError || !details ? (
        <div className="flex w-full items-center justify-center px-4 text-red-300">{loadError || 'Failed to load commit details'}</div>
      ) : (
        <>
          {/* ── Left: commit metadata ──────────────────────────────── */}
          <div className="flex w-52 shrink-0 flex-col gap-1 border-r border-white/[0.06] px-3 py-2.5 text-[11px] leading-relaxed">
            {/* Hash + copy */}
            <button type="button" onClick={copyHash} className="group flex items-center gap-1.5 rounded px-1.5 py-0.5 -mx-1.5 text-left transition-colors hover:bg-white/[0.06]" title="Copy full commit hash">
              <svg className="h-3 w-3 shrink-0 text-white/30 transition-colors group-hover:text-white/60" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z"/></svg>
              <span className="font-mono tracking-tight text-white/80">{details.hash.slice(0, 12)}</span>
              <span className="shrink-0 text-[10px] text-white/20">{hashCopied ? <span className="text-green-400">copied!</span> : 'copy'}</span>
            </button>

            {/* Author */}
            <div className="flex gap-1.5">
              <span className="shrink-0 text-white/30">Author:</span>
              <span className="text-white/80">{details.author}</span>
            </div>

            {/* Date */}
            <div className="flex gap-1.5">
              <span className="shrink-0 text-white/30">Date:</span>
              <span className="text-white/80">{new Date(details.date).toLocaleString()}</span>
            </div>

            {/* Message */}
            <div className="mt-1 border-t border-white/[0.06] pt-1">
              <span className="text-white/30">Message:</span>
              <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-relaxed text-white/80">{details.message}</p>
              {details.body && details.body !== details.message && (
                <p className="mt-1 whitespace-pre-wrap text-[10px] leading-relaxed text-white/50">{details.body}</p>
              )}
            </div>

            {/* Parents */}
            {(details.parents || []).length > 0 && (
              <div className="mt-1 border-t border-white/[0.06] pt-1">
                <span className="text-white/30">Parent:</span>
                <div className="mt-0.5 flex flex-col gap-0.5 pl-2">
                  {(details.parents || []).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onParentClick?.(p) }}
                      className="font-mono text-[10px] text-left text-sky-400/70 transition-colors hover:text-sky-300 hover:underline"
                    >
                      {p.slice(0, 10)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Add/Del summary */}
            <div className="mt-auto flex gap-2 border-t border-white/[0.06] pt-1.5">
              <span className="font-mono text-green-400">+{(details.fileChanges ?? []).reduce((s, f) => s + (f.adds || 0), 0)}</span>
              <span className="font-mono text-red-400">−{(details.fileChanges ?? []).reduce((s, f) => s + (f.dels || 0), 0)}</span>
            </div>
          </div>

          {/* ── Right: file changes ───────────────────────────────── */}
          <div className="min-w-0 flex-1 overflow-y-auto scrollbar-thin px-2 py-2">
            {(details.fileChanges ?? []).length === 0 ? (
              <div className="py-2 text-white/40">No file changes (empty or merge commit).</div>
            ) : (details.fileChanges ?? []).map((f) => (
              <FileChangeItem key={f.newPath + f.oldPath} change={f} repoPath={repoPath} hash={hash} open={openDiff === f.newPath} onToggle={() => setOpenDiff(openDiff === f.newPath ? null : f.newPath)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* FileChangeItem — badge + path + add/del counts, click to show inline diff */
const CHANGE_STYLES: Record<string, string> = { A: 'bg-green-500/20 text-green-400', M: 'bg-yellow-500/20 text-yellow-400', D: 'bg-red-500/20 text-red-400', R: 'bg-violet-500/20 text-violet-400', U: 'bg-cyan-500/20 text-cyan-400' };

function FileChangeItem({ change, repoPath, hash, open, onToggle }: { change: GitFileChange; repoPath: string; hash: string; open: boolean; onToggle: () => void }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false; setDiffLoading(true); setDiffError(null);
    const p = new URLSearchParams({ path: repoPath, hash, newPath: change.newPath, oldPath: change.oldPath });
    fetchJson<{ diff: string }>(`/api/git/diff?${p}`)
      .then((d) => { if (!cancelled) setDiff(d.diff); })
      .catch((err) => { if (!cancelled) setDiffError(err instanceof Error ? err.message : 'Failed'); })
      .finally(() => { if (!cancelled) setDiffLoading(false); });
    return () => { cancelled = true; };
  }, [open, repoPath, hash, change.newPath, change.oldPath]);

  return (
    <div className="mb-1">
      <button type="button" onClick={onToggle} className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left transition hover:bg-white/[0.06] ${open ? 'bg-white/[0.06]' : ''}`}>
        <span className={`w-4 shrink-0 rounded text-center font-mono text-[10px] font-bold ${CHANGE_STYLES[change.type] ?? CHANGE_STYLES.M}`}>{change.type}</span>
        <span className="min-w-0 flex-1 truncate font-mono tracking-tight text-white/75 hover:text-white">
          {change.newPath}
          {change.type === 'R' && change.oldPath !== change.newPath && <span className="text-white/35"> ← {change.oldPath}</span>}
        </span>
        {(change.adds || change.dels) ? <span className="shrink-0 font-mono text-[10px]"><span className="text-green-400">+{change.adds}</span> <span className="text-red-400">−{change.dels}</span></span> : null}
        <svg className={`h-3 w-3 shrink-0 text-white/30 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} viewBox="0 0 16 16" fill="currentColor"><path d="M6.22 3.72a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z"/></svg>
      </button>
      {open && (
        <div className="ml-6 mt-0.5 overflow-hidden rounded border border-white/[0.08] bg-black/40">
          {diffLoading ? <div className="flex items-center justify-center p-3"><div className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/80" /></div>
            : diffError ? <div className="p-2.5 text-[11px] text-red-300">{diffError}</div>
            : diff ? <DiffView diff={diff} />
            : <div className="p-2.5 text-[11px] text-white/40">No diff available.</div>}
        </div>
      )}
    </div>
  );
}

/* DiffView — monospace unified diff with +/- coloring */
function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="max-h-40 overflow-auto scrollbar-thin p-2 font-mono text-[10px] leading-[1.5]">
      {diff.split('\n').map((line, i) => {
        let cls = 'text-white/50';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'bg-green-500/10 text-green-300';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'bg-red-500/10 text-red-300';
        else if (line.startsWith('@@')) cls = 'bg-blue-500/10 text-blue-300';
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'text-white/30';
        return <div key={i} className={`${cls} whitespace-pre`}>{line || ' '}</div>;
      })}
    </pre>
  );
}
