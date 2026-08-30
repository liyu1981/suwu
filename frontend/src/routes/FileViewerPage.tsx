import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileViewer } from '@file-viewer/react'
import standardPreset from '@file-viewer/preset-standard'
import { getCredentials } from '../lib/auth'
import { CommonTileContainer } from '../components/CommonTileContainer'

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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    paneRef.current = params.get('pane')
    const filePath = params.get('path')
    if (!filePath) return

    const controller = new AbortController()
    const headers: Record<string, string> = {}
    const creds = getCredentials()
    if (creds) headers['Authorization'] = creds

    fetch(`/api/file?path=${encodeURIComponent(filePath)}`, {
      cache: 'no-store',
      headers,
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.error || `HTTP ${res.status}`)
        }
        const blob = await res.blob()
        const name = filePath.split('/').pop() || 'file'
        setFilePath(filePath)
        setFileName(name)
        setFileUrl(URL.createObjectURL(blob))
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setError(e instanceof Error ? e.message : 'Failed to load file')
      })

    return () => controller.abort()
  }, [])

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
        const headers: Record<string, string> = {}
        const creds = getCredentials()
        if (creds) headers['Authorization'] = creds

        fetch(`/api/file?path=${encodeURIComponent(d.path)}`, {
          cache: 'no-store',
          headers,
        })
          .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const blob = await res.blob()
            const name = d.path!.split('/').pop() || 'file'
            setFilePath(d.path!)
            setFileName(name)
            setFileUrl(URL.createObjectURL(blob))
            setError(null)
          })
          .catch((e: unknown) => {
            setError(e instanceof Error ? e.message : 'Failed to load file')
          })
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  if (error) {
    return (
      <CommonTileContainer paneId={paneRef.current ?? undefined}>
        <div className="flex h-screen w-screen items-center justify-center bg-transparent">
          <span className="text-sm text-red-400/70">{error}</span>
        </div>
      </CommonTileContainer>
    )
  }

  if (!fileUrl) {
    return (
      <CommonTileContainer paneId={paneRef.current ?? undefined}>
        <div className="flex h-screen w-screen items-center justify-center bg-transparent">
          <span className="text-sm text-white/30">Loading...</span>
        </div>
      </CommonTileContainer>
    )
  }

  if (renderError) {
    return (
      <CommonTileContainer paneId={paneRef.current ?? undefined}>
        <div className="flex h-screen w-screen flex-col bg-transparent">
          {filePath && (
            <div className="flex h-8 shrink-0 items-center border-b border-white/10 bg-black/30 px-3 backdrop-blur-md">
              <span className="truncate text-xs text-white/50" title={filePath}>{filePath}</span>
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
            <svg className="h-10 w-10 text-white/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M15 9l-6 6M9 9l6 6" />
            </svg>
            <p className="max-w-[80%] text-center text-xs text-white/40">{renderError}</p>
            <span className="text-[10px] text-white/25">{fileName}</span>
          </div>
        </div>
      </CommonTileContainer>
    )
  }

  return (
    <CommonTileContainer paneId={paneRef.current ?? undefined}>
      <div className="flex h-screen w-screen flex-col bg-transparent">
        {filePath && (
          <div className="flex h-8 shrink-0 items-center border-b border-white/10 bg-black/30 px-3 backdrop-blur-md">
            <span className="truncate text-xs text-white/50" title={filePath}>{filePath}</span>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <FileViewer
            url={fileUrl}
            filename={fileName ?? undefined}
            options={viewerOptions}
            onStateChange={handleStateChange}
          />
        </div>
      </div>
    </CommonTileContainer>
  )
}
