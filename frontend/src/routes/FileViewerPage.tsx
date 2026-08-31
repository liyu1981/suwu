import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileViewer } from '@file-viewer/react'
import standardPreset from '@file-viewer/preset-standard'
import { getCredentials } from '../lib/auth'
import { CommonTileContainer } from '../components/CommonTileContainer'
import { RefreshIcon } from '../components/icons'

const intervals = [
  { label: 'Off', value: 0 },
  { label: '5s', value: 5000 },
  { label: '10s', value: 10000 },
  { label: '30s', value: 30000 },
  { label: '60s', value: 60000 },
]

/**
 * Full-space file viewer page loaded inside each file viewer pane's iframe.
 * Renders the file at the path passed via ?path= URL param using
 * @file-viewer/react with office preset and 3D renderer for minimal bundle.
 *
 * Files are fetched with the stored Basic auth credentials and passed as a
 * Blob URL to the viewer component, since it cannot send custom headers.
 */
export default function FileViewerPage() {
  const paneRef = useRef<string | null>(null)
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(0)
  const [showDropdown, setShowDropdown] = useState(false)
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 })
  const dropdownRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const viewerOptions = useMemo(() => ({
    preset: standardPreset,
    rendererMode: 'replace' as const,
    theme: 'dark' as const,
    toolbar: { position: 'bottom-right' as const },
  }), [])

  const handleStateChange = useCallback((state: { error: unknown | null }) => {
    if (state.error) {
      setRenderError(state.error instanceof Error ? state.error.message : String(state.error))
    }
  }, [])

  // Fetch file content
  const fetchFile = useCallback(async (path: string) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const headers: Record<string, string> = {}
    const creds = getCredentials()
    if (creds) headers['Authorization'] = creds

    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`, {
        cache: 'no-store',
        headers,
        signal: controller.signal,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const name = path.split('/').pop() || 'file'
      setFilePath(path)
      setFileName(name)
      setFileUrl(URL.createObjectURL(blob))
      setError(null)
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(e instanceof Error ? e.message : 'Failed to load file')
    }
  }, [])

  // Initial load from URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    paneRef.current = params.get('pane')
    const path = params.get('path')
    if (!path) return

    fetchFile(path)
    return () => abortRef.current?.abort()
  }, [fetchFile])

  // Make background transparent so the tiling WM background shows through.
  useEffect(() => {
    document.documentElement.style.backgroundColor = 'transparent'
  }, [])

  // Catch unhandled promise rejections from renderers (e.g. image decode failures).
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? 'Render failed')
      setRenderError(msg)
      e.preventDefault()
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
  }, [])

  // Listen for path updates from the parent (when tile is reused with a new file).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; path?: string } | undefined
      if (d?.type === 'tile-path-update' && typeof d.path === 'string') {
        fetchFile(d.path)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [fetchFile])

  // Auto-refresh timer
  useEffect(() => {
    if (autoRefresh <= 0 || !filePath) return
    const timer = setInterval(() => {
      fetchFile(filePath)
    }, autoRefresh)
    return () => clearInterval(timer)
  }, [autoRefresh, filePath, fetchFile])

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return
    const onClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [showDropdown])

  const handleRefresh = useCallback(() => {
    if (filePath) fetchFile(filePath)
  }, [filePath, fetchFile])

  const handleIntervalSelect = useCallback((ms: number) => {
    setAutoRefresh(ms)
    setShowDropdown(false)
  }, [])

  // Dropdown rendered via portal-like fixed positioning
  const dropdown = showDropdown ? (
    <div
      ref={dropdownRef}
      className="fixed z-[9999] w-28 rounded border border-white/10 bg-black/95 py-1 shadow-xl backdrop-blur-xl"
      style={{ top: dropdownPos.top, left: dropdownPos.left }}
    >
      {intervals.map((iv) => (
        <button
          key={iv.value}
          type="button"
          onClick={() => handleIntervalSelect(iv.value)}
          className={`flex w-full items-center px-3 py-1 text-left text-xs transition hover:bg-white/10 ${
            autoRefresh === iv.value ? 'text-green-400' : 'text-white/60'
          }`}
        >
          {iv.label}
          {autoRefresh === iv.value && iv.value > 0 && (
            <span className="ml-auto text-[10px] text-green-400/60">●</span>
          )}
        </button>
      ))}
    </div>
  ) : null

  if (error) {
    return (
      <CommonTileContainer paneId={paneRef.current ?? undefined}>
        <div className="flex h-screen w-screen items-center justify-center bg-transparent">
          <span className="text-sm text-red-400/70">{error}</span>
        </div>
        {dropdown}
      </CommonTileContainer>
    )
  }

  if (!fileUrl) {
    return (
      <CommonTileContainer paneId={paneRef.current ?? undefined}>
        <div className="flex h-screen w-screen items-center justify-center bg-transparent">
          <span className="text-sm text-white/30">Loading...</span>
        </div>
        {dropdown}
      </CommonTileContainer>
    )
  }

  const header = filePath ? (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-white/10 bg-black/30 px-3 backdrop-blur-md">
      {/* Refresh button */}
      <button
        type="button"
        onClick={handleRefresh}
        className={`grid h-5 w-5 place-items-center rounded transition hover:bg-white/10 ${
          autoRefresh > 0 ? 'text-green-400' : 'text-white/50 hover:text-white/70'
        }`}
        title="Refresh"
      >
        <RefreshIcon />
      </button>
      {/* Auto-refresh dropdown trigger */}
      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          if (showDropdown) {
            setShowDropdown(false)
          } else if (btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect()
            setDropdownPos({ top: rect.bottom + 2, left: rect.left })
            setShowDropdown(true)
          }
        }}
        className={`grid h-5 w-4 place-items-center rounded text-[10px] transition hover:bg-white/10 ${
          autoRefresh > 0 ? 'text-green-400' : 'text-white/40 hover:text-white/60'
        }`}
        title="Auto-refresh interval"
      >
        ▾
      </button>
      <span className="truncate text-xs text-white/50" title={filePath}>{filePath}</span>
    </div>
  ) : null

  if (renderError) {
    return (
      <CommonTileContainer paneId={paneRef.current ?? undefined}>
        <div className="flex h-screen w-screen flex-col bg-transparent">
          {header}
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
            <svg className="h-10 w-10 text-white/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M15 9l-6 6M9 9l6 6" />
            </svg>
            <p className="max-w-[80%] text-center text-xs text-white/40">{renderError}</p>
            <span className="text-[10px] text-white/25">{fileName}</span>
          </div>
        </div>
        {dropdown}
      </CommonTileContainer>
    )
  }

  return (
    <CommonTileContainer paneId={paneRef.current ?? undefined}>
      <div className="flex h-screen w-screen flex-col bg-transparent">
        {header}
        <div className="min-h-0 flex-1">
          <FileViewer
            url={fileUrl}
            filename={fileName ?? undefined}
            options={viewerOptions}
            onStateChange={handleStateChange}
          />
        </div>
      </div>
      {dropdown}
    </CommonTileContainer>
  )
}
