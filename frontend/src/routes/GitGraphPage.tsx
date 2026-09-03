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
import { useAtomValue } from 'jotai';
import { CommonTileContainer, useTileSessionState, useReportTileState } from '../components/CommonTileContainer';
import { GraphRenderer } from '../components/gitgraph/GraphRenderer';
import { useGitGraph } from '../components/gitgraph/useGitGraph';
import { RepoPicker } from '../components/gitgraph/RepoPicker';
import { RefreshIcon } from '../components/icons';
import { fileBrowserBgAtom } from '../store/appearance';
import { gitGraphZoomAtom } from '../store/zoom';
import { useHtmlZoom, tileZoomStyle } from '../components/ZoomControls';
import { getCredentials } from '../lib/auth';
import type { GitCommit } from '../components/gitgraph/graph';

interface GitGraphSessionState {
  repoPath?: string;
  branch?: string;
  scrollPosition?: number;
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

const intervals = [
  { label: 'Off', value: 0 },
  { label: '5s', value: 5000 },
  { label: '10s', value: 10000 },
  { label: '30s', value: 30000 },
  { label: '60s', value: 60000 },
];

function resolveInitPath(saved: GitGraphSessionState | null): string | null {
  const urlPath = new URLSearchParams(window.location.search).get('path');
  return saved?.repoPath ?? urlPath ?? null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const headers: Record<string, string> = {};
  const creds = getCredentials();
  if (creds) headers['Authorization'] = creds;
  const res = await fetch(url, { cache: 'no-store', headers });
  let data: (T & { error?: string }) | null = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data as T;
}

export default function GitGraphPage() {
  const savedState = useTileSessionState<GitGraphSessionState>();
  const reportState = useReportTileState();
  const bgColor = useAtomValue(fileBrowserBgAtom);
  const zoom = useAtomValue(gitGraphZoomAtom);
  useHtmlZoom(zoom);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.style.backgroundColor = 'transparent';
  }, []);

  const initPath = resolveInitPath(savedState);
  const [repoPath, setRepoPath] = useState<string | null>(initPath);
  const [branch] = useState(savedState?.branch ?? 'HEAD');
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(0);
  const [showDropdown, setShowDropdown] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
  const dropdownRef = useRef<HTMLDivElement>(null);
  const refreshBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setShowDropdown(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const { commits, loading, loadingMore, error, hasMore, commitHead, refresh, loadMore } = useGitGraph({ repoPath, branch, maxCount: 100, enabled: repoPath !== null });

  useEffect(() => { reportState({ repoPath: repoPath ?? undefined, branch }); }, [repoPath, branch, reportState]);

  useEffect(() => { if (autoRefresh <= 0) return; const id = setInterval(() => refresh(), autoRefresh); return () => clearInterval(id); }, [autoRefresh, refresh]);

  const handleIntervalSelect = useCallback((ms: number) => { setAutoRefresh(ms); setShowDropdown(false); }, []);

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

  const handleSelectPath = useCallback((path: string) => { setRepoPath(path); setPicking(false); setExpandedIndex(null); }, []);
  const handleRetry = useCallback(() => { setExpandedIndex(null); refresh(); }, [refresh]);

  const copyPath = useCallback(async () => {
    if (!repoPath) return;
    try { await navigator.clipboard.writeText(repoPath); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* noop */ }
  }, [repoPath]);

  const handleCommitClick = useCallback((_commit: GitCommit, index: number) => { setExpandedIndex((prev) => (prev === index ? null : index)); }, []);

  return (
    <CommonTileContainer>
      <div className="flex flex-col rounded-[6px] p-2 text-sm text-white/80" style={{ ...tileZoomStyle(zoom), backgroundColor: bgColor }}>

        {/* Row 1 — toolbar (file viewer style) */}
        <div className="flex h-8 shrink-0 items-center gap-1 rounded-t-lg border-b border-white/10 px-3 py-1.5 glass-control">
          <button type="button" onClick={refresh} className={`grid h-5 w-5 place-items-center rounded transition hover:bg-white/10 ${autoRefresh > 0 ? 'text-green-400' : 'text-white/50 hover:text-white/70'}`} title="Refresh"><RefreshIcon /></button>
          <button ref={refreshBtnRef} type="button" onClick={() => { if (showDropdown) { setShowDropdown(false); } else if (refreshBtnRef.current) { const r = refreshBtnRef.current.getBoundingClientRect(); setDropdownPos({ top: r.bottom + 2, left: r.left }); setShowDropdown(true); } }} className={`grid h-5 w-4 place-items-center rounded text-[10px] transition hover:bg-white/10 ${autoRefresh > 0 ? 'text-green-400' : 'text-white/40 hover:text-white/60'}`} title="Auto-refresh interval">▾</button>
          <span className="text-[11px] font-semibold tracking-wide text-white/60">Git Graph</span>
        </div>

        {/* Auto-refresh dropdown */}
        {showDropdown && (
          <div ref={dropdownRef} className="fixed z-[9999] w-28 rounded border border-white/10 bg-black/95 py-1 shadow-xl backdrop-blur-xl" style={dropdownPos}>
            {intervals.map((iv) => (
              <button key={iv.value} type="button" onClick={() => handleIntervalSelect(iv.value)} className={`flex w-full items-center px-3 py-1 text-left text-xs transition hover:bg-white/10 ${autoRefresh === iv.value ? 'text-green-400' : 'text-white/60'}`}>
                {iv.label}
                {autoRefresh === iv.value && iv.value > 0 && <span className="ml-auto text-[10px] text-green-400/60">●</span>}
              </button>
            ))}
          </div>
        )}

        {/* Row 2 — repo path bar */}
        <div className="flex shrink-0 items-center gap-2 border-b border-x border-white/[0.10] bg-white/[0.03] px-2.5 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
          {repoPath ? (
            <>
              <button type="button" onClick={copyPath} title="Copy repository path" className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-white/[0.04] px-2 py-1 text-left text-xs text-white/50 transition-all duration-150 hover:bg-white/[0.08] hover:text-white/70">
                <svg className="h-3 w-3 shrink-0 text-white/30" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg>
                <span className="truncate font-mono tracking-tight">{repoPath}</span>
                <span className="shrink-0 text-white/30">{copied ? <svg className="h-3 w-3 text-green-400" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg> : <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z"/></svg>}</span>
              </button>
              <span className="shrink-0 rounded-md bg-white/[0.04] px-2 py-1 text-xs text-white/50">{error ? '—' : `${commits.length} commits`}</span>
              <button type="button" onClick={() => setPicking(true)} title="Change repository folder" className="shrink-0 rounded-md bg-white/[0.06] px-2.5 py-1 text-xs text-white/70 transition-all duration-150 hover:bg-white/[0.12] hover:text-white active:scale-[0.97]">Change repo</button>
            </>
          ) : <span className="px-1 text-xs text-white/50">No repository selected</span>}
        </div>

        {/* Content */}
        {picking || repoPath === null ? (
          <div className="flex flex-1 overflow-hidden rounded-b-lg border-x border-b border-x-white/[0.10] border-b-white/[0.10] bg-black/20 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
            <RepoPicker error={repoPath !== null ? error : null} onSelect={handleSelectPath} />
          </div>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center rounded-b-lg border-x border-b border-white/[0.10] bg-black/20">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-b-lg border-x border-b border-white/[0.10] bg-black/20 p-6">
            <svg className="h-8 w-8 text-red-400" viewBox="0 0 16 16" fill="currentColor"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575L6.457 1.047zM8 5.5a.75.75 0 0 0-.75.75v3a.75.75 0 1 0 1.5 0v-3A.75.75 0 0 0 8 5.5zm0 6.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>
            <div className="max-w-sm text-center text-sm text-red-300">{error}</div>
            <div className="flex gap-2">
              <button type="button" onClick={handleRetry} className="rounded-md bg-white/10 px-3 py-1.5 text-xs text-white/80 transition hover:bg-white/20 hover:text-white">Retry</button>
              <button type="button" onClick={() => setPicking(true)} className="rounded-md bg-green-500/20 px-3 py-1.5 text-xs font-medium text-green-300 transition hover:bg-green-500/30">Choose another folder</button>
            </div>
          </div>
        ) : commits.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-b-lg border-x border-b border-white/[0.10] bg-black/20 p-6">
            <div className="max-w-sm text-center text-sm text-white/60">No commits found in this repository.</div>
            <button type="button" onClick={() => setPicking(true)} className="rounded-md bg-green-500/20 px-3 py-1.5 text-xs font-medium text-green-300 transition hover:bg-green-500/30">Choose another folder</button>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto rounded-b-lg border-x border-b border-x-white/[0.10] border-b-white/[0.10] bg-black/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]" onScroll={handleScroll} ref={scrollRef}>
            <div className="flex">
              <div className="sticky left-0 z-10 shrink-0" style={{ backgroundColor: bgColor }}>
                <GraphRenderer commits={commits} commitHead={commitHead} expandedCommitIndex={expandedIndex ?? -1} onCommitClick={handleCommitClick} />
              </div>
              <div className="min-w-0 flex-1">
                {commits.map((commit, index) => (
                  <div key={commit.hash} style={{ minHeight: ROW_HEIGHT }}>
                    <CommitRow commit={commit} isExpanded={expandedIndex === index} onClick={() => handleCommitClick(commit, index)} />
                    {expandedIndex === index && repoPath && <ExpandedCommitRow repoPath={repoPath} hash={commit.hash} height={DETAILS_HEIGHT} />}
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
    </CommonTileContainer>
  );
}

/* CommitRow — exactly ROW_HEIGHT tall to align with the graph grid */
function CommitRow({ commit, isExpanded, onClick }: { commit: GitCommit; isExpanded: boolean; onClick: () => void }) {
  const date = new Date(commit.date);
  return (
    <div className={`flex h-6 cursor-pointer items-center text-xs leading-none transition-colors ${isExpanded ? 'bg-white/10' : 'hover:bg-white/5'}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }} onClick={onClick}>
      <div className="w-20 shrink-0 pl-2 text-[11px] text-white/50">{date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
      <div className="min-w-0 flex-1 truncate text-white/90">{commit.message}</div>
      <div className="ml-2 flex shrink-0 items-center gap-1">
        {(commit.heads || []).map((h) => <span key={h} className="rounded-full bg-blue-500/20 px-1.5 py-[1px] text-[10px] text-blue-400">{h}</span>)}
        {(commit.tags || []).map((t) => <span key={t.name} className="rounded-full bg-yellow-500/20 px-1.5 py-[1px] text-[10px] text-yellow-400">{t.name}</span>)}
      </div>
      <div className="ml-2 w-14 shrink-0 pr-2 text-right font-mono text-[10px] text-white/40">{commit.hash.slice(0, 7)}</div>
    </div>
  );
}

/* ExpandedCommitRow — two-column layout: left = metadata, right = file changes */
function ExpandedCommitRow({ repoPath, hash, height }: { repoPath: string; hash: string; height: number }) {
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
    <div className="flex overflow-y-auto border-b border-white/[0.06] bg-white/[0.03]" style={{ height }} onClick={(e) => e.stopPropagation()}>
      {loading ? (
        <div className="flex w-full items-center justify-center"><div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/80" /></div>
      ) : loadError || !details ? (
        <div className="flex w-full items-center justify-center px-4 text-xs text-red-300">{loadError || 'Failed to load commit details'}</div>
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

            {/* Parents */}
            {(details.parents || []).length > 0 && (
              <div className="mt-1 border-t border-white/[0.06] pt-1">
                <span className="text-white/30">Parent:</span>
                <div className="mt-0.5 flex flex-col gap-0.5 pl-2">
                  {(details.parents || []).map((p) => <span key={p} className="font-mono text-[10px] text-white/50">{p.slice(0, 10)}</span>)}
                </div>
              </div>
            )}

            {/* Add/Del summary */}
            <div className="mt-auto flex gap-2 border-t border-white/[0.06] pt-1.5">
              <span className="font-mono text-green-400">+{details.fileChanges.reduce((s, f) => s + (f.adds || 0), 0)}</span>
              <span className="font-mono text-red-400">−{details.fileChanges.reduce((s, f) => s + (f.dels || 0), 0)}</span>
            </div>
          </div>

          {/* ── Right: file changes ───────────────────────────────── */}
          <div className="min-w-0 flex-1 overflow-y-auto px-2 py-2">
            {details.fileChanges.length === 0 ? (
              <div className="py-2 text-xs text-white/40">No file changes (empty or merge commit).</div>
            ) : details.fileChanges.map((f) => (
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
      <button type="button" onClick={onToggle} className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition hover:bg-white/[0.06] ${open ? 'bg-white/[0.06]' : ''}`}>
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
    <pre className="max-h-40 overflow-auto p-2 font-mono text-[10px] leading-[1.5]">
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
