import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { getCredentials } from '../lib/auth'
import { fileBrowserBgAtom } from '../store/appearance'
import { CommonTileContainer } from '../components/CommonTileContainer'
import { ContextMenu } from '../components/filebrowser/ContextMenu'
import { Toast } from '../components/filebrowser/Toast'
import { UploadDialog } from '../components/filebrowser/UploadDialog'

interface FileEntry {
  name: string
  isDir: boolean
  size: number
  modTime: string
}

interface FileListResponse {
  path: string
  entries: FileEntry[]
}

function formatSize(bytes: number): string {
  if (bytes === 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${i === 0 ? size : size.toFixed(1)} ${units[i]}`
}

function formatDate(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const day = 86400000
  if (diff < day) return t('filebrowser.today')
  if (diff < day * 2) return t('filebrowser.yesterday')
  if (diff < day * 7) return t('filebrowser.daysAgo', { count: Math.floor(diff / day) })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
}

// ── Icons ──

function FolderIcon({ className = 'text-sky-400' }: { className?: string }) {
  return (
    <svg className={`h-4 w-4 shrink-0 ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function FolderOpenIcon() {
  return (
    <svg className="h-4 w-4 shrink-0 text-sky-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg className="h-4 w-4 shrink-0 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

function TreeChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`h-3 w-3 shrink-0 text-white/40 transition-transform ${expanded ? 'rotate-90' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

function HomeIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

function ForwardIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

// ── API helper ──

async function fetchFiles(dirPath: string, signal?: AbortSignal): Promise<FileListResponse> {
  const headers: Record<string, string> = {}
  const creds = getCredentials()
  if (creds) headers['Authorization'] = creds
  const res = await fetch(`/api/files?path=${encodeURIComponent(dirPath)}`, {
    cache: 'no-store',
    headers,
    signal,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `HTTP ${res.status}`)
  }
  return res.json()
}

// ── Tree types ──

type SortKey = 'name' | 'size' | 'modTime'
type SortDir = 'asc' | 'desc'

interface TreeNode {
  path: string
  name: string
  expanded: boolean
  children: TreeNode[] | null // null = not loaded yet
}

// ── Tree view ──

function TreeView({
  currentPath,
  onNavigate,
}: {
  currentPath: string
  onNavigate: (path: string) => void
}) {
  const { t } = useTranslation()
  const [rootChildren, setRootChildren] = useState<TreeNode[] | null>(null)
  const [loading, setLoading] = useState(true)
  // Track nodes the user has manually collapsed so auto-expand doesn't re-open them.
  const collapsedRef = useRef(new Set<string>())
  // Track the last path we auto-expanded to, so we don't re-run.
  const lastExpandedPath = useRef('')

  // Load root directories on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await fetchFiles('/')
        if (cancelled) return
        const dirs = data.entries
          .filter((e) => e.isDir)
          .map((e): TreeNode => ({
            path: data.path === '/' ? `/${e.name}` : `${data.path}/${e.name}`,
            name: e.name,
            expanded: false,
            children: null,
          }))
        setRootChildren(dirs)
      } catch {
        // silent
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Auto-expand ancestors of currentPath (re-runs when tree data loads)
  useEffect(() => {
    if (!rootChildren) return
    if (currentPath === lastExpandedPath.current) return

    const parts = currentPath.split('/').filter(Boolean)
    let nodes = rootChildren
    let changed = false
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]
      const node = nodes.find((n) => n.name === seg)
      if (!node) break
      if (!node.expanded && !collapsedRef.current.has(node.path)) {
        node.expanded = true
        changed = true
      }
      if (node.children === null) {
        // Load children async, then re-trigger this effect via setRootChildren.
        ;(async () => {
          try {
            const data = await fetchFiles(node.path)
            node.children = data.entries
              .filter((e) => e.isDir)
              .map((e): TreeNode => ({
                path: data.path === '/' ? `/${e.name}` : `${data.path}/${e.name}`,
                name: e.name,
                expanded: false,
                children: null,
              }))
          } catch {
            node.children = []
          }
          // Trigger re-render so this effect re-runs for the next segment.
          setRootChildren((prev) => prev ? [...prev] : prev)
        })()
        // Don't set lastExpandedPath yet — we're still expanding.
        return
      }
      nodes = node.children
    }
    // All segments expanded — mark done.
    lastExpandedPath.current = currentPath
    if (changed) {
      setRootChildren([...rootChildren])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, rootChildren])

  const toggleNode = useCallback(async (node: TreeNode) => {
    node.expanded = !node.expanded
    if (!node.expanded) {
      collapsedRef.current.add(node.path)
    } else {
      collapsedRef.current.delete(node.path)
    }
    if (node.expanded && node.children === null) {
      try {
        const data = await fetchFiles(node.path)
        node.children = data.entries
          .filter((e) => e.isDir)
          .map((e): TreeNode => ({
            path: data.path === '/' ? `/${e.name}` : `${data.path}/${e.name}`,
            name: e.name,
            expanded: false,
            children: null,
          }))
      } catch {
        node.children = []
      }
    }
    setRootChildren((prev) => prev ? [...prev] : prev)
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-[11px] text-white/30">
        {t('filebrowser.loading')}
      </div>
    )
  }

  return (
    <nav className="select-none overflow-y-auto py-1" aria-label="Directory tree">
      {/* Root "/" node */}
      <button
        type="button"
        onClick={() => onNavigate('/')}
        className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[13px] transition-colors hover:bg-white/5 ${
          currentPath === '/' ? 'bg-white/10 text-white' : 'text-white/70'
        }`}
      >
        <HomeIcon />
        <span className="truncate">/</span>
      </button>
      {rootChildren?.map((node) => (
        <TreeNodeItem
          key={node.path}
          node={node}
          depth={1}
          currentPath={currentPath}
          onNavigate={onNavigate}
          onToggle={toggleNode}
        />
      ))}
    </nav>
  )
}

function TreeNodeItem({
  node,
  depth,
  currentPath,
  onNavigate,
  onToggle,
}: {
  node: TreeNode
  depth: number
  currentPath: string
  onNavigate: (path: string) => void
  onToggle: (node: TreeNode) => void
}) {
  const isActive = currentPath === node.path
  const hasChildren = node.children === null || node.children.length > 0
  const btnRef = useRef<HTMLButtonElement>(null)

  // Scroll the active node to the middle of the tree view, but only if it's out of view.
  useEffect(() => {
    if (!isActive || !btnRef.current) return
    const el = btnRef.current
    // Walk up: button → div → ... → nav → scrollable parent div
    const nav = el.closest('nav')
    const parent = nav?.parentElement as HTMLElement | null
    if (!parent) return

    const elRect = el.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()

    // Already fully visible — no scroll needed.
    if (elRect.top >= parentRect.top && elRect.bottom <= parentRect.bottom) return

    // Element's position relative to the scroll container's content.
    const elOffsetInContent = elRect.top - parentRect.top + parent.scrollTop
    // Center it in the viewport.
    const target = elOffsetInContent - parent.clientHeight / 2 + el.offsetHeight / 2
    parent.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  }, [isActive])

  return (
    <div>
      <button
        ref={btnRef}
        type="button"
        onClick={() => onNavigate(node.path)}
        className={`flex w-full items-center gap-1 py-1 text-left text-[13px] transition-colors hover:bg-white/5 ${
          isActive ? 'bg-white/10 text-white' : 'text-white/70'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {hasChildren ? (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              onToggle(node)
            }}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-white/10"
          >
            <TreeChevron expanded={node.expanded} />
          </span>
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}
        {node.expanded ? <FolderOpenIcon /> : <FolderIcon className={isActive ? 'text-sky-300' : 'text-sky-400/70'} />}
        <span className="truncate">{node.name}</span>
      </button>
      {node.expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              currentPath={currentPath}
              onNavigate={onNavigate}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main file browser ──

export default function FileBrowserPage() {
  const { t } = useTranslation()
  const bgColor = useAtomValue(fileBrowserBgAtom)
  const [currentPath, setCurrentPath] = useState('/')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [history, setHistory] = useState<string[]>(['/'])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [treeRefreshKey, setTreeRefreshKey] = useState(0)
  const [copied, setCopied] = useState(false)
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null)
  const [showUpload, setShowUpload] = useState(false)

  // Read initial path from URL once (before any effects).
  const initPath = new URLSearchParams(window.location.search).get('path')

  // Override the opaque :root background so the translucent bgColor shows through.
  useEffect(() => {
    document.documentElement.style.backgroundColor = 'transparent'
  }, [])

  const fetchDir = useCallback(async (dirPath: string) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)
    try {
      const data = await fetchFiles(dirPath, controller.signal)
      setCurrentPath(data.path)
      setEntries(data.entries)
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial navigation: fetch URL param on mount only.
  const initRef = useRef(false)
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    void fetchDir(initPath || '/')
  }, [fetchDir, initPath])

  const navigateTo = useCallback((dirPath: string) => {
    const newHistory = history.slice(0, historyIndex + 1)
    newHistory.push(dirPath)
    setHistory(newHistory)
    setHistoryIndex(newHistory.length - 1)
    fetchDir(dirPath)
  }, [history, historyIndex, fetchDir])

  const goBack = useCallback(() => {
    if (historyIndex <= 0) return
    const prev = historyIndex - 1
    setHistoryIndex(prev)
    fetchDir(history[prev])
  }, [history, historyIndex, fetchDir])

  const goForward = useCallback(() => {
    if (historyIndex >= history.length - 1) return
    const next = historyIndex + 1
    setHistoryIndex(next)
    fetchDir(history[next])
  }, [history, historyIndex, fetchDir])

  const goUp = useCallback(() => {
    const parts = currentPath.split('/').filter(Boolean)
    if (parts.length === 0) return
    parts.pop()
    navigateTo('/' + parts.join('/') || '/')
  }, [currentPath, navigateTo])

  const goHome = useCallback(() => {
    navigateTo('/')
  }, [navigateTo])

  const handleEntryClick = useCallback((entry: FileEntry) => {
    setSelectedEntry(entry)
    if (entry.isDir) {
      const sep = currentPath.endsWith('/') ? '' : '/'
      navigateTo(currentPath + sep + entry.name)
    }
  }, [currentPath, navigateTo])

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry | null) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }, [])

  const openInViewer = useCallback((path: string) => {
    // Post message to parent to open file in viewer tile
    const paneId = window.frameElement?.getAttribute('data-pane')
    window.parent?.postMessage({ type: 'wm-open-file', path, tileType: 'fileviewer', sourcePane: paneId }, '*')
  }, [])

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type })
  }, [])

  const handleSort = useCallback((key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }, [sortKey])

  const handleTreeNavigate = useCallback((path: string) => {
    navigateTo(path)
    setTreeRefreshKey((k) => k + 1)
  }, [navigateTo])

  const copyPath = useCallback(() => {
    void navigator.clipboard.writeText(currentPath)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [currentPath])

  const sorted = [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    let cmp = 0
    switch (sortKey) {
      case 'name':
        cmp = a.name.localeCompare(b.name)
        break
      case 'size':
        cmp = a.size - b.size
        break
      case 'modTime':
        cmp = new Date(a.modTime).getTime() - new Date(b.modTime).getTime()
        break
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  const breadcrumbs = currentPath.split('/').filter(Boolean)

  const SortIndicator = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return null
    return <span className="ml-1 text-[10px]">{sortDir === 'asc' ? '▲' : '▼'}</span>
  }

  return (
    <CommonTileContainer>
      <div
        className="flex h-screen w-screen flex-col overflow-hidden rounded-[6px] text-sm text-white/80"
        style={{ backgroundColor: bgColor }}
      >
        {/* Toolbar */}
        <div className="flex shrink-0 items-center gap-1 border-b border-white/10 bg-black/40 px-2 py-1">
          <button type="button" onClick={goBack} disabled={historyIndex <= 0} className={toolbarBtn} title={t('filebrowser.back')}>
            <BackIcon />
          </button>
          <button type="button" onClick={goForward} disabled={historyIndex >= history.length - 1} className={toolbarBtn} title={t('filebrowser.forward')}>
            <ForwardIcon />
          </button>
          <button type="button" onClick={goUp} disabled={breadcrumbs.length === 0} className={toolbarBtn} title={t('filebrowser.upOneLevel')}>
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <button type="button" onClick={goHome} className={toolbarBtn} title={t('filebrowser.home')}>
            <HomeIcon />
          </button>
          <button type="button" onClick={() => fetchDir(currentPath)} className={toolbarBtn} title={t('filebrowser.refresh')}>
            <RefreshIcon />
          </button>

          {/* Path bar — click to copy */}
          <button
            type="button"
            onClick={copyPath}
            className="ml-2 flex min-w-0 flex-1 items-center gap-1.5 rounded bg-black/30 px-2 py-0.5 text-left text-xs text-white/60 transition hover:bg-black/50 hover:text-white/80"
            title={t('filebrowser.copyPath')}
          >
            <span className="truncate font-mono">{currentPath}</span>
            <span className="shrink-0 text-white/40">
              {copied ? (
                <svg className="h-3 w-3 text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <CopyIcon />
              )}
            </span>
          </button>
        </div>

        {/* Two-panel body */}
        <div className="flex min-h-0 flex-1">
          {/* Left: tree view */}
          <div className="w-52 h-full shrink-0 overflow-y-auto border-r border-white/10 bg-black/20">
            <TreeView key={treeRefreshKey} currentPath={currentPath} onNavigate={handleTreeNavigate} />
          </div>

          {/* Right: file list */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Column headers */}
            <div className="flex shrink-0 items-center border-b border-white/10 bg-black/20 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <button type="button" onClick={() => handleSort('name')} className="flex-1 py-1.5 text-left hover:text-white/60">
                {t('filebrowser.name')}<SortIndicator col="name" />
              </button>
              <button type="button" onClick={() => handleSort('size')} className="w-24 py-1.5 text-right hover:text-white/60">
                {t('filebrowser.size')}<SortIndicator col="size" />
              </button>
              <button type="button" onClick={() => handleSort('modTime')} className="w-32 py-1.5 text-right hover:text-white/60">
                {t('filebrowser.modified')}<SortIndicator col="modTime" />
              </button>
            </div>

            {/* File entries */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading && (
                <div className="flex items-center justify-center py-12 text-xs text-white/30">
                  {t('filebrowser.loading')}
                </div>
              )}
              {error && (
                <div className="flex items-center justify-center py-12 text-xs text-red-400/80">
                  {error}
                </div>
              )}
              {!loading && !error && sorted.length === 0 && (
                <div className="flex items-center justify-center py-12 text-xs text-white/30">
                  {t('filebrowser.emptyFolder')}
                </div>
              )}
              {!loading && !error && sorted.map((entry) => {
                const isSelected = selectedEntry?.name === entry.name
                return (
                  <button
                    key={entry.name}
                    type="button"
                    onClick={() => handleEntryClick(entry)}
                    onContextMenu={(e) => handleContextMenu(e, entry)}
                    className={`flex w-full items-center px-3 py-1.5 text-left transition-colors ${
                      isSelected
                        ? 'bg-sky-500/15 text-white'
                        : entry.isDir
                          ? 'hover:bg-white/5 cursor-pointer text-white/80'
                          : 'cursor-default text-white/80'
                    }`}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {entry.isDir ? <FolderIcon /> : <FileIcon />}
                      <span className="truncate text-[13px]">{entry.name}</span>
                    </div>
                    <div className="w-24 shrink-0 text-right text-[11px] text-white/40">
                      {entry.isDir ? '' : formatSize(entry.size)}
                    </div>
                    <div className="w-32 shrink-0 text-right text-[11px] text-white/40">
                      {formatDate(entry.modTime, t)}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Status bar */}
        <div className="flex shrink-0 items-center justify-between border-t border-white/10 bg-black/40 px-3 py-1 text-[10px] text-white/30">
          <span>{t('filebrowser.itemCount', { count: sorted.length })}</span>
          <button
            type="button"
            onClick={() => setShowUpload(true)}
            className="ml-2 rounded px-2 py-0.5 text-[10px] text-white/50 hover:bg-white/10 hover:text-white"
          >
            {t('filebrowser.contextMenu.upload')}
          </button>
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          entry={contextMenu.entry}
          currentPath={currentPath}
          onClose={() => setContextMenu(null)}
          onRefresh={() => fetchDir(currentPath)}
          onError={(msg) => showToast(msg, 'error')}
          onSuccess={(msg) => showToast(msg, 'success')}
          openInViewer={openInViewer}
          onUpload={() => setShowUpload(true)}
        />
      )}

      {/* Toast */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      {/* Upload Dialog */}
      {showUpload && (
        <UploadDialog
          currentPath={currentPath}
          onClose={() => setShowUpload(false)}
          onUploadComplete={() => fetchDir(currentPath)}
          onError={(msg) => showToast(msg, 'error')}
          onSuccess={(msg) => showToast(msg, 'success')}
        />
      )}
    </CommonTileContainer>
  )
}

const toolbarBtn =
  'grid h-6 w-6 place-items-center rounded text-white/50 transition glass-btn hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30'
