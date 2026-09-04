import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CommonTileContainer, useTileSessionState, useReportTileState } from '../components/CommonTileContainer'
import { formatSize, relativeTime } from '../lib/format'
import { setPageTransparent } from '../lib/constants'
import { CheckIcon, CopyIcon, FileIcon, RefreshIcon, SearchIcon, TrashIcon } from '../components/icons'
import { fetchToken } from '../lib/api'
import { dropboxZoomAtom } from '../store/zoom'
import type { DropboxSessionState } from '../wm/sessionState'

interface DropboxEntry {
  name: string
  path: string
  size: number
  modTime: string
}

interface DropboxListResponse {
  path: string
  entries: DropboxEntry[]
}

interface SpaceInfo {
  used: number
  count: number
}

const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)$/i
const VIDEO_EXTS = /\.(mp4|webm|ogg|mov|avi|mkv)$/i
const TEXT_EXTS = /\.(txt|md|json|yaml|yml|toml|xml|csv|log|sh|bash|zsh|fish|py|js|ts|tsx|jsx|go|rs|c|cpp|h|java|rb|php|css|scss|html|htm|sql|conf|cfg|ini|env|gitignore|dockerignore)$/i

function getFileCategory(name: string): 'image' | 'video' | 'text' | 'other' {
  if (IMAGE_EXTS.test(name)) return 'image'
  if (VIDEO_EXTS.test(name)) return 'video'
  if (TEXT_EXTS.test(name)) return 'text'
  // Check by common text patterns
  if (name.includes('.') === false) return 'text' // extensionless files are often text
  return 'other'
}

function getFileExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : '?'
}



// ── Thumbnail preview component ──

function FileThumbnail({ entry }: { entry: DropboxEntry }) {
  const { t } = useTranslation()
  const category = getFileCategory(entry.name)
  const [textPreview, setTextPreview] = useState<string | null>(null)
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [imgError, setImgError] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoFrame, setVideoFrame] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)

  // Fetch authenticated URL for image/video.
  useEffect(() => {
    if (category !== 'image' && category !== 'video') return
    let cancelled = false
    let objectUrl: string | null = null
    ;(async () => {
      try {
        const token = await fetchToken()
        const res = await fetch(`/api/file?path=${encodeURIComponent(entry.path)}&token=${token}`)
        if (!res.ok || cancelled) return
        const blob = await res.blob()
        objectUrl = URL.createObjectURL(blob)
        if (category === 'image') setImgUrl(objectUrl)
        else setVideoUrl(objectUrl)
      } catch {
        // ignore
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [category, entry.path])

  // Fetch text preview.
  useEffect(() => {
    if (category !== 'text') return
    let cancelled = false
    ;(async () => {
      try {
        const token = await fetchToken()
        const res = await fetch(`/api/file?path=${encodeURIComponent(entry.path)}&token=${token}`)
        if (!res.ok) return
        const text = await res.text()
        if (!cancelled) setTextPreview(text.slice(0, 500))
      } catch {
        // ignore
      }
    })()
    return () => { cancelled = true }
  }, [category, entry.path])

  // Capture video frame at 2s.
  useEffect(() => {
    if (category !== 'video' || !videoUrl) return
    const video = videoRef.current
    if (!video) return
    const onLoaded = () => {
      video.currentTime = 2
    }
    const onSeeked = () => {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(video, 0, 0)
        setVideoFrame(canvas.toDataURL('image/jpeg', 0.6))
      }
    }
    video.addEventListener('loadeddata', onLoaded)
    video.addEventListener('seeked', onSeeked)
    return () => {
      video.removeEventListener('loadeddata', onLoaded)
      video.removeEventListener('seeked', onSeeked)
    }
  }, [category, videoUrl])

  if (category === 'image' && !imgError) {
    return (
      <div className="mt-2 flex justify-center">
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={entry.name}
            className="max-h-40 max-w-full rounded object-contain"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex h-24 items-center justify-center text-white/30">
            {t('dropbox.loadingPreview')}
          </div>
        )}
      </div>
    )
  }

  if (category === 'video') {
    return (
      <div className="mt-2 flex justify-center">
        {videoFrame ? (
          <img src={videoFrame} alt={entry.name} className="max-h-40 max-w-full rounded object-contain" />
        ) : videoUrl ? (
          <>
            <video
              ref={videoRef}
              src={videoUrl}
              className="hidden"
              preload="auto"
              muted
            />
            <div className="flex h-24 items-center justify-center text-white/30">
              {t('dropbox.loadingPreview')}
            </div>
          </>
        ) : (
          <div className="flex h-24 items-center justify-center text-white/30">
            {t('dropbox.loadingPreview')}
          </div>
        )}
      </div>
    )
  }

  if (category === 'text' && textPreview !== null) {
    return (
      <div className="mt-2 max-h-32 overflow-auto scrollbar-thin rounded bg-black/30 p-2">
        <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-white/60">
          {textPreview}
        </pre>
      </div>
    )
  }

  // Other: show file type badge.
  return (
    <div className="mt-2 flex justify-center">
      <div className="flex h-16 w-24 items-center justify-center rounded bg-white/5 font-medium text-white/30">
        {getFileExt(entry.name)}
      </div>
    </div>
  )
}

// ── Main component ──

export default function DropboxPage() {
  const { t } = useTranslation()
  const savedState = useTileSessionState<DropboxSessionState>()
  const reportState = useReportTileState()

  const [entries, setEntries] = useState<DropboxEntry[]>([])
  const [dropboxPath, setDropboxPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState(savedState?.searchQuery ?? '')
  const [spaceInfo, setSpaceInfo] = useState<SpaceInfo>({ used: 0, count: 0 })
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  const [cleanupTarget, setCleanupTarget] = useState('')
  const [expandedFile, setExpandedFile] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Set transparent background.
  useEffect(() => {
    setPageTransparent()
  }, [])

  // Report session state.
  useEffect(() => {
    reportState({ searchQuery })
  }, [searchQuery, reportState])

  const loadFiles = useCallback(async () => {
    try {
      const token = await fetchToken()
      const res = await fetch(`/api/dropbox/list?token=${token}`)
      if (res.ok) {
        const data: DropboxListResponse = await res.json()
        setEntries(data.entries)
        setDropboxPath(data.path)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  const loadSpace = useCallback(async () => {
    try {
      const token = await fetchToken()
      const res = await fetch(`/api/dropbox/space?token=${token}`)
      if (res.ok) {
        setSpaceInfo(await res.json())
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    loadFiles()
    loadSpace()
  }, [loadFiles, loadSpace])

  const uploadFile = useCallback(async (file: File) => {
    const token = await fetchToken()
    const form = new FormData()
    form.append('file', file)
    await fetch(`/api/dropbox/upload?token=${token}`, { method: 'POST', body: form })
  }, [])

  const uploadText = useCallback(async (text: string) => {
    const now = new Date()
    const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `paste_${ts}.txt`
    const blob = new Blob([text], { type: 'text/plain' })
    const file = new File([blob], filename)
    await uploadFile(file)
  }, [uploadFile])

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setUploading(true)
    try {
      for (const file of files) {
        await uploadFile(file)
      }
      await loadFiles()
      await loadSpace()
    } finally {
      setUploading(false)
    }
  }, [uploadFile, loadFiles, loadSpace])

  // Drag and drop.
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget === e.target) {
      setDragOver(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files)
    }
  }, [handleFiles])

  // Clipboard paste — single handler to avoid double-firing.
  const lastPasteRef = useRef<number>(0)
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    e.preventDefault()
    const now = Date.now()
    if (now - lastPasteRef.current < 500) return
    lastPasteRef.current = now

    const items = e.clipboardData.items
    const filesToUpload: File[] = []
    let textContent: string | null = null

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) filesToUpload.push(file)
      } else if (item.kind === 'string' && item.type === 'text/plain') {
        item.getAsString((text) => { textContent = text })
      }
    }

    if (filesToUpload.length > 0) {
      await handleFiles(filesToUpload)
    } else if (textContent !== null) {
      await uploadText(textContent)
      await loadFiles()
      await loadSpace()
    }
  }, [handleFiles, uploadText, loadFiles, loadSpace])

  const handleDelete = useCallback(async (name: string) => {
    const token = await fetchToken()
    await fetch(`/api/dropbox/delete?token=${token}&name=${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
    if (expandedFile === name) setExpandedFile(null)
    await loadFiles()
    await loadSpace()
  }, [loadFiles, loadSpace, expandedFile])

  const handleCopyPath = useCallback(async (path: string) => {
    await navigator.clipboard.writeText(path)
    setCopiedPath(path)
    setTimeout(() => setCopiedPath(null), 1500)
  }, [])

  const handleCleanup = useCallback(async () => {
    const targetBytes = parseInt(cleanupTarget, 10)
    if (isNaN(targetBytes) || targetBytes < 0) return
    const token = await fetchToken()
    await fetch(`/api/dropbox/cleanup?token=${token}&target=${targetBytes}`, {
      method: 'POST',
    })
    setCleanupTarget('')
    await loadFiles()
    await loadSpace()
  }, [cleanupTarget, loadFiles, loadSpace])

  const toggleExpand = useCallback((name: string) => {
    setExpandedFile((prev) => prev === name ? null : name)
  }, [])

  const filtered = entries.filter((e) =>
    searchQuery === '' || e.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <CommonTileContainer zoomAtom={dropboxZoomAtom} noPadding>
      <div
        ref={containerRef}
        className="flex min-h-0 flex-1 flex-col"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPaste={handlePaste}
        tabIndex={0}
      >
        {/* Header — rounded top, bottom border */}
        <div className="flex shrink-0 items-center gap-2 rounded-t-[6px] border-b border-white/[0.08] px-2.5 py-1.5 glass-control">
          <button
            type="button"
            onClick={() => { loadFiles(); loadSpace() }}
            className="grid h-5 w-5 place-items-center rounded text-white/40 transition hover:bg-white/10 hover:text-white"
            title={t('dropbox.refresh')}
          >
            <RefreshIcon className="h-3 w-3" />
          </button>
          <span className="font-semibold">{t('dropbox.title')}</span>
        </div>

        {/* Content — left/right borders + inset shadow */}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin border-x border-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          {loading ? (
            <div className="flex h-full items-center justify-center text-white/40">
              {t('dropbox.loading')}
            </div>
          ) : (
            <>
              {/* Persistent drop target — large area with horizontal margin */}
              <div
                className={`mx-2 mt-2 flex min-h-[30%] flex-col items-center justify-center gap-2 rounded-[6px] border-2 border-dashed transition ${
                  dragOver ? 'border-violet-400 bg-violet-500/10' : 'border-white/10'
                }`}
              >
                <FileIcon className="h-8 w-8 text-white/20" />
                <p className="text-white/40">
                  {dragOver ? t('dropbox.dropHintActive') : t('dropbox.dropHint')}
                </p>
                {uploading && <p className="text-violet-400">{t('dropbox.uploading')}</p>}
              </div>

              {/* Search input — below drop area */}
              <div className="mx-2 mt-2 flex items-center gap-1.5 rounded-md bg-white/[0.04] px-2 py-1.5">
                <SearchIcon className="h-3 w-3 shrink-0 text-white/30" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('dropbox.searchPlaceholder')}
                  className="flex-1 bg-transparent text-white/80 outline-none placeholder:text-white/30"
                />
              </div>

              {/* File list */}
              {filtered.length > 0 && (
                <p className="mx-2 mt-4 mb-1 text-[10px] font-medium uppercase tracking-widest text-white/30">
                  {t('dropbox.currentFiles', { path: dropboxPath })}
                </p>
              )}
              <div className="flex flex-col gap-0.5">
                {filtered.map((entry) => {
                  const isExpanded = expandedFile === entry.name
                  return (
                    <div
                      key={entry.name}
                      className={`group rounded transition ${isExpanded ? 'bg-white/5' : 'hover:bg-white/5'}`}
                    >
                      {/* File row — clickable */}
                      <div
                        className="flex cursor-pointer items-center gap-2 px-2 py-1"
                        onClick={() => toggleExpand(entry.name)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(entry.name) } }}
                        role="button"
                        tabIndex={0}
                      >
                        <FileIcon className="h-3.5 w-3.5 shrink-0 text-white/40" />
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                        <span className="shrink-0 text-[10px] text-white/40">{formatSize(entry.size)}</span>
                        <span className="hidden shrink-0 text-[10px] text-white/30 sm:inline">{relativeTime(entry.modTime, t)}</span>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleCopyPath(entry.path) }}
                          className="grid h-5 w-5 place-items-center rounded text-white/30 opacity-0 transition hover:bg-white/10 hover:text-white group-hover:opacity-100"
                          title={t('dropbox.copyPath')}
                        >
                          {copiedPath === entry.path ? (
                            <CheckIcon className="h-3 w-3 text-green-400" />
                          ) : (
                            <CopyIcon className="h-3 w-3" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleDelete(entry.name) }}
                          className="grid h-5 w-5 place-items-center rounded text-white/30 opacity-0 transition hover:bg-white/10 hover:text-red-400 group-hover:opacity-100"
                          title={t('dropbox.delete')}
                        >
                          <TrashIcon className="h-3 w-3" />
                        </button>
                      </div>

                      {/* Expanded thumbnail preview */}
                      {isExpanded && (
                        <div className="px-2 pb-2">
                          <FileThumbnail entry={entry} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>

        {/* Footer — rounded bottom, top border */}
        <div className="flex shrink-0 items-center gap-2 rounded-b-[6px] border-t border-white/[0.06] px-3 py-1.5 glass-control">
          <span className="text-[10px] text-white/50">
            {t('dropbox.usedSpace', { used: formatSize(spaceInfo.used), count: spaceInfo.count })}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <input
              type="text"
              value={cleanupTarget}
              onChange={(e) => setCleanupTarget(e.target.value)}
              placeholder={t('dropbox.cleanupPlaceholder')}
              className="w-16 bg-transparent text-[10px] text-white/60 outline-none placeholder:text-white/30"
            />
            <button
              type="button"
              onClick={handleCleanup}
              disabled={!cleanupTarget}
              className="glass-btn rounded px-1.5 py-0.5 text-[10px] text-white/50 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
            >
              {t('dropbox.cleanup')}
            </button>
          </div>
        </div>
      </div>
    </CommonTileContainer>
  )
}
