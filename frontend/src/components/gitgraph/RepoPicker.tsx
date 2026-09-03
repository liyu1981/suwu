/**
 * RepoPicker - small folder picker for choosing a git repository.
 * Reuses the existing /api/files endpoint (same as the file browser).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getCredentials } from '../../lib/auth'

interface DirEntry {
  name: string
  isDir: boolean
}

interface RepoPickerProps {
  /** Called when the user commits to a folder. */
  onSelect: (path: string) => void
  /** Optional error message to surface above the picker (e.g. invalid repo). */
  error?: string | null
}

function fetchDirs(dirPath: string, signal?: AbortSignal): Promise<DirEntry[]> {
  const headers: Record<string, string> = {}
  const creds = getCredentials()
  if (creds) headers['Authorization'] = creds
  return fetch(`/api/files?path=${encodeURIComponent(dirPath)}`, {
    cache: 'no-store',
    headers,
    signal,
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const entries: DirEntry[] = Array.isArray(data?.entries) ? data.entries : []
      // Folders only; sort dirs first, then name.
      return entries
        .filter((e: DirEntry) => e.isDir && e.name !== '.')
        .sort((a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name))
    })
}

function joinPath(dir: string, name: string): string {
  if (dir === '/' || dir === '') return '/' + name
  return dir.replace(/\/+$/, '') + '/' + name
}

function parentPath(dir: string): string {
  if (dir === '/' || dir === '') return '/'
  const trimmed = dir.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx)
}

export function RepoPicker({ onSelect, error }: RepoPickerProps) {
  const [currentPath, setCurrentPath] = useState('/')
  const [dirs, setDirs] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  // Start at the user's home directory.
  useEffect(() => {
    const headers: Record<string, string> = {}
    const creds = getCredentials()
    if (creds) headers['Authorization'] = creds
    fetch('/api/home', { cache: 'no-store', headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.path) {
          setCurrentPath(data.path)
          setManualPath(data.path)
        }
      })
      .catch(() => {})
  }, [])

  // List directories whenever the current path changes.
  useEffect(() => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    setBrowseError(null)
    fetchDirs(currentPath, ctrl.signal)
      .then((entries) => {
        if (ctrl.signal.aborted) return
        setDirs(entries)
        setLoading(false)
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return
        setDirs([])
        setBrowseError(err instanceof Error ? err.message : 'Cannot read folder')
        setLoading(false)
      })
    return () => ctrl.abort()
  }, [currentPath])

  const open = useCallback((name: string) => {
    setCurrentPath(joinPath(currentPath, name))
    setManualPath(joinPath(currentPath, name))
  }, [currentPath])

  const goUp = useCallback(() => {
    setCurrentPath(parentPath(currentPath))
    setManualPath(parentPath(currentPath))
  }, [currentPath])

  const goHome = useCallback(() => {
    setCurrentPath('/')
    setManualPath('/')
  }, [])

  const submitManual = useCallback(() => {
    const p = manualPath.trim()
    if (p === '') return
    setCurrentPath(p)
    onSelect(p)
  }, [manualPath, onSelect])

  return (
    <div className="flex h-full w-full flex-col gap-3">
      {/* Error from the graph (invalid repo, empty repo, ...) */}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575L6.457 1.047zM8 5.5a.75.75 0 0 0-.75.75v3a.75.75 0 1 0 1.5 0v-3A.75.75 0 0 0 8 5.5zm0 6.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>
          </svg>
          <span className="leading-snug">{error}</span>
        </div>
      )}

      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/40">
          Choose a git repository folder
        </div>
        <p className="text-[11px] text-white/50">
          Pick a folder that contains a <code className="rounded bg-white/10 px-1">.git</code>
        </p>
      </div>

      {/* Manual path input */}
      <div className="flex gap-2">
        <input
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitManual() }}
          placeholder="/path/to/repo"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/80 outline-none placeholder:text-white/30 focus:border-white/25 focus:bg-white/10"
        />
        <button
          type="button"
          onClick={submitManual}
          disabled={manualPath.trim() === ''}
          className="glass-btn shrink-0 rounded-md bg-green-500/20 px-3 py-1.5 text-xs font-medium text-green-300 transition hover:bg-green-500/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Open
        </button>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 rounded-md bg-white/5 px-2 py-1.5">
        <button
          type="button"
          onClick={goHome}
          title="Home"
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-slate-300 transition hover:bg-white/10 hover:text-white"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6.5 14.5v-3.505c0-.245.25-.495.5-.495h2c.25 0 .5.25.5.5v3.5a.75.75 0 0 0 1.5 0v-3.665a2.25 2.25 0 0 0-.663-1.59L6.531 4.54A.75.75 0 0 0 6 4.75v9.75a.75.75 0 0 0 .75.75c.138 0 .5-.25.5-.25.2-.1.37-.14.05-.06.218.01.497 0 .7.06.35.1.35.15.5.25z" transform="scale(-1,1) translate(-14.5,0)"/>
          </svg>
        </button>
        <button
          type="button"
          onClick={goUp}
          title="Up"
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-slate-300 transition hover:bg-white/10 hover:text-white"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.78 3.72a.75.75 0 0 1 1.06 0l3.75 3.75a.75.75 0 0 1-1.06 1.06L9 5.56v7.69a.75.75 0 0 1-1.5 0V5.56L5.03 8.53a.75.75 0 0 1-1.06-1.06l3.81-3.75z"/>
          </svg>
        </button>
        <div className="min-w-0 flex-1 truncate pl-1 text-xs text-white/60">{currentPath}</div>
      </div>

      {/* Directory list */}
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-white/10 bg-black/30">
        {loading ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          </div>
        ) : browseError ? (
          <div className="p-4 text-xs text-red-300">
            {browseError}
            <button type="button" onClick={goUp} className="ml-2 text-white/60 underline hover:text-white">
              Go up
            </button>
          </div>
        ) : dirs.length === 0 ? (
          <div className="p-4 text-xs text-white/40">No subfolders here.</div>
        ) : (
          <div className="divide-y divide-white/5">
            {dirs.map((d) => (
              <button
                key={d.name}
                type="button"
                onDoubleClick={() => onSelect(joinPath(currentPath, d.name))}
                onClick={() => setManualPath(joinPath(currentPath, d.name))}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
              >
                <svg className="h-3.5 w-3.5 shrink-0 text-yellow-400/80" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/>
                </svg>
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                <ChevronRightIcon />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Open current folder */}
      <button
        type="button"
        disabled={loading || !!browseError}
        onClick={() => onSelect(currentPath)}
        className="glass-btn w-full rounded-lg bg-green-500/20 py-2 text-sm font-medium text-green-300 transition hover:bg-green-500/30 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Use this folder
      </button>
    </div>
  )
}

function ChevronRightIcon() {
  return (
    <svg className="h-3 w-3 shrink-0 text-white/30" viewBox="0 0 16 16" fill="currentColor">
      <path d="M6.22 3.72a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z"/>
    </svg>
  )
}

export default RepoPicker