import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WORKTREE_REF, type ComparisonFile, type DiffTab, type FilePatch } from './comparison';
import { useGitComparison } from './useGitComparison';
import { SplitDiffView } from './SplitDiffView';

function DiffFileSection({
  file,
  active,
  focused,
  loadPatch,
  scrollRoot,
}: {
  file: ComparisonFile;
  active: boolean;
  focused: number;
  loadPatch: (id: string, signal: AbortSignal) => Promise<FilePatch>;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(true);
  const [near, setNear] = useState(false);
  const [patch, setPatch] = useState<FilePatch | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  // Wait for the section to approach the viewport, then keep its patch while
  // the section stays visible. Plain overflow scrolling keeps wheel support.
  useEffect(() => {
    if (!active || !scrollRoot.current) return;
    const section = scrollRoot.current.querySelector(`[data-file-id="${file.id}"]`);
    if (!section) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: scrollRoot.current,
      rootMargin: '400px',
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, [active, file.id, scrollRoot]);
  useEffect(() => {
    if (!focused || !active) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: 'start' });
  }, [focused, active]);
  useEffect(() => {
    if (!active || !near || !open || file.binary) {
      setPatch(null);
      return;
    }
    const controller = new AbortController();
    setError('');
    loadPatch(file.id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPatch(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(String(err.message));
      });
    return () => controller.abort();
  }, [active, near, open, file.id, file.binary, loadPatch, attempt]);
  const tooLarge =
    patch && (patch.limited || patch.hunks.reduce((n, hunk) => n + hunk.lines.length, 0) > 12_000);
  return (
    <section
      ref={ref}
      data-file-id={file.id}
      className="mb-3 overflow-hidden rounded-md border border-white/10"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="sticky top-0 z-20 flex w-full items-center gap-2 border-b border-white/10 px-3 py-2 text-left glass-control"
      >
        <span className="text-xs text-white/50">{open ? '▾' : '▸'}</span>
        <span className="text-xs text-sky-300">{file.status}</span>
        <span className="min-w-0 flex-1 break-all font-mono text-sm">
          {file.newPath}
          {file.oldPath !== file.newPath && (
            <span className="text-white/40"> ← {file.oldPath}</span>
          )}
        </span>
        {!file.binary && (
          <span className="shrink-0 font-mono text-[10px]">
            <span className="text-green-300">+{file.adds}</span>{' '}
            <span className="text-red-300">−{file.dels}</span>
          </span>
        )}
      </button>
      {open && (
        <div>
          {file.oldMode !== file.newMode && (
            <p className="px-3 py-1 text-[11px] text-white/50">
              {t('gitCompare.mode')}: {file.oldMode} → {file.newMode}
            </p>
          )}
          {file.submodule && (
            <p className="px-3 py-1 text-[11px] text-sky-200">{t('gitCompare.submodule')}</p>
          )}
          {file.binary ? (
            <p className="p-4 text-[11px] text-white/50">{t('gitCompare.binary')}</p>
          ) : error ? (
            <div role="alert" className="p-4 text-[11px] text-red-300">
              {error}{' '}
              <button
                type="button"
                className="ml-2 rounded bg-white/10 px-2 py-1 text-xs"
                onClick={() => setAttempt((n) => n + 1)}
              >
                {t('gitCompare.retry')}
              </button>
            </div>
          ) : tooLarge ? (
            <p className="p-4 text-[11px] text-white/50">{t('gitCompare.tooLarge')}</p>
          ) : patch?.hunks.length ? (
            <SplitDiffView hunks={patch.hunks} />
          ) : patch ? (
            <p className="p-4 text-[11px] text-white/50">{t('gitCompare.metadataOnly')}</p>
          ) : (
            <p role="status" className="min-h-24 p-4 text-[11px] text-white/40">
              {t('gitCompare.loading')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  file?: ComparisonFile;
}

function buildTree(files: ComparisonFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.newPath.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let child = node.children.find((candidate) => !candidate.file && candidate.name === parts[i]);
      if (!child) {
        child = { name: parts[i], path, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({ name: parts[parts.length - 1], path: file.newPath, children: [], file });
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort((a, b) => (a.file === b.file ? a.name.localeCompare(b.name) : a.file ? 1 : -1))
      .map((node) => ({ ...node, children: sort(node.children) }));
  return sort(root.children);
}

function FileTree({
  nodes,
  depth = 0,
  filter,
  activeId,
  onSelect,
}: {
  nodes: TreeNode[];
  depth?: number;
  filter: string;
  activeId: string;
  onSelect: (file: ComparisonFile) => void;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const searching = filter.trim().length > 0;
  const toggle = (path: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <>
      {nodes.map((node) =>
        node.file ? (
          <button
            key={node.path}
            type="button"
            style={{ paddingLeft: 12 + depth * 12 }}
            onClick={() => {
              if (node.file) onSelect(node.file);
            }}
            className={`flex w-full items-center gap-2 py-1.5 pr-3 text-left text-sm hover:bg-white/5 ${activeId === node.file.id ? 'bg-sky-500/10' : ''}`}
          >
            <span className="w-4 shrink-0 text-xs text-sky-300">{node.file.status}</span>
            <span className="truncate" title={node.file.newPath}>
              {node.name}
            </span>
          </button>
        ) : (
          <div key={node.path}>
            <button
              type="button"
              style={{ paddingLeft: 12 + depth * 12 }}
              onClick={() => toggle(node.path)}
              aria-expanded={searching || !collapsed.has(node.path)}
              className="flex w-full items-center gap-1 py-1.5 pr-3 text-left text-sm text-white/70 hover:bg-white/5"
            >
              <span className="w-4 shrink-0 text-center text-[10px] text-white/40">
                {searching || !collapsed.has(node.path) ? '▾' : '▸'}
              </span>
              <span className="truncate font-medium">{node.name}/</span>
            </button>
            {(searching || !collapsed.has(node.path)) && (
              <FileTree
                nodes={node.children}
                depth={depth + 1}
                filter={filter}
                activeId={activeId}
                onSelect={onSelect}
              />
            )}
          </div>
        ),
      )}
      {!nodes.length && (
        <p className="p-3 text-[11px] text-white/40">{t('gitCompare.noMatches')}</p>
      )}
    </>
  );
}

export function CommitDiffTab({
  tab,
  active,
  onSwap,
  onParent,
}: {
  tab: DiffTab;
  active: boolean;
  onSwap: () => void;
  onParent: (base: string) => void;
}) {
  const { t } = useTranslation();
  const { data, error, retry, loadPatch } = useGitComparison(tab, active);
  const [sidebar, setSidebar] = useState(true);
  const [filter, setFilter] = useState('');
  const [focus, setFocus] = useState({ id: '', version: 0 });
  const scrollRoot = useRef<HTMLDivElement>(null);
  const refLabel = (ref: string) =>
    ref === 'EMPTY'
      ? t('gitCompare.emptyTree')
      : ref === WORKTREE_REF
        ? t('gitCompare.worktree')
        : ref.slice(0, 7);
  const filteredFiles = useMemo(
    () =>
      data?.files.filter((f) =>
        `${f.oldPath} ${f.newPath}`.toLowerCase().includes(filter.toLowerCase()),
      ) ?? [],
    [data, filter],
  );
  const fileTree = useMemo(() => buildTree(filteredFiles), [filteredFiles]);
  useEffect(() => {
    if (!data || !tab.focusFile) return;
    const file = data.files.find((f) => f.newPath === tab.focusFile || f.oldPath === tab.focusFile);
    if (file) setFocus((prev) => ({ id: file.id, version: prev.version + 1 }));
  }, [data, tab.focusFile]);
  return (
    <div className="@container flex min-h-0 flex-1 flex-col overflow-hidden bg-black/20">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2 text-xs">
        <button
          type="button"
          className="rounded bg-white/5 px-2 py-1 hover:bg-white/10"
          aria-expanded={sidebar}
          onClick={() => setSidebar((v) => !v)}
        >
          {t('gitCompare.files')}
        </button>
        <span className="font-mono" title={tab.base}>
          {refLabel(tab.base)}
        </span>
        <span>→</span>
        <span className="font-mono" title={tab.target}>
          {refLabel(tab.target)}
        </span>
        {tab.base !== 'EMPTY' && tab.target !== WORKTREE_REF && (
          <button
            type="button"
            className="rounded bg-white/5 px-2 py-1 hover:bg-white/10"
            onClick={onSwap}
          >
            {t('gitCompare.swap')}
          </button>
        )}
        {data && data.parents.length > 1 && (
          <label className="flex items-center gap-1">
            {t('gitCompare.parent')}
            <select
              aria-label={t('gitCompare.parent')}
              value={data.parents.includes(tab.base) ? tab.base : ''}
              onChange={(e) => onParent(e.target.value)}
              className="max-w-32 rounded bg-slate-900 p-1 text-xs"
            >
              {!data.parents.includes(tab.base) && (
                <option value="" disabled>
                  {t('gitCompare.custom')}
                </option>
              )}
              {data.parents.map((hash, i) => (
                <option key={hash} value={hash}>
                  {i + 1}: {hash.slice(0, 7)}
                </option>
              ))}
            </select>
          </label>
        )}
        {data && (
          <span className="text-[10px] text-white/50">
            {t('gitCompare.fileCount', { count: data.files.length })}{' '}
            <span className="text-green-300">+{data.adds}</span>{' '}
            <span className="text-red-300">−{data.dels}</span>
          </span>
        )}
      </div>
      <p className="shrink-0 truncate px-3 py-1 text-[11px] text-white/35" title={tab.repoPath}>
        {tab.repoPath} · {t('gitCompare.excluded')}
      </p>
      {error ? (
        <div role="alert" className="p-4 text-[11px] text-red-300">
          {error}{' '}
          <button
            type="button"
            onClick={retry}
            className="ml-2 rounded bg-white/10 px-2 py-1 text-xs"
          >
            {t('gitCompare.retry')}
          </button>
        </div>
      ) : !data ? (
        <p role="status" className="p-4 text-[11px] text-white/50">
          {t('gitCompare.loading')}
        </p>
      ) : !data.files.length ? (
        <p className="p-6 text-sm text-white/60">{t('gitCompare.noChanges')}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col @[700px]:flex-row">
          {sidebar && (
            <aside className="flex max-h-40 shrink-0 flex-col border-b border-white/10 @[700px]:max-h-none @[700px]:w-52 @[700px]:border-b-0 @[700px]:border-r">
              <input
                aria-label={t('gitCompare.filterFiles')}
                placeholder={t('gitCompare.filterFiles')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="m-2 min-w-0 rounded border border-white/10 bg-black/20 px-2 py-1 text-sm outline-none focus:border-sky-400"
              />
              <nav
                aria-label={t('gitCompare.files')}
                className="min-h-0 flex-1 overflow-auto scrollbar-thin"
              >
                <FileTree
                  nodes={fileTree}
                  filter={filter}
                  activeId={focus.id}
                  onSelect={(file) =>
                    setFocus((previous) => ({ id: file.id, version: previous.version + 1 }))
                  }
                />
              </nav>
            </aside>
          )}
          <div
            ref={scrollRoot}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3 scrollbar-thin"
          >
            {data.files.map((file) => (
              <DiffFileSection
                key={file.id}
                file={file}
                active={active}
                focused={focus.id === file.id ? focus.version : 0}
                scrollRoot={scrollRoot}
                loadPatch={loadPatch}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
